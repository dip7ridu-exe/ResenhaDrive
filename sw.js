/*
 * sw.js — Service Worker de streaming.
 * Intercepta pedidos para ./stream/<ID_DO_ARQUIVO> e busca o arquivo ORIGINAL
 * no Google Drive com o seu token de acesso, repassando o cabeçalho Range.
 * Assim o <video> consegue avançar/voltar (seek) e toca na qualidade original,
 * sem passar por nenhum servidor além do próprio Google.
 */
const STREAM_RE = /\/stream\/([A-Za-z0-9_-]{10,})$/;
let TOKEN = null;
let TOKEN_EXP = 0;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('message', (e) => {
  const d = e.data || {};
  if (d.type === 'token') {
    TOKEN = d.token || null;
    TOKEN_EXP = d.exp || 0;
  } else if (d.type === 'logout') {
    TOKEN = null;
    TOKEN_EXP = 0;
  }
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;
  const m = url.pathname.match(STREAM_RE);
  if (!m) return;
  e.respondWith(stream(e, m[1]));
});

async function askClientForToken(clientId, force) {
  let client = clientId ? await self.clients.get(clientId) : null;
  if (!client) {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    client = all.find((c) => c.focused) || all[0];
  }
  if (!client) return null;
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    const timer = setTimeout(() => resolve(null), 20000);
    ch.port1.onmessage = (ev) => {
      clearTimeout(timer);
      const d = ev.data || {};
      if (d.token) {
        TOKEN = d.token;
        TOKEN_EXP = d.exp || Date.now() + 30 * 60 * 1000;
      }
      resolve(d.token || null);
    };
    client.postMessage({ type: 'need-token', force: !!force }, [ch.port2]);
  });
}

async function getToken(clientId, force) {
  if (!force && TOKEN && TOKEN_EXP - Date.now() > 30000) return TOKEN;
  return askClientForToken(clientId, force);
}

async function stream(e, id) {
  const clientId = e.clientId || e.resultingClientId;
  let token = await getToken(clientId, false);
  if (!token) return new Response('Sem autorização do Google Drive', { status: 401 });

  const driveUrl = `https://www.googleapis.com/drive/v3/files/${id}?alt=media&supportsAllDrives=true`;
  const headers = new Headers({ Authorization: 'Bearer ' + token });
  const range = e.request.headers.get('range');
  if (range) headers.set('Range', range);

  try {
    let r = await fetch(driveUrl, { headers, cache: 'no-store' });
    if (r.status === 401) {
      token = await getToken(clientId, true);
      if (!token) return new Response('Sessão expirada', { status: 401 });
      headers.set('Authorization', 'Bearer ' + token);
      r = await fetch(driveUrl, { headers, cache: 'no-store' });
    }
    return r;
  } catch (err) {
    return new Response('Falha de rede: ' + err.message, { status: 502 });
  }
}
