const CACHE_NAME = 'resto-7etoiles-v2';
const API_CACHE_NAME = 'resto-api-v1';

// Fichiers à mettre en cache immédiatement (shell de l'application)
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
  '/subscription-renew.html',
  '/transactions.html',
  '/forgot-password.html',
  '/reset-password.html',
  '/set-password.html',
  '/magic.html',
  '/styles.css',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

// ==================== INSTALL ====================
self.addEventListener('install', event => {
  console.log('🚀 Service Worker : installation');
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('📦 Mise en cache des fichiers statiques');
        return cache.addAll(STATIC_CACHE).catch(err => {
          console.warn('⚠️ Certains fichiers n\'ont pas pu être mis en cache :', err);
        });
      })
      .then(() => self.skipWaiting())
  );
});

// ==================== ACTIVATE ====================
self.addEventListener('activate', event => {
  console.log('✅ Service Worker : activé');
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames
          .filter(name => name !== CACHE_NAME && name !== API_CACHE_NAME)
          .map(name => {
            console.log('🗑️ Suppression ancien cache :', name);
            return caches.delete(name);
          })
      );
    }).then(() => self.clients.claim())
  );
});

// ==================== FETCH ====================
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Ne pas intercepter les requêtes Supabase
  if (url.hostname.includes('supabase.co')) {
    return;
  }

  // Stratégie Network First pour les API
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirst(event.request));
    return;
  }

  // Stratégie Cache First pour les fichiers statiques
  event.respondWith(cacheFirst(event.request));
});

// ==================== STRATÉGIES ====================

// Cache First : sert le cache, sinon réseau (et met en cache)
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

// Network First : essaie le réseau d'abord, puis le cache
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