// GEOMANCY service worker: caches the app shell so it opens fast and works offline.
const VERSION = 'geo-v5';
const CDN = ['cdn.tailwindcss.com', 'cdn.jsdelivr.net'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(['book.js']).catch(() => {})).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || /\.(mp3|ogg|m4a)(\?|$)/i.test(req.url) || req.headers.has('range')) return;
  const url = new URL(req.url);
  const same = url.origin === self.location.origin;
  if (!same && !CDN.includes(url.hostname)) return;          // Supabase, Gemini, etc. always go to the network
  if (req.mode === 'navigate') {                              // pages: network first, cache as fallback
    e.respondWith(fetch(req).then(r => { const c = r.clone(); caches.open(VERSION).then(ch => ch.put(req, c)); return r; })
      .catch(() => caches.match(req).then(r => r || caches.match('./'))));
    return;
  }
  e.respondWith(caches.open(VERSION).then(async ch => {       // assets: cache first, refresh in background
    const hit = await ch.match(req);
    const net = fetch(req).then(r => { if (r && (r.ok || r.type === 'opaque')) ch.put(req, r.clone()); return r; }).catch(() => hit);
    return hit || net;
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
    for (const c of cs) { if ('focus' in c) return c.focus(); }
    return self.clients.openWindow('./');
  }));
});
