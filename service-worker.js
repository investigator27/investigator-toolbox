/* sw-revision: 27 — bump this comment when testing updates locally */
const BASE = new URL('./', self.location).pathname;
let activeCacheName = 'surveillance-travel-pwa-v164';

const CORE_ASSETS = [
  BASE + 'index.html',
  BASE + 'surveillance-travel-calculator.html',
  BASE + 'manifest.webmanifest',
  BASE + 'release-notes.json',
  BASE + 'tab-policy.json',
  BASE + 'service-worker.js'
];

const OPTIONAL_ASSETS = [
  BASE + 'assets/covert-camera.js',
  BASE + 'assets/icon-192.png',
  BASE + 'assets/icon-512.png',
  BASE + 'assets/maskable_icon_x192.png',
  BASE + 'assets/maskable_icon.png'
];

const ASSETS = CORE_ASSETS.concat(OPTIONAL_ASSETS);

const NETWORK_FIRST = new Set([
  BASE + 'index.html',
  BASE + 'surveillance-travel-calculator.html',
  BASE + 'manifest.webmanifest',
  BASE + 'release-notes.json',
  BASE + 'tab-policy.json',
  BASE + 'service-worker.js'
]);

const CACHE_TIMEOUT_MS = 8000;

function isSameOriginRequest(request) {
  try {
    return new URL(request.url).origin === self.location.origin;
  } catch {
    return false;
  }
}

async function resolveCacheName() {
  try {
    const response = await fetch(BASE + 'release-notes.json', { cache: 'no-store' });
    if (!response.ok) return activeCacheName;
    const data = await response.json();
    if (data.latest) return `surveillance-travel-pwa-${data.latest}`;
  } catch {}
  return activeCacheName;
}

async function broadcastUpdate(data) {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  clients.forEach((client) => client.postMessage(data));
}

async function syncSwAppBadge(count) {
  const nav = self.navigator;
  if (!nav || typeof nav.setAppBadge !== 'function') return;
  try {
    if (count > 0) await nav.setAppBadge(count);
    else if (typeof nav.clearAppBadge === 'function') await nav.clearAppBadge();
  } catch {
    if (count > 0) {
      try {
        await nav.setAppBadge();
      } catch {}
    }
  }
}

const UPDATE_NOTIFICATION_TAG = 'toolbox-update-ready';

async function closeSwUpdateNotifications() {
  try {
    const notes = await self.registration.getNotifications({ tag: UPDATE_NOTIFICATION_TAG });
    notes.forEach((n) => n.close());
  } catch {}
}

async function showSwUpdateReadyNotification() {
  if (!self.registration?.showNotification) return;
  try {
    await self.registration.showNotification('Toolbox update ready', {
      body: 'Open Toolbox → Settings → Software Update to install.',
      tag: UPDATE_NOTIFICATION_TAG,
      renotify: false,
      icon: BASE + 'assets/icon-192.png',
      badge: BASE + 'assets/icon-192.png',
      data: { screen: 'updates' },
    });
  } catch {}
}

async function notifyAppIconBadge(count) {
  await syncSwAppBadge(count);
  await broadcastUpdate({ type: 'APP_ICON_BADGE', count });
  if (count > 0) {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (!clients.length) await showSwUpdateReadyNotification();
  } else {
    await closeSwUpdateNotifications();
  }
}

async function isPwaUpdateInstall() {
  if (self.registration?.active) return true;
  try {
    const keys = await caches.keys();
    return keys.some((name) => name.startsWith('surveillance-travel-pwa-') && name !== activeCacheName);
  } catch {
    return false;
  }
}

async function cacheAsset(cache, asset) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CACHE_TIMEOUT_MS);
  try {
    const response = await fetch(asset, { cache: 'no-store', signal: controller.signal });
    if (response && response.ok) {
      await cache.put(asset, response);
      return true;
    }
  } catch {}
  finally {
    clearTimeout(timer);
  }
  return false;
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    activeCacheName = await resolveCacheName();
    const cache = await caches.open(activeCacheName);
    const total = ASSETS.length;
    let done = 0;

    await broadcastUpdate({ type: 'UPDATE_PROGRESS', percent: 8, label: 'Starting download…', done: 0, total });

    for (const asset of ASSETS) {
      await cacheAsset(cache, asset);
      done += 1;
      const percent = Math.round((done / total) * 95);
      await broadcastUpdate({
        type: 'UPDATE_PROGRESS',
        percent,
        label: `Downloading (${done}/${total})…`,
        done,
        total
      });
    }

    await broadcastUpdate({
      type: 'UPDATE_PROGRESS',
      percent: 100,
      label: 'Download complete',
      done: total,
      total
    });
    await broadcastUpdate({ type: 'UPDATE_READY', version: activeCacheName });
    if (await isPwaUpdateInstall()) {
      await notifyAppIconBadge(1);
    }
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const cacheName = activeCacheName || await resolveCacheName();
    activeCacheName = cacheName;
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key !== cacheName).map((key) => caches.delete(key)));
    await self.clients.claim();
    const stillWaiting = self.registration?.waiting;
    if (!stillWaiting) {
      await syncSwAppBadge(0);
      await closeSwUpdateNotifications();
    }
  })());
});

self.addEventListener('sync', (event) => {
  if (event.tag === 'toolbox-update-badge') {
    event.waitUntil((async () => {
      await syncSwAppBadge(1);
      await showSwUpdateReadyNotification();
    })());
  }
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = BASE + 'surveillance-travel-calculator.html';
  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      if (clients.length) {
        await clients[0].focus();
        clients[0].postMessage({ type: 'OPEN_SETTINGS_UPDATES' });
        return;
      }
      const opened = await self.clients.openWindow(target);
      if (opened) opened.postMessage({ type: 'OPEN_SETTINGS_UPDATES' });
    })()
  );
});

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }
  if (data.type === 'SET_APP_BADGE') {
    event.waitUntil((async () => {
      const count = Number(data.count) || 0;
      await syncSwAppBadge(count);
      if (count > 0) await showSwUpdateReadyNotification();
      else await closeSwUpdateNotifications();
    })());
  }
  if (data.type === 'CLEAR_UPDATE_NOTIFICATIONS') {
    event.waitUntil(closeSwUpdateNotifications());
  }
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  if (!isSameOriginRequest(event.request)) return;

  const url = new URL(event.request.url);
  const pathname = url.pathname;

  if (NETWORK_FIRST.has(pathname) || event.request.destination === 'document') {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(activeCacheName).then((cache) => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(activeCacheName).then((cache) => cache.put(event.request, copy));
        }
        return response;
      });
    })
  );
});
