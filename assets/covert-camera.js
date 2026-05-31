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
  let dbPromise = null;
  let allowInFlight = false;

  function $(id) {
    return document.getElementById(id);
  }

  function haptic(style) {
    if (typeof window.toolboxHaptic === 'function') window.toolboxHaptic(style);
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

  async function saveClip(blob, mimeType) {
    const id = nextClipId();
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put({
        id,
        blob,
        mimeType: mimeType || blob.type,
        createdAt: Date.now(),
        size: blob.size,
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
        const list = (req.result || []).sort((a, b) => a.id.localeCompare(b.id));
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

  function setStatus(text) {
    const el = $('covertStatus');
    if (el) el.textContent = text;
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
  }

  function enterCovertMode() {
    document.querySelector('.app-shell')?.classList.add('app-shell--covert-camera');
    setBlackVisible(true);
  }

  function leaveCovertMode() {
    document.querySelector('.app-shell')?.classList.remove('app-shell--covert-camera');
    document.documentElement.style.backgroundColor = '';
    setBlackVisible(false);
    showPermissionGate(false);
    setPermissionError('');
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
    // Video-only first so Android shows the camera popup (mic+audio together can fail with no prompt).
    const attempts = [
      { video: { facingMode: 'environment' }, audio: false },
      { video: { facingMode: { ideal: 'environment' } }, audio: false },
      { video: true, audio: false },
      { audio: true, video: { facingMode: 'environment' } },
      {
        audio: true,
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
      },
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
    return tryAttachMicrophone(stream);
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
      const msg = 'Camera needs HTTPS — open Toolbox from the installed app icon, not a file link.';
      setPermissionError(msg);
      setStatus(msg);
      return false;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      showPermissionGate(true);
      const msg = 'Camera API not available in this browser.';
      setPermissionError(msg);
      setStatus(msg);
      return false;
    }

    setStatus('Look for the Android Camera / Microphone popup — tap Allow on both.');

    try {
      mediaStream = await tryGetUserMediaCascade();
    } catch (err) {
      showPermissionGate(true);
      const permState = await queryMediaPermissionState();
      const msg = describeMediaError(err, permState);
      setPermissionError(msg);
      setStatus(msg);
      return false;
    }

    showPermissionGate(false);
    setPermissionError('');

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

    const hasAudio = mediaStream.getAudioTracks().length > 0;
    setStatus(
      hasAudio
        ? 'Ready — 3 taps to record'
        : 'Ready (no mic) — 3 taps to record. Enable microphone in Settings if needed.'
    );
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
    setStatus('Look for the Android popup — tap Allow for Camera and Microphone.');

    // Start getUserMedia in this same tap (do not await anything before the cascade).
    return startCameraStream(true)
      .then((ok) => {
        if (ok) {
          try {
            if (screen.orientation?.lock) screen.orientation.lock('landscape');
          } catch {}
        }
        return ok;
      })
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
      setStatus('Video recording not supported on this device.');
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
        setStatus('Recording failed — try again.');
        haptic('medium');
        return;
      }
      try {
        const id = await saveClip(blob, mediaRecorder.mimeType || mimeType);
        setStatus(`Saved ${id} — 3 taps to record again`);
        if (getPrefs().strongHapticOnRecord) haptic('success');
        else haptic('medium');
        await refreshClipSummary();
      } catch {
        setStatus('Could not save clip.');
      }
    };
    mediaRecorder.start(1000);
    isRecording = true;
    $('covertCamera')?.classList.add('covert-camera--recording');
    setBlackVisible(true);
    hidePreview();
    await acquireWakeLock();
    setStatus('Recording — 3 taps to stop');
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
    setStatus('Saving…');
  }

  function onTripleTap() {
    if (isRecording) stopRecording();
    else startRecording();
  }

  function onTapZone() {
    if ($('covertCamera')?.classList.contains('covert-camera--gate-open')) return;
    haptic('light');
    tapCount += 1;
    clearTimeout(tapResetTimer);
    tapResetTimer = setTimeout(() => {
      tapCount = 0;
    }, TAP_RESET_MS);
    if (tapCount >= TAP_REQUIRED) {
      tapCount = 0;
      clearTimeout(tapResetTimer);
      onTripleTap();
    }
  }

  function onTouchStart(e) {
    if (e.touches.length !== 1) return;
    swipeStartY = e.touches[0].clientY;
  }

  function onTouchEnd(e) {
    if (swipeStartY == null || !e.changedTouches.length) return;
    const dy = swipeStartY - e.changedTouches[0].clientY;
    swipeStartY = null;
    if (dy > 48) {
      showPreview();
      return;
    }
    if (dy < -48) hidePreview();
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

  async function uploadClips() {
    const clips = await getAllClips();
    if (!clips.length) return;
    haptic('light');
    const ext = (mime) => (mime && mime.includes('mp4') ? '.mp4' : '.webm');
    const files = clips.map((c) => new File([c.blob], `${c.id}${ext(c.mimeType)}`, { type: c.blob.type || 'video/webm' }));
    if (navigator.share && navigator.canShare?.({ files })) {
      try {
        await navigator.share({
          files,
          title: 'Toolbox covert clips',
          text: 'Upload to OneDrive (e.g. Desktop folder) when prompted.',
        });
        setStatus('Share sheet opened — pick OneDrive.');
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
    setStatus('Downloads started — move files to OneDrive if share is unavailable.');
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
      setStatus('Android: Settings → Apps → Toolbox → Permissions → Camera & Microphone.');
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
    if (el) el.textContent = `${summary.count} clip(s) · ${formatBytes(summary.bytes)} in Toolbox storage`;
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
  }

  async function onTabEnter() {
    bindUi();
    bindSettings();
    enterCovertMode();
    hidePreview();
    await refreshClipSummary().catch(() => {});
    if (streamIsLive()) {
      showPermissionGate(false);
      setStatus('Ready — 3 taps to record');
      return;
    }
    showPermissionGate(true);
    setPermissionError('');
    setStatus('Tap Allow — you should get an Android popup for Camera (then Microphone).');
  }

  function onTabLeave() {
    if (isRecording) stopRecording();
    stopCameraStream();
    releaseWakeLock();
    leaveCovertMode();
    try {
      screen.orientation?.unlock?.();
    } catch {}
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
    refreshCameraSettingsUi,
    refreshClipSummary,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
