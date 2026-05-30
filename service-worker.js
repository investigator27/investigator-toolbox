/* sw-revision: 27 — bump this comment when testing updates locally */
const BASE = new URL('./', self.location).pathname;
let activeCacheName = 'surveillance-travel-pwa-v101';

const CORE_ASSETS = [
  BASE + 'surveillance-travel-calculator.html',
  BASE + 'manifest.webmanifest',
  BASE + 'release-notes.json',
  BASE + 'tab-policy.json',
  BASE + 'service-worker.js'
];

const OPTIONAL_ASSETS = [
  BASE + 'assets/icon-192.png',
  BASE + 'assets/icon-512.png',
  BASE + 'assets/maskable_icon_x192.png',
  BASE + 'assets/maskable_icon.png'
];

const ASSETS = CORE_ASSETS.concat(OPTIONAL_ASSETS);

const NETWORK_FIRST = new Set([
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
  if (typeof self.setAppBadge !== 'function') return;
  try {
    if (count > 0) await self.setAppBadge(count);
    else if (typeof self.clearAppBadge === 'function') await self.clearAppBadge();
  } catch {}
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
    if (self.registration?.active) {
      await syncSwAppBadge(1);
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
    await syncSwAppBadge(0);
  })());
});

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }
  if (data.type === 'SET_APP_BADGE') {
    event.waitUntil(syncSwAppBadge(Number(data.count) || 0));
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
