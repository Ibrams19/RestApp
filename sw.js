const CACHE_NAME = 'resto-7etoiles-v4';
const API_CACHE_NAME = 'resto-api-v3';

const STATIC_CACHE = [
  '/',
  '/login.html',
  '/dashboard.html',
  '/resto.html',
  '/admin.html',
  '/employes.html',
  '/qrcodes.html',
  '/subscription.html',
  '/magic.html',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

// ==================== INSTALL ====================
self.addEventListener('install', event => {
  console.log('🚀 SW : Installation');
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
  console.log('✅ SW : Activé');
  event.waitUntil(
    caches.keys().then(names => {
      return Promise.all(
        names.filter(n => n !== CACHE_NAME && n !== API_CACHE_NAME)
             .map(n => caches.delete(n))
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

  // API : Network First
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirst(event.request));
  } else {
    // Statique : Cache First
    event.respondWith(cacheFirst(event.request));
  }
});

// ==================== PUSH NOTIFICATIONS ====================
self.addEventListener('push', function(event) {
  let title = '🛎️ Nouvelle commande';
  let body = 'Une commande vient d\'arriver';
  let url = '/resto.html';

  if (event.data) {
    try {
      const data = event.data.json();
      title = data.title || title;
      body = data.body || body;
      url = data.url || url;
    } catch (e) {
      body = event.data.text() || body;
    }
  }

  const options = {
    body: body,
    icon: '/android-chrome-192x192.png',
    badge: '/favicon-32x32.png',
    vibrate: [200, 100, 200, 100, 200],
    tag: 'nouvelle-commande',
    requireInteraction: true,
    data: { url: url }
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  event.waitUntil(
    clients.openWindow(event.notification.data?.url || '/resto.html')
  );
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
    // Offline fallback pour les pages HTML
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