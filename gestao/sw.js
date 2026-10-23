/* Service worker do app da oficina (/gestao).
   - A API (/gestao/api/...) e tudo que não é GET passam direto, sem cache: os dados sempre vêm do servidor.
   - A página abre pela rede; sem internet, abre a última cópia salva (os dados ficam no cache local do próprio app).
   - Ícones e manifest ficam guardados para o app abrir rápido. */
const CACHE = 'oficina-3m-v1';
const FIXOS = ['/gestao/manifest.webmanifest', '/gestao/icones/icone-192.png', '/gestao/icones/icone-512.png', '/gestao/icones/apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FIXOS)).catch(() => {}).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin || !url.pathname.startsWith('/gestao/')) return;
  if (url.pathname.startsWith('/gestao/api/')) return;

  if (req.mode === 'navigate') {
    // Rede primeiro. Só guarda resposta normal da própria página (nunca o redirecionamento do login do Access).
    e.respondWith(fetch(req).then(res => {
      if (res.ok && res.type === 'basic' && !res.redirected) {
        const copia = res.clone();
        caches.open(CACHE).then(c => c.put('/gestao/', copia));
      }
      return res;
    }).catch(() => caches.match('/gestao/').then(r => r || Response.error())));
    return;
  }

  if (url.pathname.startsWith('/gestao/icones/') || url.pathname === '/gestao/manifest.webmanifest') {
    e.respondWith(caches.match(req).then(r => r || fetch(req)));
  }
});
