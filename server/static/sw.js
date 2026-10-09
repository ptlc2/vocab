// Service worker Vocab : le jeu et les fiches sont jouables/lisibles hors ligne.
// Les coquilles (jeu/fiche, une par langue) + le dictionnaire + les assets versionnés
// sont précacheés à l'installation ; les pages HTML passent par le réseau d'abord
// puis retombent sur le cache, et les navigations vers le jeu ou une fiche
// retombent sur la coquille de la langue (l'URL décide de ce que le moteur rend).

const CACHE = 'vocab-v3';
const CORE = ['/', '/manifest.json', '/icon-192.png', '/icon-512.png'];
const LANGUAGE_PATHS = ['/fr/', '/en/'];

async function cacheShellAssets(cache, languagePath) {
    // la coquille référence les assets versionnés et le dictionnaire : on les découvre depuis son HTML
    const shellUrl = `${languagePath}game`;
    const response = await fetch(shellUrl);
    if (!response.ok) return;
    await cache.put(shellUrl, response.clone());
    const html = await response.clone().text();
    const assetPattern = /(?:src|href)="([^"]+(?:\.(?:js|css|json))(?:\?v=[a-z0-9]+)?)"/g;
    const discovered = new Set();
    let match;
    while ((match = assetPattern.exec(html)) !== null) {
        discovered.add(new URL(match[1], self.location.origin).pathname + new URL(match[1], self.location.origin).search);
    }
    const dictionaryMatch = html.match(/data-dictionary="([^"]+)"/);
    if (dictionaryMatch) {
        discovered.add(dictionaryMatch[1]);
    }
    await Promise.allSettled(
        [...discovered].map(async assetUrl => {
            const assetResponse = await fetch(assetUrl);
            if (assetResponse.ok) await cache.put(assetUrl, assetResponse);
        })
    );
}

self.addEventListener('install', event => {
    event.waitUntil(
        (async () => {
            const cache = await caches.open(CACHE);
            await Promise.allSettled(CORE.map(url => cache.add(url)));
            for (const languagePath of LANGUAGE_PATHS) {
                await Promise.allSettled(
                    [languagePath, `${languagePath}words`, `${languagePath}progress`].map(url => cache.add(url).catch(() => {}))
                );
                try {
                    await cacheShellAssets(cache, languagePath);
                } catch {
                    // langue absente : on ignore
                }
            }
            await self.skipWaiting();
        })()
    );
});

self.addEventListener('activate', event => {
    event.waitUntil(
        (async () => {
            const keys = await caches.keys();
            await Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)));
            // rafraîchit le dictionnaire sous sa clé stable (sans version) pour les replis hors ligne
            const cache = await caches.open(CACHE);
            for (const languagePath of LANGUAGE_PATHS) {
                try {
                    const response = await fetch(`${languagePath}dictionary.json`);
                    if (response.ok) {
                        await cache.put(`${languagePath}dictionary.json`, response.clone());
                        if (response.redirected && response.url) {
                            await cache.put(new URL(response.url).pathname + new URL(response.url).search, response);
                        }
                    }
                } catch {
                    // hors ligne à l'activation : le cache existant reste
                }
            }
            await self.clients.claim();
        })()
    );
});

function languageShellPath(pathname) {
    const match = pathname.match(/^\/(fr|en)\//);
    return match ? `/${match[1]}/game` : null;
}

self.addEventListener('fetch', event => {
    const request = event.request;
    if (request.method !== 'GET') return;
    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return;

    // Dictionnaire : cache sous l'URL versionnée, repli sur la clé stable de la langue
    if (url.pathname.endsWith('/dictionary.json')) {
        event.respondWith(
            (async () => {
                const cache = await caches.open(CACHE);
                const versioned = await cache.match(url.pathname + url.search);
                if (versioned) return versioned;
                const stable = await cache.match(url.pathname);
                if (stable) return stable;
                const response = await fetch(request);
                if (response.ok) {
                    await cache.put(url.pathname + url.search, response.clone());
                    await cache.put(url.pathname, response);
                }
                return response;
            })()
        );
        return;
    }

    // Assets versionnés et icônes : cache d'abord, définitif
    const immutable =
        (url.pathname.endsWith('.js') || url.pathname.endsWith('.css') || url.pathname.endsWith('.png')) &&
        (url.searchParams.has('v') || url.pathname.startsWith('/icon-'));
    if (immutable) {
        event.respondWith(
            (async () => {
                const cache = await caches.open(CACHE);
                const cached = await cache.match(url.pathname + url.search);
                if (cached) return cached;
                const response = await fetch(request);
                if (response.ok) {
                    await cache.put(url.pathname + url.search, response.clone());
                }
                return response;
            })()
        );
        return;
    }

    // Pages HTML : réseau d'abord, cache en repli, puis coquille de la langue pour le jeu et les fiches
    if (request.mode === 'navigate' || (request.headers.get('accept') ?? '').includes('text/html')) {
        const shell = languageShellPath(url.pathname);
        const isGameOrWord = shell !== null && (url.pathname.endsWith('/game') || /\/words\/.+/.test(url.pathname));
        event.respondWith(
            (async () => {
                const cache = await caches.open(CACHE);
                try {
                    const response = await fetch(request);
                    if (response.ok) {
                        await cache.put(url.pathname + url.search, response.clone());
                    }
                    return response;
                } catch {
                    const cached = (await cache.match(url.pathname + url.search)) ?? (await cache.match(url.pathname));
                    if (cached) return cached;
                    if (isGameOrWord) {
                        const shellCached = await cache.match(shell);
                        if (shellCached) return shellCached;
                    }
                    return (await cache.match('/')) ?? Response.error();
                }
            })()
        );
    }
});
