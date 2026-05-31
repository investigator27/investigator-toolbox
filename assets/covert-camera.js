/**
 * Toolbox — Covert camera (landscape 1080p, rear only, in-app storage).
 */
(function () {
  const DB_NAME = 'toolbox-covert';
  const DB_VERSION = 1;
  const STORE = 'clips';
  const PREFS_KEY = 'toolboxCameraPrefs';
  const INDEX_KEY = 'toolboxCovertClipIndex';
  const TAP_REQUIRED = 3;
  const TAP_RESET_MS = 700;
  const SWIPE_CLOSE_REQUIRED = 2;
  const SWIPE_THRESHOLD = 48;
  const SWIPE_UP_RESET_MS = 1200;
  const HUD_RECORDING_MS = 5000;

  const defaultPrefs = {
    wakeLock: true,
    maxClipMinutes: 10,
    strongHapticOnRecord: true,
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
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  async function saveClip(blob, mimeType, meta) {
    const id = nextClipId();
    const m = meta || {};
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put({
        id,
        blob,
        mimeType: mimeType || blob.type,
        createdAt: m.recordedAt || Date.now(),
        size: blob.size,
        durationSeconds: m.durationSeconds || 0,
        latitude: m.latitude,
        longitude: m.longitude,
        locationLabel: m.locationLabel || '',
      });
      tx.oncomplete = () => resolve(id);
      tx.onerror = () => reject(tx.error);
    });
  }

  async function getAllClips() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => {
        const list = (req.result || []).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
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

  function pickMimeType() {
    if (typeof MediaRecorder === 'undefined') return '';
    const candidates = [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
      'video/mp4',
    ];
    return candidates.find((t) => MediaRecorder.isTypeSupported(t)) || '';
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
    if (!navigator.permissions?.query) return { camera: 'unknown', microphone: 'unknown' };
    try {
      const [cam, mic] = await Promise.all([
        navigator.permissions.query({ name: 'camera' }).catch(() => null),
        navigator.permissions.query({ name: 'microphone' }).catch(() => null),
      ]);
      return {
        camera: cam?.state || 'unknown',
        microphone: mic?.state || 'unknown',
      };
    } catch {
      return { camera: 'unknown', microphone: 'unknown' };
    }
  }

  function describeMediaError(err, permState) {
    const name = err?.name || '';
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
      const camBlocked = permState?.camera === 'denied';
      const micBlocked = permState?.microphone === 'denied';
      if (camBlocked || micBlocked) {
        return (
          'Camera or microphone is blocked for Toolbox — Android will not show a popup until you reset it. ' +
          'Chrome: ⋮ → Settings → Site settings → Camera (and Microphone) → Allow for this site. ' +
          'Or Android Settings → Apps → Toolbox or Chrome → Permissions → allow Camera and Microphone.'
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
    if (themeMeta) themeMeta.content = visible ? '#000000' : '';
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
    $('covertClipsHub')?.classList.add('hidden');
    closeClipViewer();
    document.documentElement.classList.add('toolbox-covert-active');
    document.querySelector('.app-shell')?.classList.add('app-shell--covert-camera');
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

  async function renderClipsLibrary() {
    const list = $('covertClipsList');
    const summary = $('covertClipsSummary');
    if (!list) return;

    revokeClipPreviewUrls();
    const clips = await getAllClips();
    if (summary) {
      summary.textContent = `${clips.length} clip${clips.length === 1 ? '' : 's'} · ${formatBytes(
        clips.reduce((n, c) => n + (c.size || 0), 0)
      )}`;
    }

    if (!clips.length) {
      list.innerHTML = `
        <div class="camera-clips-card__empty">
          <p><strong>No clips yet</strong></p>
          <p class="card-sub">Open Camera to record. Swipe up twice when finished to manage clips here.</p>
        </div>`;
      updateClipsHubActions();
      await refreshClipSummary();
      return;
    }

    list.innerHTML = '';
    for (const clip of clips) {
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

      list.appendChild(card);
    }

    updateClipsHubActions();
    await refreshClipSummary();
  }

  function showClipsHub() {
    cameraSessionActive = false;
    leaveCovertMode();
    $('covertCamera')?.classList.add('covert-camera--session-off');
    $('covertClipsHub')?.classList.remove('hidden');
    renderClipsLibrary();
  }

  function openCameraSession() {
    cameraSessionActive = true;
    $('covertCamera')?.classList.remove('covert-camera--session-off');
    $('covertClipsHub')?.classList.add('hidden');
    closeClipViewer();
    enterCovertMode();
    hidePreview();
    clearHud();
    void prepareLandscapeCapture();
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
    showClipsHub();
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
      width: { ideal: 1920, min: 640 },
      height: { ideal: 1080, min: 360 },
      aspectRatio: { ideal: 16 / 9 },
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
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          aspectRatio: { ideal: 16 / 9 },
        });
      } catch {
        try {
          await track.applyConstraints({
            width: { ideal: 1280 },
            height: { ideal: 720 },
          });
        } catch {}
      }
    }
  }

  async function tryAttachMicrophone(stream) {
    if (stream.getAudioTracks().length > 0) return stream;
    try {
      const audioOnly = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      audioOnly.getAudioTracks().forEach((t) => stream.addTrack(t));
      audioOnly.getVideoTracks().forEach((t) => t.stop());
    } catch {}
    return stream;
  }

  async function tryGetUserMediaCascade() {
    const landscape = getLandscapeVideoConstraints();
    // Video-only first for Android permission; landscape 16:9 as soon as possible.
    const attempts = [
      { video: landscape, audio: false },
      {
        video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      },
      { video: { facingMode: 'environment' }, audio: false },
      { video: { facingMode: { ideal: 'environment' } }, audio: false },
      { video: true, audio: false },
      { audio: true, video: landscape },
      { audio: true, video: { facingMode: 'environment' } },
      { audio: true, video: true },
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
    await enforceLandscapeVideoTrack(stream);
    const withAudio = await tryAttachMicrophone(stream);
    await enforceLandscapeVideoTrack(withAudio);
    return withAudio;
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
    const mimeType = pickMimeType();
    if (!mimeType) {
      haptic('medium');
      return;
    }
    recordedChunks = [];
    try {
      mediaRecorder = new MediaRecorder(mediaStream, {
        mimeType,
        videoBitsPerSecond: 2500000,
      });
    } catch {
      mediaRecorder = new MediaRecorder(mediaStream);
    }
    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) recordedChunks.push(e.data);
    };
    mediaRecorder.onstop = async () => {
      clearMaxClipTimer();
      await releaseWakeLock();
      const blob = new Blob(recordedChunks, { type: mediaRecorder.mimeType || mimeType });
      recordedChunks = [];
      isRecording = false;
      $('covertCamera')?.classList.remove('covert-camera--recording');
      setBlackVisible(true);
      hidePreview();
      if (blob.size < 1000) {
        clearHud();
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
        await saveClip(blob, mediaRecorder.mimeType || mimeType, {
          durationSeconds,
          recordedAt: recordingStartedAt || Date.now(),
          latitude: recordingGeo?.lat,
          longitude: recordingGeo?.lng,
          locationLabel,
        });
        recordingStartedAt = 0;
        recordingGeo = null;
        showBriefHud('Stopped', 0);
        if (getPrefs().strongHapticOnRecord) haptic('success');
        else haptic('medium');
        await refreshClipSummary();
        if (!$('covertClipsHub')?.classList.contains('hidden')) renderClipsLibrary();
      } catch {
        clearHud();
        haptic('medium');
      }
    };
    recordingStartedAt = Date.now();
    recordingGeo = null;
    captureRecordingGeo().then((geo) => {
      if (geo) recordingGeo = geo;
    });

    mediaRecorder.start(1000);
    isRecording = true;
    $('covertCamera')?.classList.add('covert-camera--recording');
    setBlackVisible(true);
    hidePreview();
    await acquireWakeLock();
    await prepareLandscapeCapture();
    await enforceLandscapeVideoTrack(mediaStream);
    showBriefHud('Recording', HUD_RECORDING_MS);
    if (getPrefs().strongHapticOnRecord) haptic('success');
    else haptic('medium');

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
    showBriefHud('Stopped', 0);
  }

  function onTripleTap() {
    if (isRecording) stopRecording();
    else startRecording();
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
      if (!cameraSessionActive || isRecording) return;
      swipeUpCount += 1;
      clearTimeout(swipeUpResetTimer);
      swipeUpResetTimer = setTimeout(() => {
        swipeUpCount = 0;
      }, SWIPE_UP_RESET_MS);
      if (swipeUpCount === 1) showPreview();
      if (swipeUpCount >= SWIPE_CLOSE_REQUIRED) {
        swipeUpCount = 0;
        clearTimeout(swipeUpResetTimer);
        closeCameraSession();
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
    const files = clips.map((c) => new File([c.blob], `${c.id}${ext(c.mimeType)}`, { type: c.blob.type || 'video/webm' }));
    if (navigator.share && navigator.canShare?.({ files })) {
      try {
        await navigator.share({
          files,
          title: 'Toolbox clips',
          text: 'Choose OneDrive and save to your Desktop folder.',
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
    const el = $('cameraPermissionStatus');
    if (!el) return;
    if (!navigator.permissions?.query) {
      el.textContent = 'Use Camera tab — Android will ask for camera permission.';
      return;
    }
    try {
      const cam = await navigator.permissions.query({ name: 'camera' });
      const mic = await navigator.permissions.query({ name: 'microphone' });
      el.textContent = `Camera: ${cam.state} · Microphone: ${mic.state}`;
    } catch {
      el.textContent = 'Permission status unavailable — open Camera tab to grant access.';
    }
  }

  function bindSettings() {
    if (window.__cameraSettingsBound) return;
    window.__cameraSettingsBound = true;

    $('cameraOpenAppSettingsBtn')?.addEventListener('click', () => {
      haptic('light');
      window.alert(
        'Android: Settings → Apps → Toolbox (or Chrome) → Permissions → Camera & Microphone.\n\n' +
          'Chrome: ⋮ → Settings → Site settings → Camera / Microphone → Allow for this site.'
      );
    });

    $('cameraWakeLockSwitch')?.addEventListener('change', (e) => {
      const prefs = getPrefs();
      prefs.wakeLock = e.target.checked;
      savePrefs(prefs);
      syncCameraSettingsUi();
      haptic('light');
    });

    $('cameraStrongHapticSwitch')?.addEventListener('change', (e) => {
      const prefs = getPrefs();
      prefs.strongHapticOnRecord = e.target.checked;
      savePrefs(prefs);
      syncCameraSettingsUi();
      haptic('light');
    });

    $('cameraMaxClipSelect')?.addEventListener('change', (e) => {
      const prefs = getPrefs();
      prefs.maxClipMinutes = parseInt(e.target.value, 10) || 0;
      savePrefs(prefs);
      haptic('light');
    });

    $('cameraClearClipsBtn')?.addEventListener('click', async () => {
      if (!window.confirm('Delete all covert clips saved in Toolbox on this device?')) return;
      await clearAllClips();
      await refreshClipSummary();
      refreshCameraSettingsUi();
      haptic('medium');
    });

    $('cameraUploadAllBtn')?.addEventListener('click', () => uploadClips());
  }

  function syncCameraSettingsUi() {
    const prefs = getPrefs();
    const wake = $('cameraWakeLockSwitch');
    const strong = $('cameraStrongHapticSwitch');
    const maxSel = $('cameraMaxClipSelect');
    if (wake) wake.checked = !!prefs.wakeLock;
    if (strong) strong.checked = !!prefs.strongHapticOnRecord;
    if (maxSel) maxSel.value = String(prefs.maxClipMinutes ?? 10);
    if (typeof window.syncToggleStateLabel === 'function') {
      window.syncToggleStateLabel(wake);
      window.syncToggleStateLabel(strong);
    }
  }

  async function refreshCameraSettingsUi() {
    syncCameraSettingsUi();
    await refreshCameraPermissionUi();
    const summary = await getStorageSummary();
    const el = $('cameraStorageSummary');
    if (el) {
      el.textContent =
        `${summary.count} clip(s) · ${formatBytes(summary.bytes)} — Camera tab → swipe up twice for library & OneDrive.`;
    }
  }

  function bindUi() {
    if (window.__covertCameraUiBound) return;
    window.__covertCameraUiBound = true;

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
    swipeUpCount = 0;
    clearTimeout(swipeUpResetTimer);
    await refreshClipSummary().catch(() => {});

    // Saved clips first — only enter live/fullscreen after "Open camera" (cameraSessionActive).
    if (!cameraSessionActive) {
      showClipsHub();
      return;
    }

    resumeCameraSession();
  }

  function resumeCameraSession() {
    openCameraSession();
    if (streamIsLive()) {
      showPermissionGate(false);
      clearHud();
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
    $('covertClipsHub')?.classList.add('hidden');
  }

  function init() {
    bindUi();
    bindSettings();
    refreshClipSummary().catch(() => {});
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
    forceExitCovertUi,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
