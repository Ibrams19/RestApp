const CACHE_NAME = 'resto-7etoiles-v3';
const API_CACHE_NAME = 'resto-api-v2';

const STATIC_CACHE = [
  '/',
  '/login.html',
  '/dashboard.html',
  '/menu.html',
  '/resto.html',
  '/admin.html',
  '/employes.html',
  '/qrcodes.html',
  '/suivi.html',
  '/subscription.html',
  '/forgot-password.html',
  '/reset-password.html',
  '/set-password.html',
  '/magic.html',
  '/sw.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

// ==================== INSTALL ====================
self.addEventListener('install', event => {
  console.log('🚀 SW : installation');
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(STATIC_CACHE).catch(err => {
        console.warn('⚠️ Cache partiel :', err);
      });
    }).then(() => self.skipWaiting())
  );
});

// ==================== ACTIVATE ====================
self.addEventListener('activate', event => {
  console.log('✅ SW : activé');
  event.waitUntil(
    caches.keys().then(names => {
      return Promise.all(
        names.filter(n => n !== CACHE_NAME && n !== API_CACHE_NAME).map(n => caches.delete(n))
      );
    }).then(() => self.clients.claim())
  );
});

// ==================== FETCH ====================
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Ignorer Supabase et les requêtes non GET
  if (url.hostname.includes('supabase.co') || event.request.method !== 'GET') {
    return;
  }

  // API : Network First (sans cache pour les POST)
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirst(event.request));
    return;
  }

  // Statique : Cache First
  event.respondWith(cacheFirst(event.request));
});

// ==================== PUSH ====================
self.addEventListener('push', function(event) {
  const data = event.data ? event.data.json() : {};
  const title = data.title || 'RestApp 7★';
  const options = {
    body: data.body || 'Nouvelle commande reçue !',
    icon: '/android-chrome-192x192.png',
    badge: '/favicon-32x32.png',
    vibrate: [200, 100, 200],
    tag: 'commande',
    requireInteraction: true
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  event.waitUntil(clients.openWindow('/resto.html'));
});

// ==================== STRATÉGIES ====================
async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response && response.status === 200) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    if (request.headers.get('accept')?.includes('text/html')) {
      return caches.match('/');
    }
    throw err;
  }
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response && response.status === 200) {
      const cache = await caches.open(API_CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    const cached = await caches.match(request);
    if (cached) return cached;
    throw err;
  }
}