/**
 * Toolbox — Covert camera (landscape 1080p, rear only, in-app storage).
 */
(function () {
  const DB_NAME = 'toolbox-covert';
  const DB_VERSION = 2;
  const STORE = 'clips';
  const CHUNK_STORE = 'chunks';
  const PREFS_KEY = 'toolboxCameraPrefs';
  const INDEX_KEY = 'toolboxCovertClipIndex';
  // Resource fail-safe thresholds.
  const LOW_BATTERY = 0.20;
  const CRITICAL_BATTERY = 0.05;
  const LOW_STORAGE_BYTES = 300 * 1024 * 1024;
  const CRITICAL_STORAGE_BYTES = 150 * 1024 * 1024;
  const STORAGE_WATCH_MS = 8000;
  const TAP_REQUIRED = 3;
  const TAP_RESET_MS = 700;
  // Ignore a "stop" that lands right after a "start" — that's almost always a duplicated
  // tap event, not the user wanting a sub-second clip. Prevents start-then-instant-stop.
  const MIN_RECORD_MS = 1200;
  const SWIPE_CLOSE_REQUIRED = 2;
  const SWIPE_THRESHOLD = 48;
  const SWIPE_UP_RESET_MS = 1200;
  const HUD_RECORDING_MS = 5000;

  const defaultPrefs = {
    wakeLock: true,
    maxClipMinutes: 10,
    strongHapticOnRecord: true,
    timestampEnabled: false,
    timestampDateFormat: 'YYYY-MM-DD',
    timestampClock24: false,
    timestampPosition: 'bottom',
    timestampSize: 'medium',
  };

  let mediaStream = null;
  let mediaRecorder = null;
  let recordedChunks = [];
  let isRecording = false;
  let previewVisible = false;
  let tapCount = 0;
  let tapResetTimer = null;
  let wakeLockSentinel = null;
  let maxClipTimer = null;
  let swipeStartY = null;
  let swipeUpCount = 0;
  let swipeUpResetTimer = null;
  let hudTimer = null;
  let dbPromise = null;
  let allowInFlight = false;
  let cameraSessionActive = false;
  let userClosedSession = false;
  const clipPreviewUrls = new Map();
  let clipViewerUrl = null;
  let orientationWatchHandler = null;
  let usedFullscreenForOrientation = false;
  let recordingStartedAt = 0;
  let recordingGeo = null;
  // Crash-safe recording + resource fail-safes.
  let currentRecordingId = null;
  let currentChunkSeq = 0;
  let autoStopReason = '';
  let batteryRef = null;
  let storageWatchTimer = null;
  let batteryWatchHandler = null;
  // Timestamp burn-in pipeline (only used when prefs.timestampEnabled is on).
  let tsDrawHandle = null;
  let tsSourceVideo = null;
  let tsCanvasStream = null;
  let tsUsingRVFC = false;
  /** Last mime used (or probed) for settings UI — updated when recording starts. */
  let lastRecordingMimeType = '';
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
    const patterns = {
      light: 22,
      medium: [24, 58, 24],
      success: [18, 72, 18],
      tap: [16, 36, 16],
    };
    try {
      navigator.vibrate(patterns[style] || patterns.tap);
    } catch {}
  }

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
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {}
  }

  function nextClipId() {
    let n = 0;
    try {
      n = parseInt(localStorage.getItem(INDEX_KEY) || '0', 10);
      if (!Number.isFinite(n) || n < 0) n = 0;
    } catch {}
    const id = String(n).padStart(5, '0');
    try {
      localStorage.setItem(INDEX_KEY, String(n + 1));
    } catch {}
    return id;
  }

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

  async function getAllClipRecordsRaw() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async function putClipRecord(record) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(record);
      tx.oncomplete = () => resolve(record.id);
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

  /** Write the finished clip under its reserved id (used on stop and on crash recovery). */
  async function finalizeClip(id, blob, mimeType, meta) {
    const m = meta || {};
    return putClipRecord({
      id,
      blob,
      mimeType: mimeType || blob.type,
      createdAt: m.recordedAt || Date.now(),
      size: blob.size,
      durationSeconds: m.durationSeconds || 0,
      latitude: m.latitude,
      longitude: m.longitude,
      locationLabel: m.locationLabel || '',
      status: 'complete',
    });
  }

  async function appendChunk(clipId, seq, blob) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(CHUNK_STORE, 'readwrite');
      tx.objectStore(CHUNK_STORE).add({ clipId, seq, blob });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function getChunkBlobs(clipId) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(CHUNK_STORE, 'readonly');
      const req = tx.objectStore(CHUNK_STORE).index('clipId').getAll(IDBKeyRange.only(clipId));
      req.onsuccess = () => {
        const list = (req.result || []).sort((a, b) => (a.seq || 0) - (b.seq || 0));
        resolve(list.map((r) => r.blob).filter(Boolean));
      };
      req.onerror = () => reject(req.error);
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

  async function deleteChunks(clipId) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(CHUNK_STORE, 'readwrite');
      const req = tx.objectStore(CHUNK_STORE).index('clipId').openCursor(IDBKeyRange.only(clipId));
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

  function isQuotaError(err) {
    if (!err) return false;
    const name = err.name || '';
    return (
      name === 'QuotaExceededError' ||
      name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
      /quota|storage/i.test(err.message || '')
    );
  }

  /** Ask the browser to keep clips from being evicted when the device fills up. */
  async function requestPersistentStorage() {
    try {
      if (!navigator.storage?.persist) return;
      const already = navigator.storage.persisted ? await navigator.storage.persisted() : false;
      if (!already) await navigator.storage.persist();
    } catch {}
  }

  async function getFreeStorageBytes() {
    try {
      if (navigator.storage?.estimate) {
        const { usage = 0, quota = 0 } = await navigator.storage.estimate();
        return Math.max(0, quota - usage);
      }
    } catch {}
    return null;
  }

  async function initBattery() {
    try {
      if (typeof navigator.getBattery === 'function') {
        batteryRef = await navigator.getBattery();
      }
    } catch {
      batteryRef = null;
    }
  }

  function batteryIsLow() {
    return !!batteryRef && !batteryRef.charging && batteryRef.level <= LOW_BATTERY;
  }

  function batteryIsCritical() {
    return !!batteryRef && !batteryRef.charging && batteryRef.level <= CRITICAL_BATTERY;
  }

  function onStorageCritical() {
    if (!isRecording) return;
    autoStopReason = 'Stopped — storage low (clip saved)';
    stopRecording();
  }

  function onBatteryCritical() {
    if (!isRecording) return;
    autoStopReason = 'Stopped — battery critical (clip saved)';
    stopRecording();
  }

  /** Auto-stop + save before the device dies or fills up. */
  function startResourceWatch() {
    stopResourceWatch();
    storageWatchTimer = setInterval(async () => {
      if (!isRecording) return;
      const free = await getFreeStorageBytes();
      if (free != null && free < CRITICAL_STORAGE_BYTES) onStorageCritical();
    }, STORAGE_WATCH_MS);
    if (batteryRef) {
      batteryWatchHandler = () => {
        if (isRecording && batteryIsCritical()) onBatteryCritical();
      };
      try {
        batteryRef.addEventListener('levelchange', batteryWatchHandler);
        batteryRef.addEventListener('chargingchange', batteryWatchHandler);
      } catch {}
      batteryWatchHandler();
    }
  }

  function stopResourceWatch() {
    if (storageWatchTimer) {
      clearInterval(storageWatchTimer);
      storageWatchTimer = null;
    }
    if (batteryRef && batteryWatchHandler) {
      try {
        batteryRef.removeEventListener('levelchange', batteryWatchHandler);
        batteryRef.removeEventListener('chargingchange', batteryWatchHandler);
      } catch {}
      batteryWatchHandler = null;
    }
  }

  /**
   * Rescue clips after a crash, force-close, or update mid-record. The library hides
   * status=recording and entries without a blob — this rebuilds them from chunks when possible.
   */
  async function rescueClipStorage() {
    let records = [];
    try {
      records = await getAllClipRecordsRaw();
    } catch {
      return { rescued: 0, rawCount: 0, hiddenCount: 0 };
    }
    let rescued = 0;
    for (const r of records) {
      if (!r?.id) continue;
      const hasBlob = !!(r.blob && r.blob.size >= 1000);
      const needsRescue = r.status === 'recording' || !hasBlob;
      if (!needsRescue) continue;

      if (hasBlob && r.status === 'recording') {
        try {
          await finalizeClip(r.id, r.blob, r.mimeType, {
            recordedAt: r.createdAt,
            durationSeconds: r.durationSeconds || 0,
            latitude: r.latitude,
            longitude: r.longitude,
            locationLabel: r.locationLabel || '',
          });
          await deleteChunks(r.id).catch(() => {});
          rescued += 1;
        } catch {}
        continue;
      }

      try {
        const blobs = await getChunkBlobs(r.id);
        const blob = blobs.length ? new Blob(blobs, { type: r.mimeType || 'video/webm' }) : null;
        if (blob && blob.size >= 1000) {
          await finalizeClip(r.id, blob, r.mimeType, {
            recordedAt: r.createdAt || Date.now(),
            durationSeconds: r.durationSeconds || blobs.length,
            latitude: r.latitude,
            longitude: r.longitude,
            locationLabel: r.locationLabel || '',
          });
          await deleteChunks(r.id).catch(() => {});
          rescued += 1;
        } else if (r.status === 'recording') {
          await deleteClips([r.id]);
          await deleteChunks(r.id).catch(() => {});
        }
      } catch {}
    }

    let rawCount = 0;
    let hiddenCount = 0;
    try {
      const after = await getAllClipRecordsRaw();
      rawCount = after.length;
      hiddenCount = after.filter((c) => {
        if (!c) return false;
        const ok = c.blob && c.blob.size >= 1000 && c.status !== 'recording';
        return !ok;
      }).length;
    } catch {}
    return { rescued, rawCount, hiddenCount };
  }

  /** @deprecated name kept for callers — use rescueClipStorage */
  async function recoverInterruptedClips() {
    return rescueClipStorage();
  }

  async function getAllClips() {
    await rescueClipStorage().catch(() => {});
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => {
        const list = (req.result || [])
          .filter((c) => c && c.blob && c.blob.size >= 1000 && c.status !== 'recording')
          .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        resolve(list);
      };
      req.onerror = () => reject(req.error);
    });
  }

  async function clearAllClips() {
    const db = await openDb();
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

  function formatBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }

  function formatDuration(seconds) {
    const s = Math.max(0, Math.round(seconds || 0));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${String(r).padStart(2, '0')}`;
  }

  function formatClipDate(timestamp) {
    const d = new Date(timestamp || Date.now());
    return d.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  }

  function getClipDayKey(timestamp) {
    const d = new Date(timestamp || Date.now());
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function formatClipDayHeading(timestamp) {
    const d = new Date(timestamp || Date.now());
    return d.toLocaleDateString(undefined, {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  }

  function formatClipDayShort(timestamp) {
    const d = new Date(timestamp || Date.now());
    return d.toLocaleDateString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    });
  }

  function getActiveCameraScreenId() {
    return cameraNavStack[cameraNavStack.length - 1] || 'root';
  }

  function isClipLibraryScreen(screenId) {
    return screenId === 'clip-library' || (typeof screenId === 'string' && screenId.startsWith('clip-day:'));
  }

  function getClipDayKeyFromScreen(screenId) {
    if (!screenId || !String(screenId).startsWith('clip-day:')) return null;
    return String(screenId).slice('clip-day:'.length);
  }

  let cameraNavStack = ['root'];

  function scrollCameraTabToTop() {
    const content = document.getElementById('appContent');
    if (!content) return;
    try {
      content.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (e) {
      content.scrollTop = 0;
    }
  }

  function updateClipLibraryBackLabel() {
    const btn = $('clipLibraryBackBtn');
    if (!btn) return;
    const activeId = getActiveCameraScreenId();
    const inDay = activeId.startsWith('clip-day:');
    btn.setAttribute('aria-label', inDay ? 'Back to day folders' : 'Back to Covert Camera');
  }

  function setClipLibrarySubview(mode) {
    const folders = $('covertClipsLibraryFolders');
    const dayView = $('covertClipsDayView');
    const inDay = mode === 'day';
    folders?.classList.toggle('hidden', inDay);
    if (folders) folders.setAttribute('aria-hidden', inDay ? 'true' : 'false');
    dayView?.classList.toggle('hidden', !inDay);
    if (dayView) {
      dayView.setAttribute('aria-hidden', inDay ? 'false' : 'true');
      if (inDay) dayView.removeAttribute('hidden');
      else dayView.setAttribute('hidden', '');
    }
    updateClipLibraryBackLabel();
  }

  function paintCameraScreens() {
    const hub = $('covertClipsHub');
    const activeId = getActiveCameraScreenId();
    const isRoot = activeId === 'root';
    const sessionOpen = cameraSessionActive && !$('covertCamera')?.classList.contains('covert-camera--session-off');

    if (hub) {
      const showHub = isRoot && !sessionOpen;
      hub.classList.toggle('hidden', !showHub);
      hub.setAttribute('aria-hidden', showHub ? 'false' : 'true');
    }

    document.querySelectorAll('[data-camera-panel]').forEach((panel) => {
      const id = panel.dataset.cameraPanel || '';
      const open =
        !isRoot &&
        !sessionOpen &&
        (id === activeId || (id === 'clip-library' && isClipLibraryScreen(activeId)));
      panel.classList.toggle('hidden', !open);
      if (open) {
        panel.removeAttribute('hidden');
        panel.setAttribute('aria-hidden', 'false');
      } else {
        panel.setAttribute('hidden', '');
        panel.setAttribute('aria-hidden', 'true');
      }
    });

    if (isClipLibraryScreen(activeId)) {
      setClipLibrarySubview(getClipDayKeyFromScreen(activeId) ? 'day' : 'folders');
      void renderClipsLibrary();
    }
  }

  function pushCameraScreen(screenId) {
    if (!screenId || screenId === 'root') return;
    const top = getActiveCameraScreenId();
    if (top === screenId) return;
    if (screenId === 'clip-library') {
      cameraNavStack = ['root', 'clip-library'];
    } else {
      cameraNavStack.push(screenId);
    }
    paintCameraScreens();
    scrollCameraTabToTop();
  }

  function popCameraScreen() {
    if (cameraNavStack.length <= 1) return;
    const top = getActiveCameraScreenId();
    if (top.startsWith('clip-day:')) {
      while (cameraNavStack.length > 1 && getActiveCameraScreenId().startsWith('clip-day:')) {
        cameraNavStack.pop();
      }
      if (getActiveCameraScreenId() !== 'clip-library') {
        cameraNavStack.push('clip-library');
      }
    } else {
      cameraNavStack.pop();
    }
    paintCameraScreens();
    scrollCameraTabToTop();
  }

  function resetCameraNav(screenId = 'root') {
    cameraNavStack = [screenId || 'root'];
    paintCameraScreens();
    if ((screenId || 'root') !== 'root') scrollCameraTabToTop();
  }

  function bindCameraNav() {
    if (window.__cameraNavBound) return;
    window.__cameraNavBound = true;

    $('cameraTabView')?.addEventListener('click', (event) => {
      const dayFolderBtn = event.target.closest('[data-camera-push-day]');
      if (dayFolderBtn) {
        const dayKey = dayFolderBtn.dataset.cameraPushDay || '';
        if (dayKey) {
          pushCameraScreen(`clip-day:${dayKey}`);
          haptic('light');
        }
        return;
      }
      const pushBtn = event.target.closest('[data-camera-push]');
      if (pushBtn) {
        const target = pushBtn.dataset.cameraPush || '';
        if (target === 'camera-settings') {
          if (typeof window.openSettings === 'function') {
            window.openSettings('camera-settings', { fromCameraTab: true });
          }
          haptic('light');
          return;
        }
        pushCameraScreen(target);
        haptic('light');
        return;
      }
      if (event.target.closest('[data-camera-pop]')) {
        haptic('light');
        popCameraScreen();
      }
    });
  }

  function formatCoords(geo) {
    if (!geo || !Number.isFinite(geo.lat) || !Number.isFinite(geo.lng)) return '';
    const ns = geo.lat >= 0 ? 'N' : 'S';
    const ew = geo.lng >= 0 ? 'E' : 'W';
    return `${Math.abs(geo.lat).toFixed(4)}° ${ns}, ${Math.abs(geo.lng).toFixed(4)}° ${ew}`;
  }

  function formatClipDetailsLine(clip, durationSeconds) {
    const parts = [];
    if (durationSeconds > 0) parts.push(formatDuration(durationSeconds));
    if (clip.createdAt) parts.push(formatClipDate(clip.createdAt));
    const loc = (clip.locationLabel || '').trim();
    parts.push(loc || 'Location unavailable');
    return parts.join(' · ');
  }

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

  function probeBlobDuration(blob) {
    return new Promise((resolve) => {
      const video = document.createElement('video');
      const url = URL.createObjectURL(blob);
      video.preload = 'metadata';
      video.onloadedmetadata = () => {
        const d = Number.isFinite(video.duration) ? video.duration : 0;
        URL.revokeObjectURL(url);
        resolve(d);
      };
      video.onerror = () => {
        URL.revokeObjectURL(url);
        resolve(0);
      };
      video.src = url;
    });
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

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function formatStampDate(date, fmt) {
    const y = date.getFullYear();
    const mo = pad2(date.getMonth() + 1);
    const d = pad2(date.getDate());
    switch (fmt) {
      case 'MM/DD/YYYY':
        return `${mo}/${d}/${y}`;
      case 'DD/MM/YYYY':
        return `${d}/${mo}/${y}`;
      case 'MON-DD-YYYY':
        return date.toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' });
      case 'YYYY-MM-DD':
      default:
        return `${y}-${mo}-${d}`;
    }
  }

  function formatStampTime(date, clock24) {
    const s = pad2(date.getSeconds());
    if (clock24) return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${s}`;
    let h = date.getHours();
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return `${pad2(h)}:${pad2(date.getMinutes())}:${s} ${ampm}`;
  }

  /** Draw the dashcam-style stamp: date on one side, time on the other, along one edge. */
  function drawTimestampOnCanvas(ctx, w, h, prefs) {
    const now = new Date();
    const dateStr = formatStampDate(now, prefs.timestampDateFormat);
    const timeStr = formatStampTime(now, prefs.timestampClock24 !== false);
    const scale = prefs.timestampSize === 'small' ? 0.026 : prefs.timestampSize === 'large' ? 0.05 : 0.036;
    const fontPx = Math.max(12, Math.round(h * scale));
    const pad = Math.round(fontPx * 0.7);
    ctx.save();
    ctx.font = `600 ${fontPx}px -apple-system, "Segoe UI", Roboto, Arial, sans-serif`;
    ctx.shadowColor = 'rgba(0,0,0,0.85)';
    ctx.shadowBlur = Math.max(2, Math.round(fontPx * 0.22));
    ctx.shadowOffsetX = 1;
    ctx.shadowOffsetY = 1;
    ctx.fillStyle = '#ffffff';
    const onTop = prefs.timestampPosition === 'top';
    ctx.textBaseline = onTop ? 'top' : 'alphabetic';
    const y = onTop ? pad : h - pad;
    ctx.textAlign = 'left';
    ctx.fillText(dateStr, pad, y);
    ctx.textAlign = 'right';
    ctx.fillText(timeStr, w - pad, y);
    ctx.restore();
  }

  /**
   * Build a canvas-backed stream that burns the timestamp into every frame, then record THAT.
   * Returns the new stream or null on any failure (caller falls back to the raw stream so
   * recording can never break). Video-only — no audio tracks are ever added.
   */
  async function buildTimestampedStream(srcStream) {
    try {
      const videoTrack = srcStream.getVideoTracks?.()[0];
      if (!videoTrack || typeof HTMLCanvasElement === 'undefined') return null;
      const v = document.createElement('video');
      v.muted = true;
      v.defaultMuted = true;
      v.setAttribute('playsinline', '');
      v.setAttribute('webkit-playsinline', '');
      v.playsInline = true;
      // Keep on-screen-but-invisible (NOT display:none) so iOS keeps decoding frames.
      v.style.cssText = 'position:fixed;left:-10000px;top:0;width:2px;height:2px;opacity:0;pointer-events:none;';
      v.srcObject = srcStream;
      document.body.appendChild(v);
      await v.play().catch(() => {});
      // Wait briefly for dimensions.
      for (let i = 0; i < 20 && (!v.videoWidth || !v.videoHeight); i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      const settings = videoTrack.getSettings?.() || {};
      const w = settings.width || v.videoWidth || 1280;
      const h = settings.height || v.videoHeight || 720;
      if (typeof document.createElement('canvas').captureStream !== 'function') {
        v.remove();
        return null;
      }
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        v.remove();
        return null;
      }
      const fps = Math.min(30, Math.round(settings.frameRate || 30));
      const paint = () => {
        try {
          ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
          if (getPrefs().timestampEnabled) drawTimestampOnCanvas(ctx, canvas.width, canvas.height, getPrefs());
        } catch {}
      };
      paint();
      // Prefer requestVideoFrameCallback so the canvas redraws exactly when a new camera frame
      // arrives (smooth, no duplicated/dropped frames). Fall back to rAF where it's unavailable.
      tsUsingRVFC = typeof v.requestVideoFrameCallback === 'function';
      if (tsUsingRVFC) {
        const loopRVFC = () => {
          paint();
          tsDrawHandle = v.requestVideoFrameCallback(loopRVFC);
        };
        tsDrawHandle = v.requestVideoFrameCallback(loopRVFC);
      } else {
        const loopRAF = () => {
          paint();
          tsDrawHandle = requestAnimationFrame(loopRAF);
        };
        loopRAF();
      }
      const out = canvas.captureStream(fps);
      tsSourceVideo = v;
      tsCanvasStream = out;
      return out;
    } catch {
      cleanupTimestampPipeline();
      return null;
    }
  }

  function cleanupTimestampPipeline() {
    if (tsDrawHandle != null) {
      if (tsUsingRVFC && tsSourceVideo && typeof tsSourceVideo.cancelVideoFrameCallback === 'function') {
        try { tsSourceVideo.cancelVideoFrameCallback(tsDrawHandle); } catch {}
      } else {
        cancelAnimationFrame(tsDrawHandle);
      }
      tsDrawHandle = null;
    }
    tsUsingRVFC = false;
    if (tsCanvasStream) {
      tsCanvasStream.getVideoTracks().forEach((t) => t.stop());
      tsCanvasStream = null;
    }
    if (tsSourceVideo) {
      try {
        tsSourceVideo.pause();
        tsSourceVideo.srcObject = null;
        tsSourceVideo.remove();
      } catch {}
      tsSourceVideo = null;
    }
  }

  /** MP4 (H.264) first for upload/evidence tools; WebM fallback. Video-only — no audio codecs. */
  function getRecordingMimeCandidates() {
    return [
      'video/mp4;codecs=avc1.42E01E',
      'video/mp4;codecs=avc1.424028',
      'video/mp4;codecs=avc1',
      'video/mp4',
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm',
    ];
  }

  function probePreferredMimeType() {
    if (typeof MediaRecorder === 'undefined') return '';
    return getRecordingMimeCandidates().find((t) => MediaRecorder.isTypeSupported(t)) || '';
  }

  function pickMimeType() {
    const mime = probePreferredMimeType();
    if (mime) lastRecordingMimeType = mime;
    return mime;
  }

  function describeRecordingFormat(mime) {
    if (!mime) {
      return 'Recording format: not supported in this browser — update Chrome or reinstall Toolbox.';
    }
    const lower = String(mime).toLowerCase();
    if (lower.includes('mp4') || lower.includes('avc1')) {
      return 'Recording format: MP4 (H.264), video only — best match for upload and evidence tools.';
    }
    if (lower.includes('vp9')) {
      return 'Recording format: WebM (VP9), video only — this device does not offer MP4 recording in Chrome.';
    }
    if (lower.includes('vp8')) {
      return 'Recording format: WebM (VP8), video only — this device does not offer MP4 recording in Chrome.';
    }
    const base = mime.split(';')[0] || mime;
    return `Recording format: ${base}, video only.`;
  }

  function refreshRecordingFormatUi() {
    const mime = lastRecordingMimeType || probePreferredMimeType();
    const text = describeRecordingFormat(mime);
    document.querySelectorAll('[data-cam-recording-format]').forEach((el) => {
      el.textContent = text;
    });
  }

  function createMediaRecorder(stream, videoBitsPerSecond) {
    if (typeof MediaRecorder === 'undefined') return null;
    for (const mimeType of getRecordingMimeCandidates()) {
      if (!MediaRecorder.isTypeSupported(mimeType)) continue;
      try {
        const rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond });
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
      const rec = new MediaRecorder(stream, { videoBitsPerSecond });
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

  /** Target bitrate by resolution — VP9/WebM on phone; sharp 720p, smaller files (1.2–3.5 Mbps). */
  function computeVideoBitrate(track) {
    const s = track?.getSettings?.() || {};
    const w = s.width || 1280;
    const h = s.height || 720;
    const fps = Math.min(Math.max(s.frameRate || 30, 24), 30);
    const megapixels = (w * h) / 1e6;
    let mbps;
    if (megapixels >= 2) mbps = 2.8;
    else if (megapixels >= 0.85) mbps = 2.0;
    else mbps = 1.4;
    if (fps >= 29) mbps *= 1.05;
    const bps = Math.round(mbps * 1_000_000);
    return Math.min(Math.max(bps, 1200000), 3500000);
  }

  function clearHud() {
    clearTimeout(hudTimer);
    hudTimer = null;
    const el = $('covertStatus');
    if (el) el.textContent = '';
  }

  /** Only "Recording" (auto-hide) and "Stopped" on the black screen. */
  function showBriefHud(text, autoHideMs) {
    const el = $('covertStatus');
    if (!el) return;
    clearTimeout(hudTimer);
    hudTimer = null;
    el.textContent = text;
    if (autoHideMs > 0) {
      hudTimer = setTimeout(clearHud, autoHideMs);
    }
  }

  function setPermissionError(text) {
    const el = $('covertPermissionError');
    if (el) el.textContent = text || '';
  }

  async function queryMediaPermissionState() {
    if (!navigator.permissions?.query) return { camera: 'unknown' };
    try {
      const cam = await navigator.permissions.query({ name: 'camera' }).catch(() => null);
      return { camera: cam?.state || 'unknown' };
    } catch {
      return { camera: 'unknown' };
    }
  }

  function describeMediaError(err, permState) {
    const name = err?.name || '';
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
      if (permState?.camera === 'denied') {
        return (
          'Camera is blocked for Toolbox — Android will not show a popup until you reset it. ' +
          'Chrome: ⋮ → Settings → Site settings → Camera → Allow for this site. ' +
          'Or Android Settings → Apps → Toolbox or Chrome → Permissions → allow Camera.'
        );
      }
      return (
        'Permission denied. If you never saw an Android popup, access was blocked earlier — reset site permissions ' +
        '(Chrome ⋮ → Site settings) or use Settings → Camera → permission help.'
      );
    }
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      return 'No camera found on this device.';
    }
    if (name === 'NotReadableError' || name === 'TrackStartError') {
      return 'Camera is in use by another app. Close it and tap Allow again.';
    }
    if (name === 'OverconstrainedError' || name === 'ConstraintNotSatisfiedError') {
      return 'Camera settings not supported — trying simpler mode…';
    }
    if (name === 'SecurityError') {
      return 'Camera blocked — open Toolbox from the home-screen app icon (HTTPS required).';
    }
    const msg = err?.message ? String(err.message).trim() : '';
    return msg ? `Camera error: ${msg}` : 'Camera unavailable — tap Allow to try again.';
  }

  function setBlackVisible(visible) {
    const black = $('covertBlack');
    if (black) black.classList.toggle('covert-camera__black--hidden', !visible);
    document.documentElement.style.backgroundColor = visible ? '#000' : '';
    const themeMeta = document.querySelector('meta[name="theme-color"]:not([media])');
    if (themeMeta) {
      if (visible) {
        themeMeta.content = '#000000';
      } else {
        const theme = document.documentElement.getAttribute('data-theme');
        themeMeta.content = theme === 'dark' ? '#171614' : '#ffffff';
      }
    }
  }

  async function enterCovertFullscreen() {
    const target = $('tab-camera') || $('covertCamera');
    if (!target?.requestFullscreen && !document.documentElement.requestFullscreen) return false;
    if (document.fullscreenElement) return true;
    try {
      await target.requestFullscreen({ navigationUI: 'hide' });
      usedFullscreenForOrientation = true;
      return true;
    } catch {
      try {
        await document.documentElement.requestFullscreen();
        usedFullscreenForOrientation = true;
        return true;
      } catch {}
    }
    return false;
  }

  function videoTrackIsLandscape(stream) {
    const track = stream?.getVideoTracks?.()[0];
    if (!track) return false;
    const s = track.getSettings?.() || {};
    return !!(s.width && s.height && s.width >= s.height);
  }

  async function prepareLandscapeCapture() {
    await enterCovertFullscreen();
    const locked = await lockLandscape();
    if (!locked) await enterCovertFullscreen();
    return locked;
  }

  function enterCovertMode() {
    const tab = $('tab-camera');
    tab?.classList.add('tab-panel--camera-active');
    $('covertCamera')?.classList.remove('covert-camera--session-off');
    closeClipViewer();
    document.documentElement.classList.add('toolbox-covert-active');
    document.querySelector('.app-shell')?.classList.add('app-shell--covert-camera');
    if (typeof window.toolboxSyncViewport === 'function') window.toolboxSyncViewport();
    setBlackVisible(true);
  }

  function exitFullscreenIfNeeded() {
    try {
      if (document.fullscreenElement) document.exitFullscreen();
    } catch {}
    usedFullscreenForOrientation = false;
  }

  function leaveCovertMode() {
    const tab = $('tab-camera');
    tab?.classList.remove('tab-panel--camera-active');
    document.documentElement.classList.remove('toolbox-covert-active');
    document.querySelector('.app-shell')?.classList.remove('app-shell--covert-camera');
    if (typeof window.toolboxSyncViewport === 'function') window.toolboxSyncViewport();
    document.documentElement.style.backgroundColor = '';
    setBlackVisible(false);
    hidePreview();
    showPermissionGate(false);
    setPermissionError('');
    exitFullscreenIfNeeded();
  }

  function forceExitCovertUi() {
    closeClipViewer();
    clearHud();
    hidePreview();
    swipeUpCount = 0;
    clearTimeout(swipeUpResetTimer);
    unlockLandscape();
    exitFullscreenIfNeeded();
    leaveCovertMode();
    $('covertCamera')?.classList.add('covert-camera--session-off');
  }

  function revokeClipPreviewUrls() {
    clipPreviewUrls.forEach((url) => URL.revokeObjectURL(url));
    clipPreviewUrls.clear();
  }

  function closeClipViewer() {
    const viewer = $('covertClipViewer');
    const video = $('covertClipViewerVideo');
    if (video) {
      video.pause();
      video.removeAttribute('src');
      video.load();
    }
    if (clipViewerUrl) {
      URL.revokeObjectURL(clipViewerUrl);
      clipViewerUrl = null;
    }
    viewer?.classList.add('hidden');
    viewer?.setAttribute('aria-hidden', 'true');
  }

  function applyClipViewerLayout(video) {
    if (!video) return;
    const stage = video.closest('.camera-clip-viewer__stage');
    const apply = () => {
      const w = video.videoWidth || 0;
      const h = video.videoHeight || 0;
      video.style.transform = '';
      if (stage) stage.classList.toggle('camera-clip-viewer__stage--rotated', !!(w && h && w < h));
      if (!w || !h) return;
      if (w < h) {
        showBriefHud('Clip saved portrait — showing rotated', 2200);
      }
    };
    if (video.readyState >= 1) apply();
    else video.addEventListener('loadedmetadata', apply, { once: true });
  }

  function openClipViewer(clip) {
    const viewer = $('covertClipViewer');
    const video = $('covertClipViewerVideo');
    if (!viewer || !video || !clip?.blob) return;
    closeClipViewer();
    clipViewerUrl = URL.createObjectURL(clip.blob);
    video.src = clipViewerUrl;
    applyClipViewerLayout(video);
    viewer.classList.remove('hidden');
    viewer.setAttribute('aria-hidden', 'false');
    video.play().catch(() => {});
    haptic('light');
  }

  function updateClipsHubActions() {
    const list = $('covertClipsList');
    const checks = list ? [...list.querySelectorAll('.camera-clip-card__check')] : [];
    const selected = checks.filter((c) => c.checked).length;
    const sendBtn = $('covertClipsSendBtn');
    const delBtn = $('covertClipsDeleteBtn');
    const selectAllBtn = $('covertClipsSelectAllBtn');
    if (sendBtn) sendBtn.disabled = selected === 0;
    if (delBtn) delBtn.disabled = selected === 0;
    if (selectAllBtn) {
      selectAllBtn.textContent =
        checks.length && selected === checks.length ? 'Clear selection' : 'Select all';
    }
  }

  function groupClipsByDay(clips) {
    const sorted = [...clips].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    const dayGroups = new Map();
    for (const clip of sorted) {
      const key = getClipDayKey(clip.createdAt);
      if (!dayGroups.has(key)) dayGroups.set(key, []);
      dayGroups.get(key).push(clip);
    }
    return dayGroups;
  }

  async function buildClipCard(clip) {
    const url = URL.createObjectURL(clip.blob);
    clipPreviewUrls.set(clip.id, url);
    let durationSec = clip.durationSeconds || 0;
    if (!durationSec) durationSec = await probeBlobDuration(clip.blob);
    if (
      Number.isFinite(clip.latitude) &&
      (!clip.locationLabel || String(clip.locationLabel).includes('°'))
    ) {
      const addr = await resolveClipAddress(clip.latitude, clip.longitude);
      if (addr) clip.locationLabel = addr;
    }
    const detailsLine = formatClipDetailsLine(clip, durationSec);
    const card = document.createElement('article');
    card.className = 'camera-clip-card';
    card.setAttribute('role', 'listitem');
    card.innerHTML = `
        <input type="checkbox" class="camera-clip-card__check" data-clip-id="${clip.id}" aria-label="Select clip ${clip.id}" />
        <div class="camera-clip-card__thumb">
          <video src="${url}" muted playsinline preload="metadata" aria-hidden="true"></video>
        </div>
        <div class="camera-clip-card__meta">
          <span class="camera-clip-card__id">${clip.id}</span>
          <span class="camera-clip-card__size">${formatBytes(clip.size || 0)}</span>
        </div>
        <p class="camera-clip-card__sub">${detailsLine}</p>
        <button type="button" class="camera-clip-card__play" data-clip-id="${clip.id}">View</button>`;

    const check = card.querySelector('.camera-clip-card__check');
    check?.addEventListener('change', () => updateClipsHubActions());

    card.querySelector('.camera-clip-card__play')?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openClipViewer(clip);
    });

    card.addEventListener('click', (e) => {
      if (e.target.closest('.camera-clip-card__play') || e.target.closest('.camera-clip-card__check')) return;
      if (check) {
        check.checked = !check.checked;
        updateClipsHubActions();
      }
    });

    return card;
  }

  const CLIP_DAY_NAV_ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 8h16v12H4z"/><path d="M9 12h6"/><path d="M12 8V4"/><path d="M8 4h8"/></svg>';

  async function renderClipFolderGrid(clips) {
    const list = $('covertClipsDayList');
    const summary = $('covertClipsSummary');
    if (!list) return;

    if (summary) {
      summary.textContent = `${clips.length} clip${clips.length === 1 ? '' : 's'} · ${formatBytes(
        clips.reduce((n, c) => n + (c.size || 0), 0)
      )}`;
    }

    if (!clips.length) {
      let storageHint = '';
      try {
        const raw = await getAllClipRecordsRaw();
        if (raw.length > 0) {
          storageHint =
            '<p class="card-sub">Toolbox still has data in local storage but these clips could not be loaded (often after reinstalling the app, clearing Chrome site data, or very low storage). Use Download to device on important clips after each session.</p>';
        }
      } catch {}
      list.innerHTML = `
        <div class="camera-hub-block" role="listitem">
          <h2 class="settings-section-title">Days</h2>
          <div class="settings-group">
            <div class="camera-clips-card__empty camera-clips-card__empty--hub">
              <p><strong>No clips yet</strong></p>
              <p class="card-sub">Tap Covert Camera to record. Swipe up twice when finished to open that day.</p>
              ${storageHint}
            </div>
          </div>
        </div>`;
      return;
    }

    const dayGroups = groupClipsByDay(clips);
    list.innerHTML = '';

    for (const [dayKey, dayClips] of dayGroups) {
      const newest = dayClips[0];
      const dayBytes = dayClips.reduce((n, c) => n + (c.size || 0), 0);
      const sectionTitle = formatClipDayHeading(newest.createdAt);
      const rowLabel = formatClipDayShort(newest.createdAt);
      const meta = `${dayClips.length} clip${dayClips.length === 1 ? '' : 's'} · ${formatBytes(dayBytes)}`;

      const block = document.createElement('div');
      block.className = 'camera-hub-block';
      block.setAttribute('role', 'listitem');

      const title = document.createElement('h2');
      title.className = 'settings-section-title';
      title.textContent = sectionTitle;

      const group = document.createElement('div');
      group.className = 'settings-group';

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'settings-row settings-row--nav';
      btn.dataset.cameraPushDay = dayKey;
      btn.setAttribute(
        'aria-label',
        `${sectionTitle}, ${meta}. Open clips for this day.`
      );
      btn.innerHTML = `
        <span class="settings-row__icon" aria-hidden="true">${CLIP_DAY_NAV_ICON}</span>
        <span class="settings-row__label">${rowLabel}</span>
        <span class="settings-row__meta">${meta}</span>
        <span class="settings-row__chevron" aria-hidden="true">›</span>`;

      group.appendChild(btn);
      block.appendChild(title);
      block.appendChild(group);
      list.appendChild(block);
    }
  }

  async function renderClipDayView(dayKey) {
    const list = $('covertClipsList');
    const titleEl = $('covertClipsDayTitle');
    const daySummary = $('covertClipsDaySummary');
    if (!list || !dayKey) return;

    const clips = await getAllClips();
    const dayClips = clips
      .filter((c) => getClipDayKey(c.createdAt) === dayKey)
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

    if (titleEl) {
      titleEl.textContent = dayClips[0]
        ? formatClipDayHeading(dayClips[0].createdAt)
        : formatClipDayHeading(Date.parse(`${dayKey}T12:00:00`));
    }
    if (daySummary) {
      daySummary.textContent = `${dayClips.length} clip${dayClips.length === 1 ? '' : 's'} · ${formatBytes(
        dayClips.reduce((n, c) => n + (c.size || 0), 0)
      )}`;
    }

    list.innerHTML = '';
    if (!dayClips.length) {
      list.innerHTML = `
        <div class="camera-clips-card__empty" style="grid-column:1/-1">
          <p><strong>No clips for this day</strong></p>
          <p class="card-sub">This folder is empty. Go back to choose another day.</p>
        </div>`;
      updateClipsHubActions();
      return;
    }

    for (const clip of dayClips) {
      list.appendChild(await buildClipCard(clip));
    }
    updateClipsHubActions();
  }

  async function renderClipsLibrary() {
    const activeId = getActiveCameraScreenId();
    const dayKey = getClipDayKeyFromScreen(activeId);

    revokeClipPreviewUrls();
    const clips = await getAllClips();

    if (dayKey) {
      await renderClipDayView(dayKey);
    } else {
      await renderClipFolderGrid(clips);
      updateClipsHubActions();
    }

    await refreshClipSummary();
  }

  function navigateToClipLibrary(openDayKey) {
    cameraSessionActive = false;
    leaveCovertMode();
    $('covertCamera')?.classList.add('covert-camera--session-off');
    cameraNavStack = ['root', 'clip-library'];
    if (openDayKey) cameraNavStack.push(`clip-day:${openDayKey}`);
    paintCameraScreens();
    scrollCameraTabToTop();
  }

  function showClipsHub(openDayKey) {
    navigateToClipLibrary(openDayKey || null);
  }

  function showCameraHubRoot() {
    cameraSessionActive = false;
    leaveCovertMode();
    $('covertCamera')?.classList.add('covert-camera--session-off');
    resetCameraNav('root');
  }

  function openCameraSession() {
    cameraSessionActive = true;
    $('covertCamera')?.classList.remove('covert-camera--session-off');
    paintCameraScreens();
    closeClipViewer();
    enterCovertMode();
    hidePreview();
    clearHud();
    /* Fullscreen waits until camera permission — avoids corner ::backdrop leak on the gate. */
  }

  async function exitCovertToNewestClipDay() {
    if (isRecording) return;
    userClosedSession = true;
    stopCameraStream();
    releaseWakeLock();
    clearHud();
    swipeUpCount = 0;
    clearTimeout(swipeUpResetTimer);
    hidePreview();
    unlockLandscape();
    const clips = await getAllClips();
    const newest = [...clips].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0];
    const dayKey = newest ? getClipDayKey(newest.createdAt) : null;
    navigateToClipLibrary(dayKey);
    haptic('light');
  }

  function closeCameraSession() {
    if (isRecording) return;
    userClosedSession = true;
    cameraSessionActive = false;
    stopCameraStream();
    releaseWakeLock();
    clearHud();
    swipeUpCount = 0;
    clearTimeout(swipeUpResetTimer);
    hidePreview();
    unlockLandscape();
    showCameraHubRoot();
    haptic('light');
  }

  function getSelectedClipIds() {
    const list = $('covertClipsList');
    if (!list) return [];
    return [...list.querySelectorAll('.camera-clip-card__check:checked')].map((el) => el.dataset.clipId);
  }

  function showPermissionGate(show) {
    $('covertPermissionGate')?.classList.toggle('hidden', !show);
    $('covertCamera')?.classList.toggle('covert-camera--gate-open', !!show);
  }

  function setPreviewVisible(visible) {
    previewVisible = visible;
    const root = $('covertCamera');
    if (root) root.classList.toggle('covert-camera--preview', visible);
    if (visible) haptic('light');
  }

  function hidePreview() {
    setPreviewVisible(false);
  }

  function showPreview() {
    setPreviewVisible(true);
  }

  async function acquireWakeLock() {
    if (!getPrefs().wakeLock || !('wakeLock' in navigator)) return;
    try {
      wakeLockSentinel = await navigator.wakeLock.request('screen');
    } catch {}
  }

  async function releaseWakeLock() {
    try {
      await wakeLockSentinel?.release();
    } catch {}
    wakeLockSentinel = null;
  }

  function getLandscapeVideoConstraints() {
    return {
      facingMode: { ideal: 'environment' },
      width: { ideal: 1280, min: 640 },
      height: { ideal: 720, min: 360 },
      aspectRatio: { ideal: 16 / 9 },
      frameRate: { ideal: 30, max: 30 },
    };
  }

  async function lockLandscape() {
    if (!cameraSessionActive) return false;
    const orient = screen.orientation;
    const lockTypes = ['landscape', 'landscape-primary', 'landscape-secondary'];

    const tryLock = async () => {
      if (!orient?.lock) return false;
      for (const type of lockTypes) {
        try {
          await orient.lock(type);
          return true;
        } catch {}
      }
      return false;
    };

    if (await tryLock()) {
      startOrientationWatch();
      return true;
    }
    return false;
  }

  function startOrientationWatch() {
    if (orientationWatchHandler || !screen.orientation?.addEventListener) return;
    orientationWatchHandler = () => {
      if (!cameraSessionActive) return;
      const type = screen.orientation?.type || '';
      if (type.startsWith('portrait')) lockLandscape();
    };
    screen.orientation.addEventListener('change', orientationWatchHandler);
  }

  function unlockLandscape() {
    if (orientationWatchHandler && screen.orientation?.removeEventListener) {
      screen.orientation.removeEventListener('change', orientationWatchHandler);
      orientationWatchHandler = null;
    }
    try {
      screen.orientation?.unlock?.();
    } catch {}
    exitFullscreenIfNeeded();
  }

  async function enforceLandscapeVideoTrack(stream) {
    const track = stream?.getVideoTracks?.()[0];
    if (!track?.applyConstraints) return;
    const settings = track.getSettings?.() || {};
    if (settings.width && settings.height && settings.width >= settings.height) return;
    const landscape = getLandscapeVideoConstraints();
    try {
      await track.applyConstraints(landscape);
    } catch {
      try {
        await track.applyConstraints({
          width: { ideal: 1280 },
          height: { ideal: 720 },
          aspectRatio: { ideal: 16 / 9 },
          frameRate: { ideal: 30, max: 30 },
        });
      } catch {
        try {
          await track.applyConstraints({
            width: { ideal: 960 },
            height: { ideal: 540 },
            frameRate: { ideal: 30, max: 30 },
          });
        } catch {}
      }
    }
  }

  async function tryGetUserMediaCascade() {
    const landscape = getLandscapeVideoConstraints();
    // Video-only only — clips never include audio.
    const attempts = [
      { video: landscape, audio: false },
      {
        video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } },
        audio: false,
      },
      { video: { facingMode: 'environment' }, audio: false },
      { video: { facingMode: { ideal: 'environment' } }, audio: false },
      { video: true, audio: false },
    ];

    let lastErr = null;
    let stream = null;
    for (const constraints of attempts) {
      try {
        stream = await navigator.mediaDevices.getUserMedia(constraints);
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
      }
    }
    if (!stream) throw lastErr || new Error('getUserMedia failed');
    stream.getAudioTracks().forEach((t) => {
      t.stop();
      try {
        stream.removeTrack(t);
      } catch {}
    });
    await enforceLandscapeVideoTrack(stream);
    return stream;
  }

  function streamIsLive() {
    return mediaStream?.getTracks().some((t) => t.readyState === 'live') ?? false;
  }

  async function startCameraStream(forceRetry) {
    if (mediaStream && streamIsLive() && !forceRetry) return true;

    stopCameraStream();
    setPermissionError('');

    if (!window.isSecureContext) {
      showPermissionGate(true);
      clearHud();
      setPermissionError('Open Toolbox from the installed app icon (HTTPS required).');
      return false;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      showPermissionGate(true);
      clearHud();
      setPermissionError('Camera not available in this browser.');
      return false;
    }

    clearHud();

    try {
      mediaStream = await tryGetUserMediaCascade();
    } catch (err) {
      showPermissionGate(true);
      const permState = await queryMediaPermissionState();
      setPermissionError(describeMediaError(err, permState));
      clearHud();
      return false;
    }

    showPermissionGate(false);
    setPermissionError('');
    clearHud();
    openCameraSession();
    await prepareLandscapeCapture();
    await enforceLandscapeVideoTrack(mediaStream);
    if (!videoTrackIsLandscape(mediaStream)) {
      await prepareLandscapeCapture();
      await enforceLandscapeVideoTrack(mediaStream);
    }
    if (!videoTrackIsLandscape(mediaStream)) {
      showBriefHud('Hold phone sideways for landscape', 3500);
    }

    const video = $('covertVideoPreview');
    if (video) {
      video.setAttribute('playsinline', '');
      video.setAttribute('webkit-playsinline', '');
      video.muted = true;
      video.srcObject = mediaStream;
      try {
        await video.play();
      } catch {
        await video.play().catch(() => {});
      }
    }

    return true;
  }

  function requestCameraAccess() {
    if (allowInFlight) return Promise.resolve(false);
    allowInFlight = true;

    const allowBtn = $('covertAllowCameraBtn');
    setPermissionError('');
    if (allowBtn) {
      allowBtn.disabled = true;
      allowBtn.textContent = 'Requesting…';
    }
    haptic('light');
    clearHud();

    // Start getUserMedia in this same tap (do not await anything before the cascade).
    return startCameraStream(true).then((ok) => ok)
      .finally(() => {
        allowInFlight = false;
        if (allowBtn) {
          allowBtn.disabled = false;
          allowBtn.textContent = 'Allow camera access';
        }
      });
  }

  function stopCameraStream() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      try {
        mediaRecorder.stop();
      } catch {}
    }
    cleanupTimestampPipeline();
    mediaStream?.getTracks().forEach((t) => t.stop());
    mediaStream = null;
    const video = $('covertVideoPreview');
    if (video) video.srcObject = null;
  }

  function clearMaxClipTimer() {
    if (maxClipTimer) {
      clearTimeout(maxClipTimer);
      maxClipTimer = null;
    }
  }

  async function startRecording() {
    if (isRecording || !mediaStream) return;
    if (!probePreferredMimeType()) {
      haptic('medium');
      return;
    }
    recordedChunks = [];
    cleanupTimestampPipeline();
    // Default path is the raw stream (unchanged). Only when the stamp is enabled do we route
    // through a canvas; if that fails for any reason we fall back so recording never breaks.
    let recordStream = mediaStream;
    if (getPrefs().timestampEnabled) {
      const stamped = await buildTimestampedStream(mediaStream);
      if (stamped) recordStream = stamped;
      else cleanupTimestampPipeline();
    }

    // Resource snapshot for the start warning (we warn but still record).
    const freeBytes = await getFreeStorageBytes();
    const lowStorage = freeBytes != null && freeBytes < LOW_STORAGE_BYTES;
    const lowBattery = batteryIsLow();
    const criticalBattery = batteryIsCritical();

    const videoBitsPerSecond = computeVideoBitrate(mediaStream.getVideoTracks?.()[0]);
    mediaRecorder = createMediaRecorder(recordStream, videoBitsPerSecond);
    if (!mediaRecorder) {
      haptic('medium');
      return;
    }
    const mimeType = mediaRecorder.mimeType || lastRecordingMimeType || probePreferredMimeType();

    recordingStartedAt = Date.now();
    recordingGeo = null;
    autoStopReason = '';
    currentRecordingId = nextClipId();
    currentChunkSeq = 0;
    // Crash-safe marker so an interrupted clip can be rescued on next launch.
    putClipRecord({
      id: currentRecordingId,
      status: 'recording',
      createdAt: recordingStartedAt,
      mimeType,
      size: 0,
      durationSeconds: 0,
      latitude: undefined,
      longitude: undefined,
      locationLabel: '',
    }).catch(() => {});

    mediaRecorder.ondataavailable = (e) => {
      if (!e.data || e.data.size <= 0) return;
      recordedChunks.push(e.data);
      const id = currentRecordingId;
      const seq = currentChunkSeq++;
      if (id != null) {
        // Best-effort crash backup of each ~1s chunk. A failed backup write must NEVER stop
        // the live recording — the full clip is still in memory and saved on stop. Genuine
        // out-of-space is handled by the periodic storage watch instead.
        appendChunk(id, seq, e.data).catch(() => {});
      }
    };

    mediaRecorder.onstop = async () => {
      clearMaxClipTimer();
      cleanupTimestampPipeline();
      stopResourceWatch();
      await releaseWakeLock();
      const finishedId = currentRecordingId;
      const blob = new Blob(recordedChunks, { type: mediaRecorder.mimeType || mimeType });
      recordedChunks = [];
      isRecording = false;
      $('covertCamera')?.classList.remove('covert-camera--recording');
      setBlackVisible(true);
      hidePreview();
      if (blob.size < 1000) {
        if (finishedId != null) deleteClips([finishedId]).catch(() => {});
        clearChunkStore().catch(() => {});
        currentRecordingId = null;
        autoStopReason = '';
        showBriefHud('Stopped', HUD_RECORDING_MS);
        haptic('medium');
        return;
      }
      try {
        const durationSeconds = Math.max(
          1,
          Math.round((Date.now() - (recordingStartedAt || Date.now())) / 1000)
        );
        let locationLabel = recordingGeo?.locationLabel || '';
        if (recordingGeo && !locationLabel) {
          locationLabel = await resolveClipAddress(recordingGeo.lat, recordingGeo.lng);
        }
        // Free the on-disk chunk backup BEFORE writing the final clip so we never need 2x space
        // (the full clip is already assembled in memory at this point).
        await clearChunkStore().catch(() => {});
        await finalizeClip(finishedId != null ? finishedId : nextClipId(), blob, mediaRecorder.mimeType || mimeType, {
          durationSeconds,
          recordedAt: recordingStartedAt || Date.now(),
          latitude: recordingGeo?.lat,
          longitude: recordingGeo?.lng,
          locationLabel,
        });
        currentRecordingId = null;
        recordingStartedAt = 0;
        recordingGeo = null;
        showBriefHud(autoStopReason || 'Stopped', HUD_RECORDING_MS);
        autoStopReason = '';
        if (getPrefs().strongHapticOnRecord) haptic('success');
        else haptic('medium');
        await refreshClipSummary();
        if (isClipLibraryScreen(getActiveCameraScreenId())) void renderClipsLibrary();
      } catch {
        showBriefHud('Stopped', HUD_RECORDING_MS);
        haptic('medium');
      }
    };

    captureRecordingGeo().then((geo) => {
      if (!geo) return;
      recordingGeo = geo;
      const id = currentRecordingId;
      if (id == null) return;
      // Stamp geo onto the crash marker so a recovered clip keeps its location.
      getClipRecord(id)
        .then((rec) => {
          if (rec && rec.status === 'recording') {
            rec.latitude = geo.lat;
            rec.longitude = geo.lng;
            rec.locationLabel = geo.locationLabel || '';
            putClipRecord(rec).catch(() => {});
          }
        })
        .catch(() => {});
    });

    mediaRecorder.start(1000);
    isRecording = true;
    $('covertCamera')?.classList.add('covert-camera--recording');
    setBlackVisible(true);
    hidePreview();
    // Confirm the instant recording starts — don't let landscape/timestamp setup delay the buzz.
    const warnings = [];
    if (lowStorage) warnings.push('low storage');
    if (criticalBattery) warnings.push('battery critical');
    else if (lowBattery) warnings.push('low battery');
    const recordingHudText = warnings.length ? `Recording · ${warnings.join(' & ')}` : 'Recording';
    showBriefHud(recordingHudText, HUD_RECORDING_MS);
    if (getPrefs().strongHapticOnRecord) haptic('success');
    else haptic('medium');
    startResourceWatch();
    await acquireWakeLock();
    await prepareLandscapeCapture();
    await enforceLandscapeVideoTrack(mediaStream);
    // Re-assert after fullscreen/orientation work, then let it auto-hide after a few seconds.
    if (isRecording) showBriefHud(recordingHudText, HUD_RECORDING_MS);

    const mins = getPrefs().maxClipMinutes;
    if (mins > 0) {
      clearMaxClipTimer();
      maxClipTimer = setTimeout(() => {
        if (isRecording) stopRecording();
      }, mins * 60 * 1000);
    }
  }

  function stopRecording() {
    if (!isRecording || !mediaRecorder) return;
    try {
      if (mediaRecorder.state !== 'inactive') mediaRecorder.stop();
    } catch {}
    showBriefHud('Stopped', HUD_RECORDING_MS);
  }

  function onTripleTap() {
    if (isRecording) {
      // Don't let a duplicated/echoed tap kill a recording the instant it begins.
      if (recordingStartedAt && Date.now() - recordingStartedAt < MIN_RECORD_MS) return;
      stopRecording();
    } else {
      startRecording();
    }
  }

  function onTapZone() {
    if ($('covertCamera')?.classList.contains('covert-camera--gate-open')) return;
    haptic('tap');
    tapCount += 1;
    clearTimeout(tapResetTimer);
    tapResetTimer = setTimeout(() => {
      tapCount = 0;
    }, TAP_RESET_MS);
    if (tapCount >= TAP_REQUIRED) {
      tapCount = 0;
      clearTimeout(tapResetTimer);
      haptic('medium');
      onTripleTap();
    }
  }

  function onTouchStart(e) {
    if (e.touches.length !== 1) return;
    swipeStartY = e.touches[0].clientY;
  }

  function onTouchEnd(e) {
    if ($('covertCamera')?.classList.contains('covert-camera--gate-open')) return;
    if (swipeStartY == null || !e.changedTouches.length) return;
    const dy = swipeStartY - e.changedTouches[0].clientY;
    swipeStartY = null;
    if (dy > SWIPE_THRESHOLD) {
      if (!cameraSessionActive) return;
      // While recording, swipe up only peeks at the live feed (no exit-to-clips gesture).
      if (isRecording) {
        showPreview();
        return;
      }
      swipeUpCount += 1;
      clearTimeout(swipeUpResetTimer);
      swipeUpResetTimer = setTimeout(() => {
        swipeUpCount = 0;
      }, SWIPE_UP_RESET_MS);
      if (swipeUpCount === 1) showPreview();
      if (swipeUpCount >= SWIPE_CLOSE_REQUIRED) {
        swipeUpCount = 0;
        clearTimeout(swipeUpResetTimer);
        void exitCovertToNewestClipDay();
      }
      return;
    }
    if (dy < -SWIPE_THRESHOLD) {
      swipeUpCount = 0;
      clearTimeout(swipeUpResetTimer);
      hidePreview();
    }
  }

  async function refreshClipSummary() {
    const summary = await getStorageSummary();
    const countEl = $('covertClipCount');
    const sizeEl = $('covertClipSize');
    if (countEl) countEl.textContent = String(summary.count);
    if (sizeEl) sizeEl.textContent = formatBytes(summary.bytes);
    const uploadBtn = $('covertUploadBtn');
    if (uploadBtn) uploadBtn.disabled = summary.count === 0;
    const navMeta = $('covertClipsNavMeta');
    if (navMeta) {
      navMeta.textContent = `${summary.count} clip${summary.count === 1 ? '' : 's'}`;
    }
    const listSummary = $('covertClipsSummary');
    if (listSummary) {
      listSummary.textContent = `${summary.count} clip${summary.count === 1 ? '' : 's'} · ${formatBytes(summary.bytes)}`;
    }
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
    return `covert_${stamp}${geo}`;
  }

  /** Sidecar text so other software / an investigator can read time + GPS for the clip. */
  function buildClipSidecar(clip, videoFileName) {
    const d = new Date(clip.createdAt || Date.now());
    const lines = [
      'Investigator Toolbox — Covert Clip',
      `File: ${videoFileName}`,
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

  async function uploadClips(clipIds) {
    let clips = await getAllClips();
    if (clipIds?.length) {
      const set = new Set(clipIds);
      clips = clips.filter((c) => set.has(c.id));
    }
    if (!clips.length) return;
    haptic('light');
    const ext = (mime) => (mime && mime.includes('mp4') ? '.mp4' : '.webm');
    const files = [];
    clips.forEach((c) => {
      const videoName = `${buildClipBaseName(c)}${ext(c.mimeType)}`;
      files.push(new File([c.blob], videoName, { type: c.blob.type || 'video/webm' }));
      files.push(new File([buildClipSidecar(c, videoName)], `${buildClipBaseName(c)}.txt`, { type: 'text/plain' }));
    });
    if (navigator.share && navigator.canShare?.({ files })) {
      try {
        await navigator.share({
          files,
          title: 'Toolbox clips',
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

  async function refreshCameraPermissionUi() {
    const targets = document.querySelectorAll('[data-cam-permission-status]');
    if (!targets.length) return;
    let text = 'Use Camera tab — Android will ask for camera permission.';
    if (navigator.permissions?.query) {
      try {
        const cam = await navigator.permissions.query({ name: 'camera' });
        text = `Camera: ${cam.state}`;
      } catch {
        text = 'Permission status unavailable — open Camera tab to grant access.';
      }
    }
    targets.forEach((el) => {
      el.textContent = text;
    });
  }

  function bindSettings() {
    if (window.__cameraSettingsBound) return;
    window.__cameraSettingsBound = true;

    document.querySelectorAll('[data-cam-action="perm-help"]').forEach((btn) => {
      btn.addEventListener('click', () => {
        haptic('light');
        window.alert(
          'Android: Settings → Apps → Toolbox (or Chrome) → Permissions → Camera → Allow.\n\n' +
            'Chrome: ⋮ → Settings → Site settings → Camera → Allow for this site.'
        );
      });
    });

    document.querySelectorAll('[data-cam-pref="wakeLock"]').forEach((input) => {
      input.addEventListener('change', (e) => {
        const prefs = getPrefs();
        prefs.wakeLock = e.target.checked;
        savePrefs(prefs);
        syncCameraSettingsUi();
        haptic('light');
      });
    });

    document.querySelectorAll('[data-cam-pref="strongHapticOnRecord"]').forEach((input) => {
      input.addEventListener('change', (e) => {
        const prefs = getPrefs();
        prefs.strongHapticOnRecord = e.target.checked;
        savePrefs(prefs);
        syncCameraSettingsUi();
        haptic('light');
      });
    });

    ['timestampEnabled', 'timestampClock24'].forEach((key) => {
      document.querySelectorAll(`[data-cam-pref="${key}"]`).forEach((input) => {
        input.addEventListener('change', (e) => {
          const prefs = getPrefs();
          prefs[key] = e.target.checked;
          savePrefs(prefs);
          syncCameraSettingsUi();
          haptic('light');
        });
      });
    });

    document.querySelectorAll('[data-cam-select]').forEach((select) => {
      select.addEventListener('change', (e) => {
        const key = e.target.getAttribute('data-cam-select');
        if (!key) return;
        const prefs = getPrefs();
        prefs[key] = e.target.value;
        savePrefs(prefs);
        syncCameraSettingsUi();
        haptic('light');
      });
    });

    document.querySelectorAll('[data-cam-max-minutes]').forEach((select) => {
      select.addEventListener('change', (e) => {
        const prefs = getPrefs();
        prefs.maxClipMinutes = parseInt(e.target.value, 10) || 0;
        savePrefs(prefs);
        syncCameraSettingsUi();
        haptic('light');
      });
    });

    document.querySelectorAll('[data-cam-action="clear-all"]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!window.confirm('Delete all covert clips saved in Toolbox on this device?')) return;
        await clearAllClips();
        await refreshClipSummary();
        await renderClipsLibrary();
        refreshCameraSettingsUi();
        haptic('medium');
      });
    });

    document.querySelectorAll('[data-cam-action="upload-all"]').forEach((btn) => {
      btn.addEventListener('click', () => uploadClips());
    });
  }

  function syncCameraSettingsUi() {
    const prefs = getPrefs();
    document.querySelectorAll('[data-cam-pref="wakeLock"]').forEach((input) => {
      input.checked = !!prefs.wakeLock;
      if (typeof window.syncToggleStateLabel === 'function') window.syncToggleStateLabel(input);
    });
    document.querySelectorAll('[data-cam-pref="strongHapticOnRecord"]').forEach((input) => {
      input.checked = !!prefs.strongHapticOnRecord;
      if (typeof window.syncToggleStateLabel === 'function') window.syncToggleStateLabel(input);
    });
    document.querySelectorAll('[data-cam-max-minutes]').forEach((select) => {
      select.value = String(prefs.maxClipMinutes ?? 10);
      syncPickerLabel(select);
    });
    [
      ['timestampEnabled', !!prefs.timestampEnabled],
      ['timestampClock24', prefs.timestampClock24 !== false],
    ].forEach(([key, checked]) => {
      document.querySelectorAll(`[data-cam-pref="${key}"]`).forEach((input) => {
        input.checked = checked;
        if (typeof window.syncToggleStateLabel === 'function') window.syncToggleStateLabel(input);
      });
    });
    document.querySelectorAll('[data-cam-select]').forEach((select) => {
      const key = select.getAttribute('data-cam-select');
      if (key && prefs[key] != null) select.value = String(prefs[key]);
      syncPickerLabel(select);
    });
  }

  // Keep the custom picker button label (shared app dropdown component) in sync with the
  // hidden <select> value whenever prefs are applied programmatically.
  function syncPickerLabel(select) {
    if (!select) return;
    const wrap = select.closest('.menu-wrap');
    if (!wrap) return;
    const labelSpan = wrap.querySelector('.city-btn span');
    const option = select.options[select.selectedIndex];
    if (labelSpan && option) labelSpan.textContent = option.textContent.trim();
  }

  async function refreshCameraSettingsUi() {
    syncCameraSettingsUi();
    await refreshCameraPermissionUi();
    refreshRecordingFormatUi();
    const summary = await getStorageSummary();
    const free = await getFreeStorageBytes();
    const freeText = free != null ? ` · ${formatBytes(free)} free on device` : '';
    const storageText =
      `${summary.count} clip(s) · ${formatBytes(summary.bytes)} used${freeText} — view & download in Clip Library.`;
    document.querySelectorAll('[data-cam-storage-summary]').forEach((el) => {
      el.textContent = storageText;
    });
  }

  function bindUi() {
    if (window.__covertCameraUiBound) return;
    window.__covertCameraUiBound = true;
    bindCameraNav();

    const zone = $('covertTapZone');
    zone?.addEventListener('click', onTapZone);
    zone?.addEventListener('touchstart', onTouchStart, { passive: true });
    zone?.addEventListener('touchend', onTouchEnd, { passive: true });

    const allowBtn = $('covertAllowCameraBtn');
    allowBtn?.addEventListener(
      'pointerdown',
      (e) => {
        e.preventDefault();
        requestCameraAccess();
      },
      { capture: true }
    );

    $('covertCloseGateBtn')?.addEventListener('click', () => {
      haptic('light');
      closeCameraSession();
    });

    $('covertOpenCameraBtn')?.addEventListener('click', () => {
      haptic('light');
      userClosedSession = false;
      cameraSessionActive = true;
      resumeCameraSession();
    });

    $('covertClipsSelectAllBtn')?.addEventListener('click', () => {
      const list = $('covertClipsList');
      const checks = list ? [...list.querySelectorAll('.camera-clip-card__check')] : [];
      if (!checks.length) return;
      const allOn = checks.every((c) => c.checked);
      checks.forEach((c) => {
        c.checked = !allOn;
      });
      updateClipsHubActions();
      haptic('light');
    });

    $('covertClipsSendBtn')?.addEventListener('click', () => {
      const ids = getSelectedClipIds();
      if (!ids.length) return;
      uploadClips(ids);
    });

    $('covertClipsDeleteBtn')?.addEventListener('click', async () => {
      const ids = getSelectedClipIds();
      if (!ids.length) return;
      if (!window.confirm(`Delete ${ids.length} clip(s) from this device?`)) return;
      await deleteClips(ids);
      haptic('medium');
      await renderClipsLibrary();
      refreshCameraSettingsUi();
    });

    $('covertClipViewerClose')?.addEventListener('click', () => {
      closeClipViewer();
      haptic('light');
    });

    $('covertClipViewer')?.addEventListener('click', (e) => {
      if (e.target === $('covertClipViewer')) closeClipViewer();
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

    // Saved clips first — only enter live/fullscreen after "Open camera" (cameraSessionActive).
    if (!cameraSessionActive) {
      showCameraHubRoot();
      return;
    }

    resumeCameraSession();
  }

  function resumeCameraSession() {
    openCameraSession();
    if (streamIsLive()) {
      showPermissionGate(false);
      clearHud();
      void prepareLandscapeCapture();
      return;
    }
    showPermissionGate(true);
    setPermissionError('');
    clearHud();
  }

  function onTabLeave() {
    if (isRecording) stopRecording();
    stopCameraStream();
    releaseWakeLock();
    cameraSessionActive = false;
    forceExitCovertUi();
    revokeClipPreviewUrls();
    resetCameraNav('root');
  }

  async function init() {
    bindUi();
    bindSettings();
    void requestPersistentStorage();
    void initBattery();
    const rescue = await rescueClipStorage().catch(() => ({ rescued: 0 }));
    if (rescue.rescued > 0) {
      refreshClipSummary().catch(() => {});
      void renderClipsLibrary();
    } else {
      refreshClipSummary().catch(() => {});
    }
  }

  window.ToolboxCovertCamera = {
    init,
    onTabEnter,
    onTabLeave,
    requestCameraAccess,
    openCameraSession,
    closeCameraSession,
    refreshCameraSettingsUi,
    refreshClipSummary,
    renderClipsLibrary,
    showClipsHub,
    showCameraHubRoot,
    pushCameraScreen,
    popCameraScreen,
    resetCameraNav,
    forceExitCovertUi,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
