/**
 * Toolbox — Voice Recorder (in-app audio capture + storage).
 *
 * Built to the same standard as the covert camera: clips and chunks live in IndexedDB,
 * chunks are flushed to disk while recording (RAM stays flat over long sessions), the clip
 * is assembled from the on-disk chunk store on stop, and an interrupted recording is rescued
 * on next load. Resource fail-safes auto-stop on low battery / low storage. A wake lock keeps
 * the screen alive. Audio is clarity-tuned (echo cancellation + noise suppression + auto gain)
 * and a stealth black screen hides the display while recording.
 */
(function () {
  const DB_NAME = 'toolbox-recorder';
  const DB_VERSION = 1;
  const STORE = 'clips';
  const CHUNK_STORE = 'chunks';
  const PREFS_KEY = 'toolboxRecorderPrefs';
  const INDEX_KEY = 'toolboxRecorderClipIndex';
  const CONSENT_KEY = 'toolboxRecorderConsent';
  // Resource fail-safe thresholds (mirror the covert camera).
  const LOW_BATTERY = 0.20;
  const CRITICAL_BATTERY = 0.05;
  const LOW_STORAGE_BYTES = 200 * 1024 * 1024;
  const CRITICAL_STORAGE_BYTES = 80 * 1024 * 1024;
  const STORAGE_WATCH_MS = 8000;
  const CHUNK_INTERVAL_MS = 3000;
  const TAP_REQUIRED = 3;
  const TAP_RESET_MS = 700;
  // Ignore a "stop" that lands right after a "start" — that's almost always a duplicated tap.
  const MIN_RECORD_MS = 1200;
  const SWIPE_UP_RESET_MS = 1200;
  const SWIPE_THRESHOLD = 48;
  const HUD_RECORDING_MS = 5000;
  // Warn once per session that a long stealth recording uses battery / generates heat.
  const STEALTH_WARN_MINUTES = 45;

  const defaultPrefs = {
    wakeLock: true,
    maxClipMinutes: 0,
    strongHapticOnRecord: true,
    voiceClarity: true,
    audioQuality: 'standard',
    stealthByDefault: false,
  };

  // Bitrates tuned for fidelity. 'high' is near-lossless voice/ambient, 'standard' is clearly
  // intelligible, 'small' saves space. Higher than before to fix muffled/thin captures.
  const QUALITY_BITRATE = { high: 256000, standard: 160000, small: 96000 };
  const TARGET_SAMPLE_RATE = 48000;

  let mediaStream = null;
  let mediaRecorder = null;
  // In-memory only until the matching disk write confirms, then released — keeps RAM flat.
  let pendingChunks = new Map();
  let isRecording = false;
  let isPaused = false;
  let tapCount = 0;
  let tapResetTimer = null;
  let wakeLockSentinel = null;
  let maxClipTimer = null;
  let dbPromise = null;
  let allowInFlight = false;
  let sessionActive = false;
  let stealthOn = false;
  let userClosedSession = false;
  let swipeStartY = null;
  let swipeUpCount = 0;
  let swipeUpResetTimer = null;
  let hudTimer = null;
  let recordingStartedAt = 0;
  let pausedTotalMs = 0;
  let pauseStartedAt = 0;
  let pendingClipDurationSeconds = 0;
  let elapsedTimer = null;
  let recordingGeo = null;
  let stealthWarned = false;
  // Crash-safe recording + resource fail-safes.
  let currentRecordingId = null;
  let currentChunkSeq = 0;
  let autoStopReason = '';
  let batteryRef = null;
  let storageWatchTimer = null;
  let batteryWatchHandler = null;
  // Live input level meter.
  let audioCtx = null;
  let analyser = null;
  let analyserData = null;
  let levelRaf = null;
  let lastRecordingMimeType = '';
  const clipPreviewUrls = new Map();
  let clipViewerUrl = null;

  function $(id) {
    return document.getElementById(id);
  }

  function haptic(style) {
    const toolboxStyle = style === 'tap' ? 'medium' : style;
    if (typeof window.toolboxHaptic === 'function') {
      window.toolboxHaptic(toolboxStyle);
      return;
    }
    if (typeof navigator.vibrate !== 'function') return;
    const patterns = { light: 22, medium: [24, 58, 24], success: [18, 72, 18], tap: [16, 36, 16] };
    try { navigator.vibrate(patterns[style] || patterns.tap); } catch {}
  }

  /* ---------------- prefs ---------------- */

  function getPrefs() {
    try {
      const raw = localStorage.getItem(PREFS_KEY);
      if (!raw) return { ...defaultPrefs };
      return { ...defaultPrefs, ...JSON.parse(raw) };
    } catch {
      return { ...defaultPrefs };
    }
  }

  function savePrefs(prefs) {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch {}
  }

  function hasConsent() {
    try { return localStorage.getItem(CONSENT_KEY) === '1'; } catch { return false; }
  }

  function setConsent() {
    try { localStorage.setItem(CONSENT_KEY, '1'); } catch {}
  }

  function nextClipId() {
    let n = 0;
    try {
      n = parseInt(localStorage.getItem(INDEX_KEY) || '0', 10);
      if (!Number.isFinite(n) || n < 0) n = 0;
    } catch {}
    const id = String(n).padStart(5, '0');
    try { localStorage.setItem(INDEX_KEY, String(n + 1)); } catch {}
    return id;
  }

  /* ---------------- IndexedDB ---------------- */

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(CHUNK_STORE)) {
          const cs = db.createObjectStore(CHUNK_STORE, { autoIncrement: true });
          cs.createIndex('clipId', 'clipId', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => {
        dbPromise = null;
        reject(req.error);
      };
    });
    return dbPromise;
  }

  async function putClipRecord(record) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function getClipRecord(id) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async function getAllClipRecordsRaw() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async function appendChunk(clipId, seq, blob) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(CHUNK_STORE, 'readwrite');
      tx.objectStore(CHUNK_STORE).add({ clipId, seq, data: blob });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function getChunkBlobs(clipId) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(CHUNK_STORE, 'readonly');
      const idx = tx.objectStore(CHUNK_STORE).index('clipId');
      const req = idx.getAll(IDBKeyRange.only(clipId));
      req.onsuccess = () => {
        const rows = (req.result || []).slice().sort((a, b) => (a.seq || 0) - (b.seq || 0));
        resolve(rows.map((r) => r.data).filter(Boolean));
      };
      req.onerror = () => reject(req.error);
    });
  }

  async function deleteChunks(clipId) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(CHUNK_STORE, 'readwrite');
      const store = tx.objectStore(CHUNK_STORE);
      const idx = store.index('clipId');
      const req = idx.openCursor(IDBKeyRange.only(clipId));
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function clearChunkStore() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(CHUNK_STORE, 'readwrite');
      tx.objectStore(CHUNK_STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /** Build the final clip blob from the on-disk chunk store plus any chunk still in RAM. */
  async function assembleClipBlob(clipId, mimeType) {
    const diskBlobs = await getChunkBlobs(clipId).catch(() => []);
    const pending = [...pendingChunks.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, blob]) => blob)
      .filter(Boolean);
    const parts = diskBlobs.concat(pending);
    if (!parts.length) return null;
    return new Blob(parts, { type: mimeType || 'audio/webm' });
  }

  async function finalizeClip(id, blob, mimeType, meta) {
    const record = {
      id,
      blob,
      size: blob.size,
      mimeType: mimeType || blob.type || 'audio/webm',
      durationSeconds: meta?.durationSeconds || 0,
      createdAt: meta?.recordedAt || Date.now(),
      latitude: Number.isFinite(meta?.latitude) ? meta.latitude : undefined,
      longitude: Number.isFinite(meta?.longitude) ? meta.longitude : undefined,
      locationLabel: meta?.locationLabel || '',
      status: 'done',
    };
    await putClipRecord(record);
    return record;
  }

  /** Rescue any clip left in a 'recording' state by reassembling its on-disk chunks. */
  async function rescueClipStorage() {
    let rescued = 0;
    let records = [];
    try { records = await getAllClipRecordsRaw(); } catch { return { rescued: 0 }; }
    for (const r of records) {
      if (!r || r.status !== 'recording') continue;
      try {
        const blobs = await getChunkBlobs(r.id);
        const blob = blobs.length ? new Blob(blobs, { type: r.mimeType || 'audio/webm' }) : null;
        if (blob && blob.size >= 600) {
          await finalizeClip(r.id, blob, r.mimeType, {
            recordedAt: r.createdAt || Date.now(),
            durationSeconds: r.durationSeconds || 0,
            latitude: r.latitude,
            longitude: r.longitude,
            locationLabel: r.locationLabel || '',
          });
          await deleteChunks(r.id).catch(() => {});
          rescued += 1;
        } else {
          await deleteClips([r.id]);
          await deleteChunks(r.id).catch(() => {});
        }
      } catch {}
    }
    return { rescued };
  }

  async function getAllClips() {
    await rescueClipStorage().catch(() => {});
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => {
        const list = (req.result || [])
          .filter((c) => c && c.blob && c.blob.size >= 600 && c.status !== 'recording')
          .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        resolve(list);
      };
      req.onerror = () => reject(req.error);
    });
  }

  async function clearAllClips() {
    const db = await openDb();
    await clearChunkStore().catch(() => {});
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function deleteClips(ids) {
    if (!ids.length) return;
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      ids.forEach((id) => store.delete(id));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function getStorageSummary() {
    const clips = await getAllClips();
    const bytes = clips.reduce((sum, c) => sum + (c.size || 0), 0);
    return { count: clips.length, bytes };
  }

  /* ---------------- formatting ---------------- */

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function formatBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }

  function formatDuration(seconds) {
    const s = Math.max(0, Math.round(seconds || 0));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${pad2(r)}`;
  }

  function formatClock(seconds) {
    const s = Math.max(0, Math.floor(seconds || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    if (h > 0) return `${h}:${pad2(m)}:${pad2(r)}`;
    return `${pad2(m)}:${pad2(r)}`;
  }

  function formatClipDate(timestamp) {
    const d = new Date(timestamp || Date.now());
    return d.toLocaleString(undefined, {
      month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
    });
  }

  function formatClipTime(timestamp) {
    const d = new Date(timestamp || Date.now());
    return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }

  function formatDayHeading(timestamp) {
    const d = new Date(timestamp || Date.now());
    return d.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  }

  function getDayKey(timestamp) {
    const d = new Date(timestamp || Date.now());
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  /* ---------------- geo + sidecar ---------------- */

  async function resolveClipAddress(lat, lng) {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return '';
    if (typeof window.toolboxReverseGeocode === 'function') {
      try {
        const label = await window.toolboxReverseGeocode(lat, lng);
        if (label) return String(label).trim();
      } catch {}
    }
    return '';
  }

  function captureRecordingGeo() {
    if (!navigator.geolocation) return Promise.resolve(null);
    return new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(
        async (pos) => {
          const lat = pos.coords.latitude;
          const lng = pos.coords.longitude;
          const locationLabel = await resolveClipAddress(lat, lng);
          resolve({ lat, lng, locationLabel });
        },
        () => resolve(null),
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 }
      );
    });
  }

  function buildClipBaseName(clip) {
    const d = new Date(clip.createdAt || Date.now());
    const stamp =
      `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` +
      `_${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
    let geo = '';
    if (Number.isFinite(clip.latitude) && Number.isFinite(clip.longitude)) {
      geo = `_${clip.latitude.toFixed(5)}_${clip.longitude.toFixed(5)}`;
    }
    return `voice_${stamp}${geo}`;
  }

  function clipExtension(mime) {
    const m = String(mime || '').toLowerCase();
    if (m.includes('mp4') || m.includes('aac') || m.includes('m4a')) return '.m4a';
    if (m.includes('ogg')) return '.ogg';
    return '.webm';
  }

  function buildClipSidecar(clip, audioFileName) {
    const d = new Date(clip.createdAt || Date.now());
    const lines = [
      'Investigator Toolbox — Voice Recording',
      `File: ${audioFileName}`,
      `Recorded (local): ${d.toLocaleString()}`,
      `Recorded (ISO 8601): ${d.toISOString()}`,
      `Duration (seconds): ${clip.durationSeconds || 0}`,
    ];
    if (Number.isFinite(clip.latitude) && Number.isFinite(clip.longitude)) {
      lines.push(`Latitude: ${clip.latitude}`);
      lines.push(`Longitude: ${clip.longitude}`);
      lines.push(`Map: https://maps.google.com/?q=${clip.latitude},${clip.longitude}`);
    } else {
      lines.push('Location: not available (device location was off or unavailable)');
    }
    if (clip.locationLabel) lines.push(`Location: ${clip.locationLabel}`);
    return `${lines.join('\n')}\n`;
  }

  async function downloadClips(clipIds) {
    let clips = await getAllClips();
    if (clipIds?.length) {
      const set = new Set(clipIds);
      clips = clips.filter((c) => set.has(c.id));
    }
    if (!clips.length) return;
    haptic('light');
    const files = [];
    clips.forEach((c) => {
      const base = buildClipBaseName(c);
      const audioName = `${base}${clipExtension(c.mimeType)}`;
      files.push(new File([c.blob], audioName, { type: c.blob.type || 'audio/webm' }));
      files.push(new File([buildClipSidecar(c, audioName)], `${base}.txt`, { type: 'text/plain' }));
    });
    if (navigator.share && navigator.canShare?.({ files })) {
      try {
        await navigator.share({
          files,
          title: 'Toolbox recordings',
          text: 'Save to Files on your device, or pick an app to send them to.',
        });
        return;
      } catch (err) {
        if (err?.name === 'AbortError') return;
      }
    }
    files.forEach((file) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(file);
      a.download = file.name;
      a.click();
      URL.revokeObjectURL(a.href);
    });
  }

  /* ---------------- format / mime ---------------- */

  function getRecordingMimeCandidates() {
    return [
      'audio/mp4;codecs=mp4a.40.2',
      'audio/mp4',
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
    ];
  }

  function probePreferredMimeType() {
    if (typeof MediaRecorder === 'undefined') return '';
    return getRecordingMimeCandidates().find((t) => MediaRecorder.isTypeSupported(t)) || '';
  }

  function describeRecordingFormat(mime) {
    if (!mime) return 'Format: not supported — update Chrome or reinstall Toolbox.';
    const lower = String(mime).toLowerCase();
    if (lower.includes('mp4') || lower.includes('aac') || lower.includes('m4a')) return 'Format: M4A (AAC) audio.';
    if (lower.includes('opus')) return 'Format: WebM/Opus audio.';
    if (lower.includes('ogg')) return 'Format: OGG/Opus audio.';
    const base = mime.split(';')[0] || mime;
    return `Format: ${base}.`;
  }

  function refreshRecordingFormatUi() {
    const mime = lastRecordingMimeType || probePreferredMimeType();
    const text = describeRecordingFormat(mime);
    document.querySelectorAll('[data-rec-recording-format]').forEach((el) => {
      el.textContent = text;
    });
  }

  function createMediaRecorder(stream, audioBitsPerSecond) {
    if (typeof MediaRecorder === 'undefined') return null;
    for (const mimeType of getRecordingMimeCandidates()) {
      if (!MediaRecorder.isTypeSupported(mimeType)) continue;
      try {
        const rec = new MediaRecorder(stream, { mimeType, audioBitsPerSecond });
        lastRecordingMimeType = rec.mimeType || mimeType;
        refreshRecordingFormatUi();
        return rec;
      } catch {
        try {
          const rec = new MediaRecorder(stream, { mimeType });
          lastRecordingMimeType = rec.mimeType || mimeType;
          refreshRecordingFormatUi();
          return rec;
        } catch {}
      }
    }
    try {
      const rec = new MediaRecorder(stream, { audioBitsPerSecond });
      lastRecordingMimeType = rec.mimeType || '';
      refreshRecordingFormatUi();
      return rec;
    } catch {
      try {
        const rec = new MediaRecorder(stream);
        lastRecordingMimeType = rec.mimeType || '';
        refreshRecordingFormatUi();
        return rec;
      } catch {
        return null;
      }
    }
  }

  /* ---------------- resource fail-safes ---------------- */

  async function getFreeStorageBytes() {
    if (!navigator.storage?.estimate) return null;
    try {
      const est = await navigator.storage.estimate();
      if (est && Number.isFinite(est.quota) && Number.isFinite(est.usage)) {
        return Math.max(0, est.quota - est.usage);
      }
    } catch {}
    return null;
  }

  async function requestPersistentStorage() {
    if (!navigator.storage?.persist || !navigator.storage?.persisted) return;
    try {
      if (await navigator.storage.persisted()) return;
      await navigator.storage.persist();
    } catch {}
  }

  async function initBattery() {
    if (batteryRef || typeof navigator.getBattery !== 'function') return;
    try {
      batteryRef = await navigator.getBattery();
    } catch {
      batteryRef = null;
    }
  }

  function batteryLevelOk() {
    if (!batteryRef || batteryRef.charging) return true;
    return batteryRef.level > CRITICAL_BATTERY;
  }

  function startResourceWatch() {
    stopResourceWatch();
    if (batteryRef && !batteryWatchHandler) {
      batteryWatchHandler = () => {
        if (!isRecording) return;
        if (!batteryRef.charging && batteryRef.level <= CRITICAL_BATTERY) {
          autoStopReason = 'Battery critically low — recording saved.';
          stopRecording();
        }
      };
      try { batteryRef.addEventListener('levelchange', batteryWatchHandler); } catch {}
    }
    storageWatchTimer = setInterval(async () => {
      if (!isRecording) return;
      const free = await getFreeStorageBytes();
      if (free != null && free <= CRITICAL_STORAGE_BYTES) {
        autoStopReason = 'Storage almost full — recording saved.';
        stopRecording();
      }
    }, STORAGE_WATCH_MS);
  }

  function stopResourceWatch() {
    if (storageWatchTimer) {
      clearInterval(storageWatchTimer);
      storageWatchTimer = null;
    }
    if (batteryRef && batteryWatchHandler) {
      try { batteryRef.removeEventListener('levelchange', batteryWatchHandler); } catch {}
      batteryWatchHandler = null;
    }
  }

  /* ---------------- wake lock ---------------- */

  async function acquireWakeLock() {
    if (!getPrefs().wakeLock) return;
    if (!('wakeLock' in navigator)) return;
    try {
      wakeLockSentinel = await navigator.wakeLock.request('screen');
      wakeLockSentinel.addEventListener?.('release', () => { wakeLockSentinel = null; });
    } catch {
      wakeLockSentinel = null;
    }
  }

  function releaseWakeLock() {
    if (wakeLockSentinel) {
      try { wakeLockSentinel.release(); } catch {}
      wakeLockSentinel = null;
    }
  }

  /* ---------------- level meter ---------------- */

  // Animated frequency-bar visualizer ("CEO-mode" style) drawn on a canvas. Bars rise from a
  // centre line and mirror, with a smooth decay so it looks fluid rather than jumpy.
  let waveSmooth = null;

  function startLevelMeter(stream) {
    stopLevelMeter();
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const canvas = $('voiceWave');
    try {
      audioCtx = new Ctx();
      if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
      const source = audioCtx.createMediaStreamSource(stream);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.75;
      analyserData = new Uint8Array(analyser.frequencyBinCount);
      source.connect(analyser);
      const BARS = 40;
      waveSmooth = new Array(BARS).fill(0);
      const ctx = canvas ? canvas.getContext('2d') : null;
      const loop = () => {
        if (!analyser) return;
        analyser.getByteFrequencyData(analyserData);
        if (ctx && canvas) drawWave(ctx, canvas, BARS);
        levelRaf = requestAnimationFrame(loop);
      };
      loop();
    } catch {
      stopLevelMeter();
    }
  }

  function drawWave(ctx, canvas, bars) {
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth || 300;
    const cssH = canvas.clientHeight || 88;
    if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
    }
    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    const mid = H / 2;
    const gap = Math.max(2 * dpr, W * 0.004);
    const barW = (W - gap * (bars - 1)) / bars;
    const binStep = Math.max(1, Math.floor(analyserData.length / bars));
    for (let i = 0; i < bars; i++) {
      let sum = 0;
      for (let j = 0; j < binStep; j++) sum += analyserData[i * binStep + j] || 0;
      const avg = sum / binStep / 255;
      const target = isPaused ? 0.02 : avg;
      // Smooth toward the target so bars glide.
      waveSmooth[i] += (target - waveSmooth[i]) * 0.35;
      const amp = Math.max(0.03, waveSmooth[i]);
      const h = amp * (H * 0.92);
      const x = i * (barW + gap);
      const r = Math.min(barW / 2, 4 * dpr);
      const grad = ctx.createLinearGradient(0, mid - h / 2, 0, mid + h / 2);
      grad.addColorStop(0, '#f87171');
      grad.addColorStop(0.5, '#dc2626');
      grad.addColorStop(1, '#f87171');
      ctx.fillStyle = grad;
      roundRect(ctx, x, mid - h / 2, barW, h, r);
      ctx.fill();
    }
  }

  function roundRect(ctx, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  function stopLevelMeter() {
    if (levelRaf != null) {
      cancelAnimationFrame(levelRaf);
      levelRaf = null;
    }
    analyser = null;
    analyserData = null;
    waveSmooth = null;
    if (audioCtx) {
      try { audioCtx.close(); } catch {}
      audioCtx = null;
    }
    const canvas = $('voiceWave');
    if (canvas) {
      const ctx = canvas.getContext('2d');
      if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  }

  /* ---------------- HUD + state ---------------- */

  function clearHud() {
    clearTimeout(hudTimer);
    hudTimer = null;
    const el = $('voiceStatus');
    if (el) el.textContent = '';
  }

  function showBriefHud(text, autoHideMs) {
    const el = $('voiceStatus');
    if (!el) return;
    clearTimeout(hudTimer);
    hudTimer = null;
    el.textContent = text;
    if (autoHideMs > 0) hudTimer = setTimeout(clearHud, autoHideMs);
  }

  function setStateLabel() {
    const el = $('voiceStateLabel');
    if (el) el.textContent = !isRecording ? 'Ready' : isPaused ? 'Paused' : 'Recording';
    const recBtn = $('voiceRecordBtn');
    if (recBtn) {
      recBtn.textContent = isRecording ? 'Stop' : 'Record';
      recBtn.classList.toggle('voice-rec__record-btn--active', isRecording);
    }
    const pauseBtn = $('voicePauseBtn');
    if (pauseBtn) {
      pauseBtn.textContent = isPaused ? 'Resume' : 'Pause';
      pauseBtn.disabled = !isRecording;
    }
    const dot = $('voiceRecDot');
    if (dot) dot.classList.toggle('voice-rec__dot--live', isRecording && !isPaused);
  }

  function elapsedSeconds() {
    if (!recordingStartedAt) return 0;
    const now = Date.now();
    const paused = pausedTotalMs + (isPaused && pauseStartedAt ? now - pauseStartedAt : 0);
    return Math.max(0, (now - recordingStartedAt - paused) / 1000);
  }

  function tickElapsed() {
    const el = $('voiceTimer');
    if (el) el.textContent = formatClock(elapsedSeconds());
    if (!stealthWarned && !isPaused && elapsedSeconds() >= STEALTH_WARN_MINUTES * 60 && stealthOn) {
      stealthWarned = true;
      showBriefHud('Long covert recording — watch battery/heat', 6000);
    }
  }

  function startElapsedTimer() {
    stopElapsedTimer();
    tickElapsed();
    elapsedTimer = setInterval(tickElapsed, 500);
  }

  function stopElapsedTimer() {
    if (elapsedTimer) {
      clearInterval(elapsedTimer);
      elapsedTimer = null;
    }
  }

  /* ---------------- mic permission + stream ---------------- */

  function getAudioConstraints() {
    const clarity = getPrefs().voiceClarity !== false;
    // With clarity OFF we capture raw, full-band audio (best for distant/ambient sound and
    // music). With it ON we enable the speech DSP (noise suppression etc.) for close voice.
    return {
      audio: {
        echoCancellation: clarity,
        noiseSuppression: clarity,
        autoGainControl: clarity,
        channelCount: 1,
        sampleRate: TARGET_SAMPLE_RATE,
        sampleSize: 16,
      },
      video: false,
    };
  }

  function setPermissionError(text) {
    const el = $('voicePermissionError');
    if (el) el.textContent = text || '';
  }

  function describeMicError(err) {
    const name = err?.name || '';
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
      return 'Microphone is blocked for Toolbox. Android: Settings → Apps → Toolbox (or Chrome) → Permissions → Microphone → Allow. Chrome: ⋮ → Settings → Site settings → Microphone → Allow.';
    }
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return 'No microphone found on this device.';
    if (name === 'NotReadableError' || name === 'TrackStartError') return 'Microphone is in use by another app. Close it and tap Allow again.';
    if (name === 'SecurityError') return 'Microphone blocked — open Toolbox from the home-screen app icon (HTTPS required).';
    const msg = err?.message ? String(err.message).trim() : '';
    return msg ? `Microphone error: ${msg}` : 'Microphone unavailable — tap Allow to try again.';
  }

  function showPermissionGate(show) {
    const gate = $('voicePermissionGate');
    if (gate) {
      gate.classList.toggle('hidden', !show);
      gate.setAttribute('aria-hidden', show ? 'false' : 'true');
    }
  }

  async function ensureMicStream() {
    if (mediaStream && mediaStream.getAudioTracks().some((t) => t.readyState === 'live')) return mediaStream;
    stopMicStream();
    const stream = await navigator.mediaDevices.getUserMedia(getAudioConstraints());
    mediaStream = stream;
    return stream;
  }

  function stopMicStream() {
    if (mediaStream) {
      mediaStream.getTracks().forEach((t) => { try { t.stop(); } catch {} });
      mediaStream = null;
    }
  }

  async function requestMicAccess() {
    if (allowInFlight) return;
    allowInFlight = true;
    setPermissionError('');
    try {
      await ensureMicStream();
      showPermissionGate(false);
      void initBattery();
      // Live visualizer reacts as soon as the mic is open, even before pressing Record.
      if (mediaStream) startLevelMeter(mediaStream);
    } catch (err) {
      setPermissionError(describeMicError(err));
      showPermissionGate(true);
    } finally {
      allowInFlight = false;
    }
  }

  /* ---------------- recording ---------------- */

  async function startRecording() {
    if (isRecording) return;
    let stream;
    try {
      stream = await ensureMicStream();
    } catch (err) {
      setPermissionError(describeMicError(err));
      showPermissionGate(true);
      return;
    }
    if (!batteryLevelOk()) {
      showBriefHud('Battery too low to record', 4000);
      return;
    }

    const prefs = getPrefs();
    const bitrate = QUALITY_BITRATE[prefs.audioQuality] || QUALITY_BITRATE.standard;
    const recorder = createMediaRecorder(stream, bitrate);
    if (!recorder) {
      showBriefHud('Recording not supported on this device', 4000);
      return;
    }
    mediaRecorder = recorder;
    pendingChunks.clear();
    currentChunkSeq = 0;
    autoStopReason = '';
    isPaused = false;
    pausedTotalMs = 0;
    pauseStartedAt = 0;
    stealthWarned = false;

    const clipId = nextClipId();
    currentRecordingId = clipId;
    const mimeType = lastRecordingMimeType || recorder.mimeType || 'audio/webm';
    recordingStartedAt = Date.now();
    recordingGeo = null;

    await putClipRecord({
      id: clipId,
      blob: null,
      size: 0,
      mimeType,
      durationSeconds: 0,
      createdAt: recordingStartedAt,
      status: 'recording',
    }).catch(() => {});

    captureRecordingGeo().then((geo) => {
      recordingGeo = geo;
      if (geo) {
        getClipRecord(clipId).then((rec) => {
          if (!rec) return;
          rec.latitude = geo.lat;
          rec.longitude = geo.lng;
          rec.locationLabel = geo.locationLabel || '';
          putClipRecord(rec).catch(() => {});
        }).catch(() => {});
      }
    }).catch(() => {});

    recorder.ondataavailable = (e) => {
      if (!e.data || !e.data.size) return;
      const seq = currentChunkSeq++;
      pendingChunks.set(seq, e.data);
      appendChunk(clipId, seq, e.data)
        .then(() => { pendingChunks.delete(seq); })
        .catch(() => {});
    };

    recorder.onstop = async () => {
      const finishedId = clipId;
      const durationSeconds = pendingClipDurationSeconds || Math.round(elapsedSeconds());
      const blobType = lastRecordingMimeType || mimeType;
      try {
        const blob = await assembleClipBlob(finishedId, blobType);
        pendingChunks.clear();
        if (blob && blob.size >= 600) {
          await finalizeClip(finishedId, blob, blobType, {
            recordedAt: recordingStartedAt || Date.now(),
            durationSeconds,
            latitude: recordingGeo?.lat,
            longitude: recordingGeo?.lng,
            locationLabel: recordingGeo?.locationLabel || '',
          });
          await deleteChunks(finishedId).catch(() => {});
        } else {
          await deleteClips([finishedId]).catch(() => {});
          await deleteChunks(finishedId).catch(() => {});
        }
      } catch {}
      await clearChunkStore().catch(() => {});
      currentRecordingId = null;
      refreshClipSummary().catch(() => {});
      if (autoStopReason) {
        showBriefHud(autoStopReason, 5000);
        autoStopReason = '';
      } else {
        showBriefHud('Saved', 2500);
      }
    };

    try {
      recorder.start(CHUNK_INTERVAL_MS);
    } catch {
      try { recorder.start(); } catch {}
    }

    isRecording = true;
    haptic(prefs.strongHapticOnRecord ? 'success' : 'light');
    await acquireWakeLock();
    startResourceWatch();
    startLevelMeter(stream);
    startElapsedTimer();
    setStateLabel();
    showBriefHud('Recording', HUD_RECORDING_MS);

    const maxMin = parseInt(prefs.maxClipMinutes, 10) || 0;
    if (maxMin > 0) {
      maxClipTimer = setTimeout(() => {
        autoStopReason = `Reached ${maxMin} min limit — recording saved.`;
        stopRecording();
      }, maxMin * 60 * 1000);
    }
  }

  function stopRecording() {
    if (!isRecording) return;
    if (Date.now() - recordingStartedAt < MIN_RECORD_MS && !autoStopReason) {
      // Likely a duplicated tap right after start — keep recording.
      showBriefHud('Recording', HUD_RECORDING_MS);
      return;
    }
    // If we're stopping mid-pause, close out that pause segment so the duration is accurate.
    if (isPaused && pauseStartedAt) {
      pausedTotalMs += Date.now() - pauseStartedAt;
      pauseStartedAt = 0;
    }
    // Capture the final duration BEFORE resetting so onstop saves the right length.
    pendingClipDurationSeconds = Math.round(elapsedSeconds());
    isRecording = false;
    isPaused = false;
    clearTimeout(maxClipTimer);
    maxClipTimer = null;
    stopResourceWatch();
    stopElapsedTimer();
    releaseWakeLock();
    haptic(getPrefs().strongHapticOnRecord ? 'success' : 'light');
    try {
      if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
    } catch {}
    // Reset the on-screen state back to Ready / 00:00.
    recordingStartedAt = 0;
    pausedTotalMs = 0;
    resetTimerDisplay();
    setStateLabel();
  }

  function resetTimerDisplay() {
    const el = $('voiceTimer');
    if (el) el.textContent = '00:00';
  }

  function togglePauseResume() {
    if (!isRecording || !mediaRecorder) return;
    if (!isPaused) {
      try { mediaRecorder.pause(); } catch {}
      isPaused = true;
      pauseStartedAt = Date.now();
      haptic('light');
    } else {
      try { mediaRecorder.resume(); } catch {}
      if (pauseStartedAt) pausedTotalMs += Date.now() - pauseStartedAt;
      pauseStartedAt = 0;
      isPaused = false;
      haptic('light');
    }
    setStateLabel();
  }

  function toggleRecording() {
    if (isRecording) stopRecording();
    else startRecording();
  }

  /* ---------------- session (open/close recorder screen) ---------------- */

  /* ---------------- fullscreen (true immersive, hides system bars like the camera) ---------------- */

  async function enterRecorderFullscreen() {
    const target = $('voiceRecorder');
    if (!target?.requestFullscreen) return false;
    if (document.fullscreenElement === target) return true;
    document.documentElement.style.backgroundColor = '#000';
    document.body.style.backgroundColor = '#000';
    try {
      await target.requestFullscreen({ navigationUI: 'hide' });
      return true;
    } catch {}
    return false;
  }

  function exitRecorderFullscreen() {
    try { if (document.fullscreenElement) document.exitFullscreen(); } catch {}
    document.documentElement.style.backgroundColor = '';
    document.body.style.backgroundColor = '';
  }

  function setStealth(on) {
    stealthOn = !!on;
    const black = $('voiceBlack');
    const panel = $('voiceRecorderPanel');
    if (black) black.classList.toggle('hidden', !stealthOn);
    if (panel) panel.classList.toggle('voice-rec__panel--hidden', stealthOn);
    const tap = $('voiceTapZone');
    if (tap) tap.setAttribute('aria-hidden', stealthOn ? 'false' : 'true');
    const stealthBtn = $('voiceStealthBtn');
    if (stealthBtn) stealthBtn.textContent = stealthOn ? 'Show controls' : 'Hide screen (Covert Mode)';
    if (stealthOn) {
      void enterRecorderFullscreen();
      showBriefHud(isRecording ? 'Recording' : 'Triple-tap to record', HUD_RECORDING_MS);
    } else {
      exitRecorderFullscreen();
    }
  }

  function openRecorderSession() {
    sessionActive = true;
    userClosedSession = false;
    const overlay = $('voiceRecorder');
    if (overlay) {
      overlay.classList.remove('hidden');
      overlay.setAttribute('aria-hidden', 'false');
    }
    document.body.classList.add('voice-rec-active');
    resetTimerDisplay();
    setStealth(getPrefs().stealthByDefault === true);
    setStateLabel();
    void initBattery();
    void requestMicAccess();
  }

  function closeRecorderSession() {
    if (isRecording) stopRecording();
    userClosedSession = true;
    sessionActive = false;
    stealthOn = false;
    exitRecorderFullscreen();
    stopMicStream();
    releaseWakeLock();
    stopLevelMeter();
    clearHud();
    const overlay = $('voiceRecorder');
    if (overlay) {
      overlay.classList.add('hidden');
      overlay.setAttribute('aria-hidden', 'true');
    }
    document.body.classList.remove('voice-rec-active');
    showRecorderHubRoot();
    refreshClipSummary().catch(() => {});
  }

  function requestOpenRecorder() {
    if (!hasConsent()) {
      showConsent(true);
      return;
    }
    openRecorderSession();
  }

  function showConsent(show) {
    const el = $('voiceConsent');
    if (el) {
      el.classList.toggle('hidden', !show);
      el.setAttribute('aria-hidden', show ? 'false' : 'true');
    }
  }

  /* ---------------- tap / swipe (stealth) ---------------- */

  function onTapZone() {
    tapCount += 1;
    clearTimeout(tapResetTimer);
    tapResetTimer = setTimeout(() => { tapCount = 0; }, TAP_RESET_MS);
    if (tapCount >= TAP_REQUIRED) {
      tapCount = 0;
      clearTimeout(tapResetTimer);
      toggleRecording();
      return;
    }
    if (isRecording) showBriefHud(isPaused ? 'Paused' : 'Recording', HUD_RECORDING_MS);
  }

  function onTouchStart(e) {
    swipeStartY = e.touches?.[0]?.clientY ?? null;
  }

  function onTouchEnd(e) {
    if (swipeStartY == null) return;
    const endY = e.changedTouches?.[0]?.clientY ?? swipeStartY;
    const dy = swipeStartY - endY;
    swipeStartY = null;
    if (dy > SWIPE_THRESHOLD) {
      // Swipe up: exit stealth back to controls.
      swipeUpCount += 1;
      clearTimeout(swipeUpResetTimer);
      swipeUpResetTimer = setTimeout(() => { swipeUpCount = 0; }, SWIPE_UP_RESET_MS);
      if (swipeUpCount >= 1) {
        swipeUpCount = 0;
        setStealth(false);
        haptic('light');
      }
    }
  }

  /* ---------------- recorder tab navigation ---------------- */

  let recorderNavStack = ['root'];

  function getActiveRecorderScreenId() {
    return recorderNavStack[recorderNavStack.length - 1] || 'root';
  }

  function scrollRecorderTabToTop() {
    const content = document.getElementById('appContent');
    if (!content) return;
    try { content.scrollTo({ top: 0, behavior: 'smooth' }); } catch { content.scrollTop = 0; }
  }

  function paintRecorderScreens() {
    const hub = $('recorderHub');
    const activeId = getActiveRecorderScreenId();
    const isRoot = activeId === 'root';
    if (hub) {
      hub.classList.toggle('hidden', !isRoot);
      hub.setAttribute('aria-hidden', isRoot ? 'false' : 'true');
    }
    document.querySelectorAll('[data-recorder-panel]').forEach((panel) => {
      const id = panel.dataset.recorderPanel || '';
      const open = !isRoot && id === activeId;
      panel.classList.toggle('hidden', !open);
      if (open) {
        panel.removeAttribute('hidden');
        panel.setAttribute('aria-hidden', 'false');
      } else {
        panel.setAttribute('hidden', '');
        panel.setAttribute('aria-hidden', 'true');
      }
    });
    if (activeId === 'clip-library') void renderClipsLibrary();
  }

  function pushRecorderScreen(screenId) {
    if (!screenId || screenId === 'root') return;
    if (getActiveRecorderScreenId() === screenId) return;
    recorderNavStack.push(screenId);
    paintRecorderScreens();
    scrollRecorderTabToTop();
  }

  function popRecorderScreen() {
    if (recorderNavStack.length <= 1) return;
    recorderNavStack.pop();
    paintRecorderScreens();
    scrollRecorderTabToTop();
  }

  function resetRecorderNav(screenId = 'root') {
    recorderNavStack = [screenId || 'root'];
    paintRecorderScreens();
    if ((screenId || 'root') !== 'root') scrollRecorderTabToTop();
  }

  function showRecorderHubRoot() {
    resetRecorderNav('root');
  }

  function bindRecorderNav() {
    if (window.__recorderNavBound) return;
    window.__recorderNavBound = true;
    $('recorderTabView')?.addEventListener('click', (event) => {
      const pushBtn = event.target.closest('[data-recorder-push]');
      if (pushBtn) {
        const target = pushBtn.dataset.recorderPush || '';
        if (target === 'recorder-settings') {
          if (typeof window.openSettings === 'function') window.openSettings('recorder-settings');
          haptic('light');
          return;
        }
        pushRecorderScreen(target);
        haptic('light');
        return;
      }
      if (event.target.closest('[data-recorder-pop]')) {
        haptic('light');
        popRecorderScreen();
      }
    });
  }

  /* ---------------- clip library ---------------- */

  function revokeClipPreviewUrls() {
    clipPreviewUrls.forEach((url) => { try { URL.revokeObjectURL(url); } catch {} });
    clipPreviewUrls.clear();
  }

  function getSelectedClipIds() {
    const list = $('voiceClipsList');
    if (!list) return [];
    return [...list.querySelectorAll('.voice-clip-card__check')]
      .filter((c) => c.checked)
      .map((c) => c.dataset.clipId)
      .filter(Boolean);
  }

  function updateClipsActions() {
    const ids = getSelectedClipIds();
    const sendBtn = $('voiceClipsSendBtn');
    const delBtn = $('voiceClipsDeleteBtn');
    if (sendBtn) sendBtn.disabled = ids.length === 0;
    if (delBtn) delBtn.disabled = ids.length === 0;
  }

  async function renderClipsLibrary() {
    const list = $('voiceClipsList');
    if (!list) return;
    const clips = await getAllClips().catch(() => []);
    revokeClipPreviewUrls();
    list.replaceChildren();
    const summary = $('voiceClipsSummary');
    const bytes = clips.reduce((s, c) => s + (c.size || 0), 0);
    if (summary) summary.textContent = `${clips.length} clip${clips.length === 1 ? '' : 's'} · ${formatBytes(bytes)}`;

    if (!clips.length) {
      const empty = document.createElement('p');
      empty.className = 'card-sub';
      empty.textContent = 'No recordings yet. Open the recorder to capture your first clip.';
      list.appendChild(empty);
      updateClipsActions();
      return;
    }

    let lastDay = '';
    clips.forEach((clip) => {
      const dayKey = getDayKey(clip.createdAt);
      if (dayKey !== lastDay) {
        lastDay = dayKey;
        const heading = document.createElement('h3');
        heading.className = 'voice-clip-day';
        heading.textContent = formatDayHeading(clip.createdAt);
        list.appendChild(heading);
      }
      const card = document.createElement('div');
      card.className = 'voice-clip-card';

      const check = document.createElement('input');
      check.type = 'checkbox';
      check.className = 'voice-clip-card__check';
      check.dataset.clipId = clip.id;
      check.setAttribute('aria-label', 'Select recording');
      check.addEventListener('change', updateClipsActions);

      const play = document.createElement('button');
      play.type = 'button';
      play.className = 'voice-clip-card__play';
      play.setAttribute('aria-label', 'Play recording');
      play.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';
      play.addEventListener('click', () => openClipViewer(clip));

      const meta = document.createElement('div');
      meta.className = 'voice-clip-card__meta';
      const title = document.createElement('span');
      title.className = 'voice-clip-card__title';
      title.textContent = `${formatClipTime(clip.createdAt)} · ${formatDuration(clip.durationSeconds)}`;
      const sub = document.createElement('span');
      sub.className = 'voice-clip-card__sub';
      const loc = (clip.locationLabel || '').trim();
      sub.textContent = `${formatBytes(clip.size || 0)}${loc ? ` · ${loc}` : ''}`;
      meta.append(title, sub);

      card.append(check, play, meta);
      list.appendChild(card);
    });
    updateClipsActions();
  }

  function openClipViewer(clip) {
    const viewer = $('voiceClipViewer');
    const audio = $('voiceClipViewerAudio');
    const titleEl = $('voiceClipViewerTitle');
    if (!viewer || !audio) return;
    if (clipViewerUrl) { try { URL.revokeObjectURL(clipViewerUrl); } catch {} clipViewerUrl = null; }
    clipViewerUrl = URL.createObjectURL(clip.blob);
    audio.src = clipViewerUrl;
    if (titleEl) titleEl.textContent = `${formatClipDate(clip.createdAt)} · ${formatDuration(clip.durationSeconds)}`;
    viewer.classList.remove('hidden');
    viewer.setAttribute('aria-hidden', 'false');
    audio.play().catch(() => {});
    haptic('light');
  }

  function closeClipViewer() {
    const viewer = $('voiceClipViewer');
    const audio = $('voiceClipViewerAudio');
    if (audio) { try { audio.pause(); } catch {} audio.removeAttribute('src'); audio.load?.(); }
    if (clipViewerUrl) { try { URL.revokeObjectURL(clipViewerUrl); } catch {} clipViewerUrl = null; }
    if (viewer) {
      viewer.classList.add('hidden');
      viewer.setAttribute('aria-hidden', 'true');
    }
  }

  async function refreshClipSummary() {
    const summary = await getStorageSummary();
    const navMeta = $('recorderClipsNavMeta');
    if (navMeta) navMeta.textContent = `${summary.count} clip${summary.count === 1 ? '' : 's'}`;
    const listSummary = $('voiceClipsSummary');
    if (listSummary) listSummary.textContent = `${summary.count} clip${summary.count === 1 ? '' : 's'} · ${formatBytes(summary.bytes)}`;
  }

  /* ---------------- settings UI ---------------- */

  async function refreshRecorderPermissionUi() {
    const targets = document.querySelectorAll('[data-rec-permission-status]');
    if (!targets.length) return;
    let text = 'Open the recorder to grant microphone access.';
    if (navigator.permissions?.query) {
      try {
        const mic = await navigator.permissions.query({ name: 'microphone' });
        text = `Microphone: ${mic.state}`;
      } catch {
        text = 'Permission status unavailable — open the recorder to grant access.';
      }
    }
    targets.forEach((el) => { el.textContent = text; });
  }

  function syncPickerLabel(select) {
    if (!select) return;
    const wrap = select.closest('.menu-wrap');
    if (!wrap) return;
    const labelSpan = wrap.querySelector('.city-btn span');
    const option = select.options[select.selectedIndex];
    if (labelSpan && option) labelSpan.textContent = option.textContent.trim();
  }

  function syncRecorderSettingsUi() {
    const prefs = getPrefs();
    [
      ['wakeLock', !!prefs.wakeLock],
      ['strongHapticOnRecord', !!prefs.strongHapticOnRecord],
      ['voiceClarity', prefs.voiceClarity !== false],
      ['stealthByDefault', !!prefs.stealthByDefault],
    ].forEach(([key, checked]) => {
      document.querySelectorAll(`[data-rec-pref="${key}"]`).forEach((input) => {
        input.checked = checked;
        if (typeof window.syncToggleStateLabel === 'function') window.syncToggleStateLabel(input);
      });
    });
    document.querySelectorAll('[data-rec-select]').forEach((select) => {
      const key = select.getAttribute('data-rec-select');
      if (key && prefs[key] != null) select.value = String(prefs[key]);
      syncPickerLabel(select);
    });
    document.querySelectorAll('[data-rec-max-minutes]').forEach((select) => {
      select.value = String(prefs.maxClipMinutes ?? 0);
      syncPickerLabel(select);
    });
  }

  function bindSettings() {
    if (window.__recorderSettingsBound) return;
    window.__recorderSettingsBound = true;

    document.querySelectorAll('[data-rec-action="perm-help"]').forEach((btn) => {
      btn.addEventListener('click', () => {
        haptic('light');
        window.alert(
          'Android: Settings → Apps → Toolbox (or Chrome) → Permissions → Microphone → Allow.\n\n' +
            'Chrome: ⋮ → Settings → Site settings → Microphone → Allow for this site.'
        );
      });
    });

    ['wakeLock', 'strongHapticOnRecord', 'voiceClarity', 'stealthByDefault'].forEach((key) => {
      document.querySelectorAll(`[data-rec-pref="${key}"]`).forEach((input) => {
        input.addEventListener('change', (e) => {
          const prefs = getPrefs();
          prefs[key] = e.target.checked;
          savePrefs(prefs);
          syncRecorderSettingsUi();
          haptic('light');
        });
      });
    });

    document.querySelectorAll('[data-rec-select]').forEach((select) => {
      select.addEventListener('change', (e) => {
        const key = e.target.getAttribute('data-rec-select');
        if (!key) return;
        const prefs = getPrefs();
        prefs[key] = e.target.value;
        savePrefs(prefs);
        syncRecorderSettingsUi();
        haptic('light');
      });
    });

    document.querySelectorAll('[data-rec-max-minutes]').forEach((select) => {
      select.addEventListener('change', (e) => {
        const prefs = getPrefs();
        prefs.maxClipMinutes = parseInt(e.target.value, 10) || 0;
        savePrefs(prefs);
        syncRecorderSettingsUi();
        haptic('light');
      });
    });

    document.querySelectorAll('[data-rec-action="clear-all"]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!window.confirm('Delete all voice recordings saved in Toolbox on this device?')) return;
        await clearAllClips();
        await refreshClipSummary();
        await renderClipsLibrary();
        refreshRecorderSettingsUi();
        haptic('medium');
      });
    });

    document.querySelectorAll('[data-rec-action="download-all"]').forEach((btn) => {
      btn.addEventListener('click', () => downloadClips());
    });
  }

  async function refreshRecorderSettingsUi() {
    syncRecorderSettingsUi();
    await refreshRecorderPermissionUi();
    refreshRecordingFormatUi();
    const summary = await getStorageSummary();
    const free = await getFreeStorageBytes();
    const freeText = free != null ? ` · ${formatBytes(free)} free on device` : '';
    const storageText = `${summary.count} clip(s) · ${formatBytes(summary.bytes)} used${freeText}`;
    document.querySelectorAll('[data-rec-storage-summary]').forEach((el) => {
      el.textContent = storageText;
    });
  }

  /* ---------------- bindings + lifecycle ---------------- */

  function bindUi() {
    if (window.__voiceRecorderUiBound) return;
    window.__voiceRecorderUiBound = true;
    bindRecorderNav();

    $('voiceOpenRecorderBtn')?.addEventListener('click', () => {
      haptic('light');
      requestOpenRecorder();
    });

    $('voiceConsentAcceptBtn')?.addEventListener('click', () => {
      setConsent();
      showConsent(false);
      openRecorderSession();
    });
    $('voiceConsentDeclineBtn')?.addEventListener('click', () => {
      showConsent(false);
      haptic('light');
    });

    $('voiceRecordBtn')?.addEventListener('click', () => toggleRecording());
    $('voicePauseBtn')?.addEventListener('click', () => togglePauseResume());
    $('voiceStealthBtn')?.addEventListener('click', () => {
      setStealth(!stealthOn);
      haptic('light');
    });
    $('voiceCloseBtn')?.addEventListener('click', () => {
      haptic('light');
      closeRecorderSession();
    });

    const zone = $('voiceTapZone');
    zone?.addEventListener('click', onTapZone);
    zone?.addEventListener('touchstart', onTouchStart, { passive: true });
    zone?.addEventListener('touchend', onTouchEnd, { passive: true });

    $('voiceAllowMicBtn')?.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      requestMicAccess();
    }, { capture: true });
    $('voiceCloseGateBtn')?.addEventListener('click', () => {
      haptic('light');
      closeRecorderSession();
    });

    $('voiceClipsSelectAllBtn')?.addEventListener('click', () => {
      const list = $('voiceClipsList');
      const checks = list ? [...list.querySelectorAll('.voice-clip-card__check')] : [];
      if (!checks.length) return;
      const allOn = checks.every((c) => c.checked);
      checks.forEach((c) => { c.checked = !allOn; });
      updateClipsActions();
      haptic('light');
    });
    $('voiceClipsSendBtn')?.addEventListener('click', () => {
      const ids = getSelectedClipIds();
      if (ids.length) downloadClips(ids);
    });
    $('voiceClipsDeleteBtn')?.addEventListener('click', async () => {
      const ids = getSelectedClipIds();
      if (!ids.length) return;
      if (!window.confirm(`Delete ${ids.length} recording(s) from this device?`)) return;
      await deleteClips(ids);
      haptic('medium');
      await renderClipsLibrary();
      refreshRecorderSettingsUi();
    });

    $('voiceClipViewerClose')?.addEventListener('click', () => {
      closeClipViewer();
      haptic('light');
    });
    $('voiceClipViewer')?.addEventListener('click', (e) => {
      if (e.target === $('voiceClipViewer')) closeClipViewer();
    });
  }

  async function onTabEnter() {
    bindUi();
    bindSettings();
    void requestPersistentStorage();
    if (!batteryRef) void initBattery();
    swipeUpCount = 0;
    clearTimeout(swipeUpResetTimer);
    await refreshClipSummary().catch(() => {});
    if (sessionActive) {
      // Returning to an in-progress session (e.g. background recording) — re-lock scroll.
      document.body.classList.add('voice-rec-active');
    } else {
      showRecorderHubRoot();
    }
  }

  function onTabLeave() {
    // Release the body scroll-lock so other tabs scroll normally, even if a recording
    // continues in the background. The fixed overlay is hidden with its tab panel anyway.
    document.body.classList.remove('voice-rec-active');
    if (isRecording) {
      // Keep recording in the background — the clip keeps flushing to disk.
      // (Spec: recording survives tab switches.)
      return;
    }
    if (sessionActive) closeRecorderSession();
    revokeClipPreviewUrls();
    resetRecorderNav('root');
  }

  async function init() {
    bindUi();
    bindSettings();
    void requestPersistentStorage();
    void initBattery();
    const rescue = await rescueClipStorage().catch(() => ({ rescued: 0 }));
    refreshClipSummary().catch(() => {});
    if (rescue.rescued > 0) void renderClipsLibrary();
  }

  window.ToolboxVoiceRecorder = {
    init,
    onTabEnter,
    onTabLeave,
    requestMicAccess,
    openRecorderSession,
    closeRecorderSession,
    refreshRecorderSettingsUi,
    refreshClipSummary,
    renderClipsLibrary,
    showRecorderHubRoot,
    pushRecorderScreen,
    popRecorderScreen,
    resetRecorderNav,
    isRecording: () => isRecording,
    isSessionActive: () => sessionActive,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
