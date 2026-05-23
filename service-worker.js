const BASE = '/travel-calc/';
const CACHE = 'surveillance-travel-pwa-v2';
const ASSETS = [
  BASE,
  BASE + 'surveillance-travel-calculator.html',
  BASE + 'manifest.webmanifest',
  BASE + 'service-worker.js',
  BASE + 'assets/icon-192.svg',
  BASE + 'assets/icon-512.svg'
];
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)));
  self.skipWaiting();
});
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(caches.match(event.request).then(resp => resp || fetch(event.request)));
});
