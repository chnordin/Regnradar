// Regnradar service worker
const CACHE = 'regnradar-v5';
const ASSETS = ['/', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS).catch(() => {}))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // Network-first for navigation
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(() => caches.match('/'))
    );
    return;
  }
  // Cache-first for same-origin static
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(event.request).then((r) => r || fetch(event.request))
    );
  }
});

// Push notification handler.
// IMPORTANT for iOS Safari 16.4+: every `push` event MUST result in a
// showNotification() call within the lifetime of the event, or iOS will
// permanently revoke the site's push permission. We always show *something*.
self.addEventListener('push', (event) => {
  let title = 'Regnradar';
  let body = 'Regn förväntas inom 20 minuter';
  let minutes = null;
  let mmh = null;
  try {
    if (event.data) {
      const d = event.data.json();
      if (d.title) title = d.title;
      if (d.body) body = d.body;
      if (typeof d.minutes === 'number') minutes = d.minutes;
      if (typeof d.mmh === 'number') mmh = d.mmh;
    }
  } catch (_) {}
  // Build a richer body string if the server included intensity/lead-time.
  let bodyText = body;
  if (minutes != null) {
    bodyText = `Regn förväntas inom ${minutes} minut${minutes === 1 ? '' : 'er'}`;
    if (mmh != null && mmh >= 0.05) {
      bodyText += ` · ${mmh.toString().replace('.', ',')} mm/h`;
    }
  }
  event.waitUntil(
    self.registration.showNotification(title, {
      body: bodyText,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: 'rain-warning',
      renotify: true,
      data: { url: '/' },
    })
  );
});

// Local notification trigger from page
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SHOW_NOTIFICATION') {
    const { title, body } = event.data;
    self.registration.showNotification(title || 'Regnradar', {
      body: body || 'Regn närmar sig',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: 'rain-warning',
      renotify: true,
    });
  }
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((clients) => {
      if (clients.length > 0) return clients[0].focus();
      return self.clients.openWindow('/');
    })
  );
});
