/* Service worker do app da Área do Cliente (/cliente).
   - A API (/cliente/api/...) e tudo que não é GET passam direto, sem cache.
   - A página abre pela rede; sem internet, abre a última cópia salva.
   - Só mexe nos próprios caches (prefixo "cliente-3m-"), nunca nos do app da gestão. */
const CACHE = 'cliente-3m-v1';
const FIXOS = ['/cliente/manifest.webmanifest', '/cliente/icones/icone-192.png', '/cliente/icones/icone-512.png', '/cliente/icones/apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FIXOS)).catch(() => {}).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k.startsWith('cliente-3m-') && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin || !url.pathname.startsWith('/cliente/')) return;
  if (url.pathname.startsWith('/cliente/api/')) return;

  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then(res => {
      if (res.ok && res.type === 'basic' && !res.redirected) {
        const copia = res.clone();
        caches.open(CACHE).then(c => c.put('/cliente/', copia));
      }
      return res;
    }).catch(() => caches.match('/cliente/').then(r => r || Response.error())));
    return;
  }

  if (url.pathname.startsWith('/cliente/icones/') || url.pathname === '/cliente/manifest.webmanifest') {
    e.respondWith(caches.match(req).then(r => r || fetch(req)));
  }
});
