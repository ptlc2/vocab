// Service worker Vocab : le jeu est jouable hors ligne.
// Stratégie : les assets versionnés et le dictionnaire (cache immutable) sont servis depuis le cache,
// les pages HTML passent par le réseau puis retombent sur le cache (fiches consultées hors ligne).

const CACHE = 'vocab-v1';
const PRECACHE = ['/', '/manifest.json', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', event => {
    event.waitUntil(
        caches
            .open(CACHE)
            .then(cache => cache.addAll(PRECACHE))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches
            .keys()
            .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', event => {
    const request = event.request;
    if (request.method !== 'GET') return;
    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return;

    // Assets versionnés (game.js?v=, style.css?v=, dictionary.json?v=) et icônes : cache d'abord, définitif.
    const immutable =
        (url.pathname.endsWith('.js') ||
            url.pathname.endsWith('.css') ||
            url.pathname.endsWith('.json') ||
            url.pathname.endsWith('.png')) &&
        url.searchParams.has('v');
    if (immutable || url.pathname.startsWith('/icon-')) {
        event.respondWith(
            caches.match(request).then(
                cached =>
                    cached ??
                    fetch(request).then(response => {
                        if (response.ok) {
                            const copy = response.clone();
                            caches.open(CACHE).then(cache => cache.put(request, copy));
                        }
                        return response;
                    })
            )
        );
        return;
    }

    // Pages HTML : réseau d'abord, cache en repli (navigation hors ligne).
    if (request.mode === 'navigate' || request.headers.get('accept')?.includes('text/html')) {
        event.respondWith(
            fetch(request)
                .then(response => {
                    if (response.ok) {
                        const copy = response.clone();
                        caches.open(CACHE).then(cache => cache.put(request, copy));
                    }
                    return response;
                })
                .catch(() => caches.match(request).then(cached => cached ?? caches.match('/')))
        );
    }
});
