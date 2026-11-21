const CACHE_NAME = 'duofin2-core-v2.1.1';
const STATIC_ASSETS = [
 './',
 './index.html',
 './manifest.webmanifest',
 './css/styles.css',
 './js/config.js',
 './js/db.js',
 './js/supabase-sync.js',
 './js/finance-engine.js',
 './js/importers.js',
 './js/charts.js',
 './js/security.js',
 './js/app.js'
];

self.addEventListener('install', event => {
 event.waitUntil(
 caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS)).then(() => self.skipWaiting())
 );
});

self.addEventListener('activate', event => {
 event.waitUntil(
 caches.keys()
 .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
 .then(() => self.clients.claim())
 );
});

self.addEventListener('fetch', event => {
 const req = event.request;
 if (req.method !== 'GET') return;
 const url = new URL(req.url);

 if (url.hostname.endsWith('.supabase.co')) return;

 const isAllowedCdn = (url.origin === 'https://cdnjs.cloudflare.com' && url.pathname.includes('/pdf.js/')) ||
 url.origin === 'https://esm.sh';
 if (url.origin !== self.location.origin && !isAllowedCdn) return;

 if (req.mode === 'navigate') {
 event.respondWith(
 fetch(req)
 .then(res => {
 if (res && res.ok) {
 const copy = res.clone();
 caches.open(CACHE_NAME).then(c => c.put(req, copy));
 }
 return res;
 })
 .catch(() => caches.match(req).then(r => r || caches.match('./index.html')))
 );
 return;
 }

 event.respondWith(
 caches.match(req).then(cached => {
 const fetchPromise = fetch(req).then(res => {
 if (res && res.ok) {
 const copy = res.clone();
 caches.open(CACHE_NAME).then(c => c.put(req, copy));
 }
 return res;
 }).catch(() => cached);
 return cached || fetchPromise;
 })
 );
});
