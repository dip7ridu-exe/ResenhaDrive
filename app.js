/*
 * app.js — ResenhaDrive
 * Login com Google (Google Identity Services), leitura do Drive (API v3),
 * interface, player e visualizador de fotos. Tudo roda no navegador.
 */
(() => {
  'use strict';

  const CFG = Object.assign(
    { APP_NAME: 'ResenhaDrive', GOOGLE_CLIENT_ID: '', TMDB_API_KEY: '', MOVIE_MIN_MINUTES: 50 },
    window.APP_CONFIG || {}
  );
  const Lib = window.Lib;
  const SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
  const API = 'https://www.googleapis.com/drive/v3/';
  const TMDB_IMG = 'https://image.tmdb.org/t/p/';
  const FOLDER_MIME = 'application/vnd.google-apps.folder';
  const MEDIA_FIELDS = 'id,name,mimeType,parents,size,thumbnailLink,createdTime,modifiedTime,' +
    'videoMediaMetadata(width,height,durationMillis),imageMediaMetadata(width,height,time)';
  const DEMO = /[?&]demo\b/.test(location.search);

  // ---------- utilidades ----------
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
    del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  };
  const hue = (s) => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  class AuthError extends Error {}

  // ---------- estado ----------
  const state = {
    token: null,
    user: null,
    raw: null,       // { myDriveId, folders, files, scannedAt }
    lib: null,
    byId: new Map(),
    swReady: false,
    gisReady: false,
    playing: null,
    playSeq: 0,
    playerMode: 'direct',
    openedPlayerFromApp: false,
    lastRoute: '#/',
    seriesSeason: {},
  };
  let settings = Object.assign({ root: undefined, rootName: '', tmdbKey: '', minMovie: CFG.MOVIE_MIN_MINUTES }, store.get('rd:settings', {}));
  let saveSettings = () => store.set('rd:settings', settings);
  let progress = store.get('rd:progress', {});
  let tmdbCache = store.get('rd:tmdb', {});

  // ---------- UI básica ----------
  function toast(msg, ms = 3500) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    $('#toasts').appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));
    setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, ms);
  }
  function setLoading(text) {
    const l = $('#loading');
    if (text === false) { l.hidden = true; return; }
    l.hidden = false;
    $('#loadingText').textContent = text;
  }
  function applyBrand() {
    document.title = CFG.APP_NAME;
    $$('[data-brand]').forEach((el) => (el.textContent = CFG.APP_NAME));
  }

  // ---------- login Google (token no navegador) ----------
  let tokenClient = null;
  let tokenWaiters = [];
  let tokenPromise = null;
  let refreshTimer = null;
  let afterRenew = [];

  function loadGis() {
    return new Promise((resolve, reject) => {
      if (window.google && google.accounts && google.accounts.oauth2) return resolve();
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('Não foi possível carregar o login do Google.'));
      document.head.appendChild(s);
    });
  }
  function initTokenClient() {
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CFG.GOOGLE_CLIENT_ID,
      scope: SCOPE,
      callback: (resp) => {
        if (resp.error) return settleToken(null, resp.error);
        if (!google.accounts.oauth2.hasGrantedAllScopes(resp, SCOPE)) {
          toast('Você precisa permitir o acesso de leitura ao Google Drive para usar o site.', 6000);
          return settleToken(null, 'scope');
        }
        setToken(resp);
        settleToken(state.token);
      },
      error_callback: (err) => settleToken(null, (err && err.type) || 'erro'),
    });
    state.gisReady = true;
  }
  function settleToken(t, err) {
    const w = tokenWaiters;
    tokenWaiters = [];
    w.forEach((fn) => fn(t, err));
  }
  function requestToken(timeoutMs = 120000) {
    return new Promise((resolve) => {
      if (!tokenClient) return resolve(null);
      const timer = setTimeout(() => resolve(null), timeoutMs);
      tokenWaiters.push((t) => { clearTimeout(timer); resolve(t); });
      try { tokenClient.requestAccessToken({ prompt: '' }); } catch (e) { settleToken(null, e.message); }
    });
  }
  function setToken(resp) {
    state.token = { access_token: resp.access_token, exp: Date.now() + (+resp.expires_in || 3600) * 1000 };
    try { sessionStorage.setItem('rd:token', JSON.stringify(state.token)); } catch { /* ignore */ }
    store.set('rd:connected', true);
    postTokenToSW();
    $('#renewBanner').hidden = true;
    clearTimeout(refreshTimer);
    const wait = state.token.exp - Date.now() - 5 * 60 * 1000;
    refreshTimer = setTimeout(silentRefresh, Math.max(wait, 10000));
  }
  function restoreToken() {
    try {
      const t = JSON.parse(sessionStorage.getItem('rd:token') || 'null');
      if (t && t.exp - Date.now() > 60000) {
        state.token = t;
        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(silentRefresh, Math.max(t.exp - Date.now() - 5 * 60 * 1000, 10000));
      }
    } catch { /* ignore */ }
  }
  async function silentRefresh() {
    const t = await requestToken(15000);
    if (!t) showRenewBanner();
  }
  function tokenValid() { return !!state.token && state.token.exp - Date.now() > 60000; }
  async function ensureToken(force = false) {
    if (DEMO) throw new AuthError('demo');
    if (!force && tokenValid()) return state.token.access_token;
    if (!tokenPromise) tokenPromise = requestToken(15000).finally(() => { tokenPromise = null; });
    const t = await tokenPromise;
    if (!t) { showRenewBanner(); throw new AuthError('Conexão com o Google expirada'); }
    return t.access_token;
  }
  function showRenewBanner() {
    if (!state.lib) return;
    $('#renewBanner').hidden = false;
  }
  async function renewInteractive() {
    const t = await requestToken();
    if (!t) { toast('Não foi possível reconectar. Tente de novo.'); return false; }
    $('#renewBanner').hidden = true;
    const fns = afterRenew; afterRenew = [];
    fns.forEach((fn) => { try { fn(); } catch { /* ignore */ } });
    resumeAfterAuth();
    return true;
  }

  // ---------- service worker (streaming) ----------
  function postTokenToSW() {
    const c = navigator.serviceWorker && navigator.serviceWorker.controller;
    if (c && state.token) c.postMessage({ type: 'token', token: state.token.access_token, exp: state.token.exp });
  }
  async function onSWMessage(e) {
    const d = e.data || {};
    if (d.type !== 'need-token') return;
    const port = e.ports && e.ports[0];
    if (!port) return;
    try {
      const t = await ensureToken(!!d.force);
      port.postMessage({ token: t, exp: state.token.exp });
    } catch {
      port.postMessage({ token: null });
    }
  }
  async function setupSW() {
    if (!('serviceWorker' in navigator) || !window.isSecureContext) return false;
    try {
      navigator.serviceWorker.addEventListener('message', onSWMessage);
      navigator.serviceWorker.addEventListener('controllerchange', postTokenToSW);
      await navigator.serviceWorker.register('./sw.js');
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) {
        await new Promise((res) => {
          const to = setTimeout(res, 4000);
          navigator.serviceWorker.addEventListener('controllerchange', () => { clearTimeout(to); res(); }, { once: true });
        });
      }
      postTokenToSW();
      return !!navigator.serviceWorker.controller;
    } catch (e) {
      console.warn('Service worker indisponível', e);
      return false;
    }
  }
  const streamUrl = (id) => './stream/' + encodeURIComponent(id);
  const driveViewUrl = (id) => `https://drive.google.com/file/d/${id}/view`;
  const sized = (thumb, size) => (thumb ? thumb.replace(/=s\d+(-[a-z])?$/i, '') + '=s' + size : null);

  // ---------- API do Drive ----------
  async function drive(path, params = {}, retry = true) {
    const url = new URL(API + path);
    for (const [k, v] of Object.entries(params)) if (v != null && v !== '') url.searchParams.set(k, v);
    const token = await ensureToken();
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
    if (r.status === 401 && retry) { await ensureToken(true); return drive(path, params, false); }
    if (!r.ok) {
      let msg = 'Erro ' + r.status;
      try { const j = await r.json(); msg = (j.error && j.error.message) || msg; } catch { /* ignore */ }
      throw new Error(msg);
    }
    return r.json();
  }
  async function listAll(q, fields, onPage) {
    const out = [];
    let pageToken;
    do {
      const res = await drive('files', { q, fields: `nextPageToken,files(${fields})`, pageSize: 1000, pageToken });
      out.push(...(res.files || []));
      if (onPage) onPage(out.length);
      pageToken = res.nextPageToken;
    } while (pageToken);
    return out;
  }
  async function fetchFileText(id) {
    const token = await ensureToken();
    const r = await fetch(`${API}files/${id}?alt=media&supportsAllDrives=true`, { headers: { Authorization: 'Bearer ' + token } });
    if (!r.ok) throw new Error('Erro ' + r.status);
    const buf = await r.arrayBuffer();
    try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { return new TextDecoder('windows-1252').decode(buf); }
  }

  async function scanDrive() {
    setLoading('Lendo suas pastas…');
    const [rootInfo, folders] = await Promise.all([
      drive('files/root', { fields: 'id' }),
      listAll(`mimeType='${FOLDER_MIME}' and trashed=false`, 'id,name,parents', (n) => setLoading(`Lendo suas pastas… ${n}`)),
    ]);
    const files = await listAll(
      "trashed=false and (mimeType contains 'video/' or mimeType contains 'image/')",
      MEDIA_FIELDS,
      (n) => setLoading(`Encontrando vídeos e fotos… ${n}`)
    );
    state.raw = { myDriveId: rootInfo.id, folders, files, scannedAt: Date.now() };
    if (!store.set('rd:raw', state.raw)) store.del('rd:raw');
  }

  function rebuild() {
    if (!state.raw) return;
    state.lib = Lib.buildLibrary({
      folders: state.raw.folders,
      files: state.raw.files,
      root: settings.root || null,
      myDriveId: state.raw.myDriveId,
      minMovieMinutes: settings.minMovie,
    });
    state.byId = new Map();
    const L = state.lib;
    L.movies.forEach((m) => state.byId.set(m.id, m));
    L.videos.forEach((v) => state.byId.set(v.id, v));
    L.photos.forEach((p) => state.byId.set(p.id, p));
    L.seriesByKey = new Map(L.series.map((s) => [s.key, s]));
    L.series.forEach((s) => s.episodes.forEach((e) => state.byId.set(e.id, e)));
  }

  async function refreshInBackground() {
    try {
      const raw = state.raw;
      const [rootInfo, folders, files] = await Promise.all([
        drive('files/root', { fields: 'id' }),
        listAll(`mimeType='${FOLDER_MIME}' and trashed=false`, 'id,name,parents'),
        listAll("trashed=false and (mimeType contains 'video/' or mimeType contains 'image/')", MEDIA_FIELDS),
      ]);
      state.raw = { myDriveId: rootInfo.id, folders, files, scannedAt: Date.now() };
      if (!store.set('rd:raw', state.raw)) store.del('rd:raw');
      const changed = !raw || raw.files.length !== files.length || raw.folders.length !== folders.length ||
        raw.files.some((f, i) => !files[i] || files[i].id !== f.id || files[i].modifiedTime !== f.modifiedTime);
      rebuild();
      if (changed && $('#player').hidden) onRoute();
    } catch (e) {
      if (!(e instanceof AuthError)) console.warn('Atualização em segundo plano falhou', e);
    }
  }

  // ---------- progresso ----------
  const saveProgress = debounce(() => store.set('rd:progress', progress), 1000);
  function setProgress(id, t, d) {
    if (!d || !isFinite(d)) return;
    progress[id] = { t: Math.floor(t), d: Math.floor(d), ts: Date.now() };
    const keys = Object.keys(progress);
    if (keys.length > 600) {
      keys.sort((a, b) => progress[a].ts - progress[b].ts).slice(0, keys.length - 500).forEach((k) => delete progress[k]);
    }
    saveProgress();
  }
  const getProgress = (id) => progress[id] || null;
  const isFinished = (p) => p && p.d && p.t >= p.d * 0.92;
  const pct = (id) => { const p = getProgress(id); return p && p.d ? Math.min(100, (p.t / p.d) * 100) : 0; };

  function continueWatching() {
    return Object.entries(progress)
      .filter(([id, p]) => state.byId.has(id) && p.t > 20 && !isFinished(p))
      .sort((a, b) => b[1].ts - a[1].ts)
      .map(([id]) => state.byId.get(id))
      .filter((it) => it.kind !== 'photo')
      .slice(0, 20);
  }
  function nextUp(series) {
    let best = null;
    series.episodes.forEach((e, i) => {
      const p = getProgress(e.id);
      if (p && (!best || p.ts > best.ts)) best = { i, ts: p.ts, p };
    });
    if (!best) return { ep: series.episodes[0], label: 'Assistir' };
    if (isFinished(best.p)) {
      const n = series.episodes[best.i + 1];
      return n ? { ep: n, label: 'Próximo episódio' } : { ep: series.episodes[0], label: 'Assistir de novo' };
    }
    return { ep: series.episodes[best.i], label: 'Continuar' };
  }
  function nextEpisode(it) {
    if (!it || it.kind !== 'episode') return null;
    const s = state.lib.seriesByKey.get(it.seriesKey);
    if (!s) return null;
    const i = s.episodes.findIndex((e) => e.id === it.id);
    return s.episodes[i + 1] || null;
  }

  // ---------- capas (pasta, TMDB, miniatura do Drive) ----------
  const artOf = (folderId) => (folderId && state.lib.art[folderId]) || null;
  const tmdbKeyFor = (kind, ent) => kind === 'movie' ? `movie:${Lib.slug(ent.title)}:${ent.year || ''}` : `tv:${ent.key}`;
  const tmdbOf = (kind, ent) => tmdbCache[tmdbKeyFor(kind, ent)] || null;

  function posterSources(kind, ent) {
    const s = [];
    const a = artOf(ent.artFolder);
    if (a && a.poster) s.push(streamUrl(a.poster));
    const t = tmdbOf(kind, ent);
    if (t && t.poster) s.push(TMDB_IMG + 'w342' + t.poster);
    const th = kind === 'movie' ? ent.thumb : ent.thumb;
    if (th) s.push(sized(th, 480));
    return s;
  }
  function backdropSources(kind, ent) {
    const s = [];
    const a = artOf(ent.artFolder);
    if (a && a.backdrop) s.push(streamUrl(a.backdrop));
    const t = tmdbOf(kind, ent);
    if (t && t.backdrop) s.push(TMDB_IMG + 'w1280' + t.backdrop);
    if (ent.thumb) s.push(sized(ent.thumb, 1280));
    if (a && a.poster) s.push(streamUrl(a.poster));
    if (t && t.poster) s.push(TMDB_IMG + 'w780' + t.poster);
    return s;
  }
  function imgTag(srcs, extra = '') {
    const list = srcs.filter((u) => u && (state.swReady || !u.startsWith('./stream/')));
    if (!list.length || DEMO) return '';
    return `<img data-srcs="${esc(list.join('|'))}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" ${extra}>`;
  }
  function wireImages(root = document) {
    $$('img[data-srcs]:not([data-wired])', root).forEach((img) => {
      img.dataset.wired = '1';
      img.dataset.i = '0';
      img.addEventListener('load', () => img.classList.add('ok'));
      img.addEventListener('error', () => {
        const list = img.dataset.srcs.split('|');
        const i = +img.dataset.i + 1;
        if (i < list.length) { img.dataset.i = String(i); img.src = list[i]; } else img.remove();
      });
      img.src = img.dataset.srcs.split('|')[0];
    });
  }

  function tmdbKey() { return String(settings.tmdbKey || CFG.TMDB_API_KEY || '').trim(); }
  let tmdbRunning = false;
  async function enrichTmdb() {
    const key = tmdbKey();
    if (!key || !state.lib || tmdbRunning || DEMO) return;
    tmdbRunning = true;
    const jobs = [
      ...state.lib.movies.map((m) => ['movie', m]),
      ...state.lib.series.map((s) => ['tv', s]),
    ].filter(([k, e]) => !(tmdbKeyFor(k, e) in tmdbCache));
    let i = 0, authFail = false, changed = 0;
    const worker = async () => {
      while (i < jobs.length && !authFail) {
        const [k, e] = jobs[i++];
        try { await tmdbFetch(k, e); changed++; } catch (err) { if (err.message === 'auth') authFail = true; }
        if (changed % 20 === 0) store.set('rd:tmdb', tmdbCache);
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    store.set('rd:tmdb', tmdbCache);
    tmdbRunning = false;
    if (authFail) toast('A chave do TMDB parece inválida. Confira nas Configurações.', 6000);
    else if (changed) refreshArtInPlace();
  }
  async function tmdbFetch(kind, ent) {
    const type = kind === 'movie' ? 'movie' : 'tv';
    const key = tmdbKey();
    const u = new URL(`https://api.themoviedb.org/3/search/${type}`);
    u.searchParams.set('query', ent.title);
    u.searchParams.set('language', 'pt-BR');
    u.searchParams.set('include_adult', 'false');
    if (ent.year) u.searchParams.set(type === 'movie' ? 'year' : 'first_air_date_year', ent.year);
    const headers = {};
    if (key.length > 60) headers.Authorization = 'Bearer ' + key; else u.searchParams.set('api_key', key);
    let r = await fetch(u, { headers });
    if (r.status === 401) throw new Error('auth');
    let j = await r.json();
    if ((!j.results || !j.results.length) && ent.year) {
      u.searchParams.delete(type === 'movie' ? 'year' : 'first_air_date_year');
      r = await fetch(u, { headers });
      j = await r.json();
    }
    const x = j.results && j.results[0];
    tmdbCache[tmdbKeyFor(kind, ent)] = x ? {
      poster: x.poster_path, backdrop: x.backdrop_path, overview: x.overview,
      vote: x.vote_average, title: x.title || x.name, date: x.release_date || x.first_air_date,
    } : null;
  }
  function refreshArtInPlace() {
    $$('img[data-art]').forEach((img) => {
      const [kind, id] = img.dataset.art.split('::');
      const ent = kind === 'movie' ? state.byId.get(id) : state.lib.seriesByKey.get(id);
      if (!ent) return;
      const fn = img.dataset.artType === 'backdrop' ? backdropSources : posterSources;
      const list = fn(kind === 'movie' ? 'movie' : 'tv', ent).filter((u) => state.swReady || !u.startsWith('./stream/'));
      if (list.length && list.join('|') !== img.dataset.srcs) {
        img.dataset.srcs = list.join('|');
        img.dataset.i = '0';
        img.src = list[0];
      }
    });
    // texto de sinopse etc. só aparece ao reabrir a página — re-render leve das telas de detalhe
    const r = route();
    if (r.view === 'serie') onRoute();
  }

  // ---------- cartões ----------
  function metaLine(parts) { return parts.filter(Boolean).map(esc).join(' · '); }
  function progressBar(id) {
    const p = pct(id);
    return p > 1 ? `<div class="pbar"><i style="width:${p.toFixed(1)}%"></i></div>` : '';
  }
  function cardMovie(m) {
    const q = Lib.qualityLabel(m.width, m.height);
    return `<button class="card poster" data-open="movie:${esc(m.id)}" title="${esc(m.title)}">
      <div class="cover" style="--h:${hue(m.title)}"><span class="cover-title">${esc(m.title)}</span>
        ${imgTag(posterSources('movie', m), `data-art="movie::${esc(m.id)}"`)}
        ${q ? `<span class="badge q">${q}</span>` : ''}${progressBar(m.id)}</div>
      <div class="meta"><div class="t">${esc(m.title)}</div><div class="s">${metaLine([m.year, Lib.formatDuration(m.duration)])}</div></div>
    </button>`;
  }
  function cardSeries(s) {
    const n = s.episodes.length;
    return `<button class="card poster" data-open="series:${esc(s.key)}" title="${esc(s.title)}">
      <div class="cover" style="--h:${hue(s.title)}"><span class="cover-title">${esc(s.title)}</span>
        ${imgTag(posterSources('tv', s), `data-art="tv::${esc(s.key)}"`)}</div>
      <div class="meta"><div class="t">${esc(s.title)}</div><div class="s">${metaLine([
        s.seasons.length > 1 ? `${s.seasons.length} temporadas` : `${n} episódio${n > 1 ? 's' : ''}`, s.year])}</div></div>
    </button>`;
  }
  function cardLandscape(it, opts = {}) {
    let title = it.title, sub = '';
    if (it.kind === 'episode') {
      const s = state.lib.seriesByKey.get(it.seriesKey);
      title = s ? s.title : it.name;
      sub = `T${it.season} E${it.episode}${it.epTitle ? ' · ' + it.epTitle : ''}`;
    } else if (it.kind === 'movie') {
      sub = metaLine([it.year, Lib.formatDuration(it.duration)]);
    } else {
      sub = metaLine([it.folderName, formatDate(it.modified)]);
    }
    const srcs = it.kind === 'movie' ? backdropSources('movie', it) : [sized(it.thumb, 640)];
    return `<button class="card wide" data-open="play:${esc(it.id)}" title="${esc(it.name)}">
      <div class="cover" style="--h:${hue(title)}"><span class="cover-title">${esc(title)}</span>
        ${imgTag(srcs)}
        <span class="play-ico">▶</span>
        ${it.duration ? `<span class="badge dur">${Lib.formatDuration(it.duration)}</span>` : ''}
        ${progressBar(it.id)}</div>
      <div class="meta"><div class="t">${esc(opts.title || title)}</div><div class="s">${esc(sub)}</div></div>
    </button>`;
  }
  function cardPhoto(p, ctx) {
    return `<button class="ph" data-open="photo:${esc(p.id)}" data-ctx="${esc(ctx)}" style="--h:${hue(p.name)}" title="${esc(p.name)}">
      ${imgTag([sized(p.thumb, 400), streamUrl(p.id)])}</button>`;
  }
  function formatDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' });
  }
  function row(title, html, link) {
    if (!html) return '';
    return `<section class="row"><div class="row-head"><h2>${esc(title)}</h2>${link ? `<a href="${link}">Ver tudo ›</a>` : ''}</div>
      <div class="row-scroll">${html}</div></section>`;
  }

  // ---------- telas ----------
  function route() {
    const h = location.hash.replace(/^#\/?/, '');
    const [view, ...rest] = h.split('/');
    let arg = rest.join('/');
    try { arg = decodeURIComponent(arg); } catch { /* ignore */ }
    return { view: view || 'inicio', arg };
  }
  function setNav(view) {
    const map = { serie: 'series', busca: '' };
    const v = view in map ? map[view] : view;
    $$('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === v));
  }

  function onRoute() {
    if (!state.lib) return;
    const r = route();
    if (r.view === 'play') { openPlayer(r.arg); return; }
    closePlayerUI();
    state.lastRoute = location.hash || '#/';
    setNav(r.view);
    const main = $('#main');
    const views = { inicio: viewHome, filmes: viewMovies, series: viewSeriesList, serie: viewSeries, videos: viewVideos, fotos: viewPhotos, busca: viewSearch };
    (views[r.view] || viewHome)(main, r.arg);
    wireImages(main);
    if (r.view !== 'busca' && $('#search').value && document.activeElement !== $('#search')) $('#search').value = '';
  }

  function emptyState() {
    return `<div class="empty">
      <h2>Nenhuma mídia encontrada aqui</h2>
      <p>Pasta da biblioteca: <strong>${esc(settings.rootName || 'Drive inteiro')}</strong>.</p>
      <p>Coloque seus arquivos no Drive (de preferência organizados assim) e toque em atualizar:</p>
      <pre>📁 Mídia
 ├ 📁 Filmes
 │   └ 📁 Interestelar (2014) → filme.mp4 + poster.jpg
 ├ 📁 Séries
 │   └ 📁 Breaking Bad → 📁 Temporada 1 → S01E01.mp4…
 ├ 📁 Vídeos
 └ 📁 Fotos</pre>
      <div class="btns"><button class="btn primary" data-action="pick-folder">Escolher pasta</button>
      <button class="btn" data-action="rescan">Atualizar biblioteca</button></div>
    </div>`;
  }

  function viewHome(main) {
    const L = state.lib;
    const total = L.movies.length + L.series.length + L.videos.length + L.photos.length;
    if (!total) { main.innerHTML = emptyState(); return; }

    const heroPool = [...L.movies.map((m) => ['movie', m]), ...L.series.map((s) => ['tv', s])];
    let hero = '';
    if (heroPool.length) {
      const day = Math.floor(Date.now() / 36e5 / 6);
      const [kind, ent] = heroPool[day % heroPool.length];
      const t = tmdbOf(kind, ent);
      const isMovie = kind === 'movie';
      const nu = isMovie ? null : nextUp(ent);
      const p = isMovie ? getProgress(ent.id) : null;
      hero = `<section class="hero">
        <div class="hero-bg" style="--h:${hue(ent.title)}">${imgTag(backdropSources(kind, ent), `data-art="${isMovie ? 'movie::' + esc(ent.id) : 'tv::' + esc(ent.key)}" data-art-type="backdrop"`)}</div>
        <div class="hero-grad"></div>
        <div class="hero-info">
          <span class="eyebrow">${isMovie ? 'Filme' : 'Série'}</span>
          <h1>${esc(ent.title)}</h1>
          <div class="hero-meta">${metaLine([ent.year, isMovie ? Lib.formatDuration(ent.duration) : `${ent.episodes.length} episódios`, isMovie ? Lib.qualityLabel(ent.width, ent.height) : ''])}</div>
          ${t && t.overview ? `<p class="overview clamp">${esc(t.overview)}</p>` : ''}
          <div class="btns">
            <button class="btn primary" data-open="play:${esc(isMovie ? ent.id : nu.ep.id)}">▶ ${isMovie ? (p && p.t > 20 && !isFinished(p) ? 'Continuar' : 'Assistir') : esc(nu.label)}</button>
            <button class="btn ghost" data-open="${isMovie ? 'movie:' + esc(ent.id) : 'series:' + esc(ent.key)}">Mais informações</button>
          </div>
        </div>
      </section>`;
    }
    const cw = continueWatching();
    const recentMovies = [...L.movies].sort((a, b) => (b.modified || '').localeCompare(a.modified || '')).slice(0, 24);
    const recentSeries = [...L.series].sort((a, b) => (b.modified || '').localeCompare(a.modified || '')).slice(0, 24);
    main.innerHTML = `<div class="home">${hero}
      <div class="rows${hero ? ' over' : ''}">
        ${row('Continuar assistindo', cw.map((it) => cardLandscape(it)).join(''))}
        ${row('Filmes adicionados recentemente', recentMovies.map(cardMovie).join(''), '#/filmes')}
        ${row('Séries', recentSeries.map(cardSeries).join(''), '#/series')}
        ${row('Vídeos recentes', L.videos.slice(0, 20).map((v) => cardLandscape(v)).join(''), '#/videos')}
        ${L.photos.length ? row('Fotos recentes', L.photos.slice(0, 30).map((p) => cardPhoto(p, 'all')).join(''), '#/fotos') : ''}
      </div></div>`;
  }

  function sortBar(current, opts) {
    return `<div class="chips sort">${opts.map(([v, l]) => `<button class="chip${v === current ? ' on' : ''}" data-sort="${v}">${l}</button>`).join('')}</div>`;
  }
  function pageHead(title, count, extra = '') {
    return `<div class="page-head"><div><h1>${esc(title)}</h1><span class="count">${count}</span></div>${extra}</div>`;
  }

  function viewMovies(main) {
    const L = state.lib;
    if (!L.movies.length) { main.innerHTML = `<div class="page">${pageHead('Filmes', '')}${emptyState()}</div>`; return; }
    const sort = store.get('rd:sortMovies', 'name');
    const list = [...L.movies];
    if (sort === 'recent') list.sort((a, b) => (b.modified || '').localeCompare(a.modified || ''));
    if (sort === 'year') list.sort((a, b) => (b.year || 0) - (a.year || 0));
    main.innerHTML = `<div class="page">${pageHead('Filmes', `${list.length} filme${list.length > 1 ? 's' : ''}`,
      sortBar(sort, [['name', 'A–Z'], ['recent', 'Recentes'], ['year', 'Ano']]))}
      <div class="grid posters">${list.map(cardMovie).join('')}</div></div>`;
    $$('[data-sort]', main).forEach((b) => b.addEventListener('click', () => { store.set('rd:sortMovies', b.dataset.sort); onRoute(); }));
  }

  function viewSeriesList(main) {
    const L = state.lib;
    if (!L.series.length) { main.innerHTML = `<div class="page">${pageHead('Séries', '')}${emptyState()}</div>`; return; }
    const sort = store.get('rd:sortSeries', 'name');
    const list = [...L.series];
    if (sort === 'recent') list.sort((a, b) => (b.modified || '').localeCompare(a.modified || ''));
    main.innerHTML = `<div class="page">${pageHead('Séries', `${list.length} série${list.length > 1 ? 's' : ''}`,
      sortBar(sort, [['name', 'A–Z'], ['recent', 'Recentes']]))}
      <div class="grid posters">${list.map(cardSeries).join('')}</div></div>`;
    $$('[data-sort]', main).forEach((b) => b.addEventListener('click', () => { store.set('rd:sortSeries', b.dataset.sort); onRoute(); }));
  }

  function viewSeries(main, key) {
    const s = state.lib.seriesByKey.get(key);
    if (!s) { location.hash = '#/series'; return; }
    const t = tmdbOf('tv', s);
    const nu = nextUp(s);
    const season = state.seriesSeason[key] != null && s.seasons.includes(state.seriesSeason[key]) ? state.seriesSeason[key] : nu.ep.season;
    main.innerHTML = `<div class="detail">
      <div class="detail-hero">
        <div class="hero-bg" style="--h:${hue(s.title)}">${imgTag(backdropSources('tv', s), `data-art="tv::${esc(s.key)}" data-art-type="backdrop"`)}</div>
        <div class="hero-grad"></div>
        <div class="detail-info">
          <a class="back" href="#/series">‹ Séries</a>
          <h1>${esc(s.title)}</h1>
          <div class="hero-meta">${metaLine([s.year, s.seasons.length > 1 ? `${s.seasons.length} temporadas` : '', `${s.episodes.length} episódios`, t && t.vote ? `★ ${t.vote.toFixed(1)}` : ''])}</div>
          ${t && t.overview ? `<p class="overview">${esc(t.overview)}</p>` : ''}
          <div class="btns"><button class="btn primary" data-open="play:${esc(nu.ep.id)}">▶ ${esc(nu.label)} <small>T${nu.ep.season}:E${nu.ep.episode}</small></button></div>
        </div>
      </div>
      <div class="season-bar">${s.seasons.length > 1
        ? s.seasons.map((n) => `<button class="chip${n === season ? ' on' : ''}" data-season="${n}">Temporada ${n}</button>`).join('')
        : `<h2>Temporada ${season}</h2>`}</div>
      <div class="episodes" id="episodes"></div>
    </div>`;
    const renderEps = (n) => {
      const eps = s.episodes.filter((e) => e.season === n);
      $('#episodes').innerHTML = eps.map((e) => {
        const p = getProgress(e.id);
        return `<button class="ep" data-open="play:${esc(e.id)}">
          <div class="cover" style="--h:${hue(s.title + e.episode)}"><span class="cover-title">E${e.episode}</span>
            ${imgTag([sized(e.thumb, 640)])}<span class="play-ico">▶</span>${progressBar(e.id)}</div>
          <div class="ep-info">
            <div class="ep-title"><span class="num">${e.episode}.</span> ${esc(e.epTitle || 'Episódio ' + e.episode)}${isFinished(p) ? ' <span class="seen">✓ visto</span>' : ''}</div>
            <div class="s">${metaLine([Lib.formatDuration(e.duration), Lib.qualityLabel(e.width, e.height), Lib.formatSize(e.size)])}</div>
            <div class="file">${esc(e.name)}</div>
          </div></button>`;
      }).join('');
      wireImages($('#episodes'));
    };
    renderEps(season);
    $$('[data-season]', main).forEach((b) => b.addEventListener('click', () => {
      const n = +b.dataset.season;
      state.seriesSeason[key] = n;
      $$('[data-season]', main).forEach((x) => x.classList.toggle('on', x === b));
      renderEps(n);
    }));
  }

  function viewVideos(main, folder) {
    const L = state.lib;
    if (!L.videos.length) { main.innerHTML = `<div class="page">${pageHead('Vídeos', '')}${emptyState()}</div>`; return; }
    const folders = new Map();
    L.videos.forEach((v) => { const f = folders.get(v.folderId) || { id: v.folderId, name: v.folderName, n: 0 }; f.n++; folders.set(v.folderId, f); });
    const fl = [...folders.values()].sort((a, b) => b.n - a.n);
    const list = folder ? L.videos.filter((v) => v.folderId === folder) : L.videos;
    main.innerHTML = `<div class="page">${pageHead('Vídeos', `${list.length} vídeo${list.length > 1 ? 's' : ''}`)}
      ${fl.length > 1 ? `<div class="chips"><a class="chip${!folder ? ' on' : ''}" href="#/videos">Todos</a>${fl.map((f) =>
        `<a class="chip${f.id === folder ? ' on' : ''}" href="#/videos/${encodeURIComponent(f.id)}">${esc(f.name)} <small>${f.n}</small></a>`).join('')}</div>` : ''}
      <div class="grid wides" id="vgrid"></div><div class="sentinel" id="sentinel"></div></div>`;
    incremental($('#vgrid'), list, (v) => cardLandscape(v), 60);
  }

  function viewPhotos(main, album) {
    const L = state.lib;
    if (!L.photos.length) { main.innerHTML = `<div class="page">${pageHead('Fotos', '')}${emptyState()}</div>`; return; }
    const list = album ? L.photos.filter((p) => (p.folderId || '_') === album) : L.photos;
    const ctx = album ? 'album:' + album : 'all';
    main.innerHTML = `<div class="page">${pageHead('Fotos', `${list.length} foto${list.length > 1 ? 's' : ''}`)}
      ${L.albums.length > 1 ? `<div class="albums">
        <a class="album${!album ? ' on' : ''}" href="#/fotos"><div class="album-cover all">★</div><span>Todas</span><small>${L.photos.length}</small></a>
        ${L.albums.map((a) => {
          const c = state.byId.get(a.cover);
          return `<a class="album${a.id === album ? ' on' : ''}" href="#/fotos/${encodeURIComponent(a.id)}">
            <div class="album-cover" style="--h:${hue(a.name)}">${c ? imgTag([sized(c.thumb, 300), streamUrl(c.id)]) : ''}</div>
            <span>${esc(a.name)}</span><small>${a.count}</small></a>`;
        }).join('')}</div>` : ''}
      <div class="grid photos" id="pgrid"></div><div class="sentinel" id="sentinel"></div></div>`;
    incremental($('#pgrid'), list, (p) => cardPhoto(p, ctx), 120);
  }

  function viewSearch(main, q) {
    const L = state.lib;
    const term = Lib.slug(q).replace(/-/g, ' ');
    const match = (s) => Lib.slug(s).replace(/-/g, ' ').includes(term);
    const movies = L.movies.filter((m) => match(m.title) || match(m.name));
    const series = L.series.filter((s) => match(s.title));
    const eps = [];
    L.series.forEach((s) => s.episodes.forEach((e) => { if (e.epTitle && match(e.epTitle)) eps.push(e); }));
    const videos = L.videos.filter((v) => match(v.name) || match(v.folderName));
    const photos = L.photos.filter((p) => match(p.name) || match(p.folderName));
    const none = !movies.length && !series.length && !eps.length && !videos.length && !photos.length;
    main.innerHTML = `<div class="page">${pageHead(`Resultados para “${q}”`, '')}
      ${none ? '<div class="empty"><p>Nada encontrado.</p></div>' : ''}
      ${movies.length ? `<h2 class="sec">Filmes</h2><div class="grid posters">${movies.slice(0, 60).map(cardMovie).join('')}</div>` : ''}
      ${series.length ? `<h2 class="sec">Séries</h2><div class="grid posters">${series.slice(0, 60).map(cardSeries).join('')}</div>` : ''}
      ${eps.length ? `<h2 class="sec">Episódios</h2><div class="grid wides">${eps.slice(0, 40).map((e) => cardLandscape(e)).join('')}</div>` : ''}
      ${videos.length ? `<h2 class="sec">Vídeos</h2><div class="grid wides">${videos.slice(0, 60).map((v) => cardLandscape(v)).join('')}</div>` : ''}
      ${photos.length ? `<h2 class="sec">Fotos</h2><div class="grid photos">${photos.slice(0, 120).map((p) => cardPhoto(p, 'search:' + q)).join('')}</div>` : ''}
    </div>`;
  }

  let incObserver = null;
  function incremental(container, list, render, step) {
    if (incObserver) incObserver.disconnect();
    let i = 0;
    const more = () => {
      const chunk = list.slice(i, i + step);
      i += chunk.length;
      container.insertAdjacentHTML('beforeend', chunk.map(render).join(''));
      wireImages(container);
      if (i >= list.length && incObserver) incObserver.disconnect();
    };
    more();
    const sentinel = $('#sentinel');
    if (sentinel && i < list.length) {
      incObserver = new IntersectionObserver((ents) => { if (ents.some((e) => e.isIntersecting)) more(); }, { rootMargin: '800px' });
      incObserver.observe(sentinel);
    }
  }

  // ---------- modal ----------
  function openModal(html, cls = '') {
    const root = $('#modalRoot');
    root.innerHTML = `<div class="modal ${cls}"><div class="modal-back" data-close></div><div class="modal-card">${html}</div></div>`;
    document.body.classList.add('no-scroll');
    wireImages(root);
    $$('[data-close]', root).forEach((el) => el.addEventListener('click', closeModal));
    return root.firstElementChild;
  }
  function closeModal() {
    $('#modalRoot').innerHTML = '';
    if ($('#player').hidden && $('#lightbox').hidden) document.body.classList.remove('no-scroll');
  }

  function openMovie(id) {
    const m = state.byId.get(id);
    if (!m) return;
    const t = tmdbOf('movie', m);
    const p = getProgress(m.id);
    const resume = p && p.t > 20 && !isFinished(p);
    openModal(`
      <div class="modal-hero" style="--h:${hue(m.title)}">${imgTag(backdropSources('movie', m))}
        <div class="hero-grad"></div><button class="close" data-close aria-label="Fechar">✕</button>
        <div class="modal-hero-info"><h2>${esc(m.title)}</h2>
          <div class="hero-meta">${metaLine([m.year, Lib.formatDuration(m.duration), Lib.qualityLabel(m.width, m.height), t && t.vote ? `★ ${t.vote.toFixed(1)}` : ''])}</div>
          <div class="btns">
            <button class="btn primary" data-open="play:${esc(m.id)}">▶ ${resume ? 'Continuar de ' + Lib.formatClock(p.t) : 'Assistir'}</button>
            ${resume ? `<button class="btn ghost" data-action="restart" data-id="${esc(m.id)}">Do início</button>` : ''}
          </div></div>
      </div>
      <div class="modal-body">
        ${t && t.overview ? `<p class="overview">${esc(t.overview)}</p>` : ''}
        <dl class="facts"><dt>Arquivo</dt><dd>${esc(m.name)}</dd><dt>Pasta</dt><dd>${esc(m.folderName)}</dd>
        ${m.size ? `<dt>Tamanho</dt><dd>${Lib.formatSize(m.size)}</dd>` : ''}
        ${m.width ? `<dt>Resolução</dt><dd>${m.width}×${m.height}</dd>` : ''}</dl>
      </div>`, 'movie');
  }

  // ---------- seletor de pasta ----------
  function openFolderPicker(firstRun = false) {
    const raw = state.raw;
    if (!raw) return;
    const media = raw.files.filter((f) => !/^(poster|capa|cover|folder|fanart|backdrop|background|banner|fundo)\./i.test(f.name));
    const counts = Lib.countMediaByFolder(raw.folders, media);
    const fmap = new Map(raw.folders.map((f) => [f.id, f]));
    const children = new Map();
    raw.folders.forEach((f) => {
      let p = f.parents && f.parents[0];
      if (!p || (!fmap.has(p) && p !== raw.myDriveId)) p = '__shared';
      if (p === raw.myDriveId) p = '__mydrive';
      if (!children.has(p)) children.set(p, []);
      children.get(p).push(f);
    });
    const myCount = counts.get(raw.myDriveId) || 0;
    const sharedCount = (children.get('__shared') || []).reduce((n, f) => n + (counts.get(f.id) || 0), 0);
    let stack = []; // [{id,name}]

    const modal = openModal(`<div class="picker">
      <h2>${firstRun ? 'Onde estão seus vídeos e fotos?' : 'Pasta da biblioteca'}</h2>
      <p class="muted">Escolha a pasta que o site vai organizar. Assim ele ignora o resto do seu Drive (documentos, prints etc.).</p>
      <div class="crumbs" id="crumbs"></div>
      <div class="folder-list" id="flist"></div>
      <div class="picker-actions">
        <button class="btn" id="useAll">Usar o Drive inteiro <small>(${raw.files.length})</small></button>
        <button class="btn primary" id="useThis" hidden>Usar esta pasta</button>
      </div></div>`, 'picker-modal');

    const render = () => {
      const cur = stack[stack.length - 1];
      $('#crumbs', modal).innerHTML = `<button data-crumb="-1">Início</button>` + stack.map((s, i) => `<span>›</span><button data-crumb="${i}">${esc(s.name)}</button>`).join('');
      let items;
      if (!cur) {
        items = [
          { id: '__mydrive', name: 'Meu Drive', n: myCount, icon: '💾' },
          ...(sharedCount ? [{ id: '__shared', name: 'Compartilhados comigo', n: sharedCount, icon: '👥' }] : []),
        ];
      } else {
        items = (children.get(cur.id) || [])
          .map((f) => ({ id: f.id, name: f.name, n: counts.get(f.id) || 0, icon: '📁' }))
          .filter((f) => f.n > 0)
          .sort((a, b) => Lib.naturalCompare(a.name, b.name));
      }
      $('#flist', modal).innerHTML = items.length ? items.map((f) =>
        `<button class="folder" data-fid="${esc(f.id)}" data-fname="${esc(f.name)}"><span class="fi">${f.icon}</span><span class="fn">${esc(f.name)}</span><span class="fc">${f.n} mídia${f.n === 1 ? '' : 's'} ›</span></button>`).join('')
        : '<p class="muted center">Sem subpastas com mídia aqui.</p>';
      const useThis = $('#useThis', modal);
      useThis.hidden = !cur || cur.id === '__shared';
      if (cur) useThis.textContent = `Usar “${cur.name}”`;
    };
    render();
    modal.addEventListener('click', (e) => {
      const f = e.target.closest('[data-fid]');
      if (f) { stack.push({ id: f.dataset.fid, name: f.dataset.fname }); render(); return; }
      const c = e.target.closest('[data-crumb]');
      if (c) { stack = stack.slice(0, +c.dataset.crumb + 1); render(); }
    });
    const choose = (root, name) => {
      settings.root = root;
      settings.rootName = name;
      saveSettings();
      closeModal();
      rebuild();
      if (!location.hash || location.hash === '#/') onRoute(); else location.hash = '#/';
      enrichTmdb();
    };
    $('#useAll', modal).addEventListener('click', () => choose(null, 'Drive inteiro'));
    $('#useThis', modal).addEventListener('click', () => {
      const cur = stack[stack.length - 1];
      choose(cur.id === '__mydrive' ? 'mydrive' : cur.id, cur.name);
    });
  }

  // ---------- configurações ----------
  function openSettings() {
    const u = state.user;
    const L = state.lib;
    const modal = openModal(`<div class="settings">
      <div class="set-head"><h2>Configurações</h2><button class="close" data-close aria-label="Fechar">✕</button></div>
      ${u ? `<div class="account">${u.photoLink ? `<img src="${esc(u.photoLink)}" alt="" referrerpolicy="no-referrer">` : ''}
        <div><strong>${esc(u.displayName || '')}</strong><span>${esc(u.emailAddress || '')}</span></div></div>` : ''}
      ${DEMO ? '<p class="muted">Modo demonstração — dados de exemplo.</p>' : ''}
      <div class="set-group">
        <label>Pasta da biblioteca</label>
        <div class="set-row"><span>${esc(settings.rootName || 'Drive inteiro')}</span><button class="btn small" data-action="pick-folder">Alterar</button></div>
        <p class="muted">${L ? `${L.movies.length} filmes · ${L.series.length} séries · ${L.videos.length} vídeos · ${L.photos.length} fotos` : ''}</p>
      </div>
      <div class="set-group">
        <label for="minMovie">Vídeos com mais de quantos minutos viram “Filme”?</label>
        <div class="set-row"><input id="minMovie" type="number" min="0" max="600" value="${esc(settings.minMovie)}"><span class="muted">0 = só os que estão em pasta “Filmes”</span></div>
      </div>
      <div class="set-group">
        <label for="tmdbKey">Chave do TMDB (opcional — capas e sinopses automáticas)</label>
        <input id="tmdbKey" type="text" placeholder="Cole aqui sua API Key (v3) ou Token de leitura" value="${esc(settings.tmdbKey)}" autocomplete="off" spellcheck="false">
        <p class="muted">Grátis em themoviedb.org → Configurações → API. Só os títulos são enviados ao TMDB.</p>
      </div>
      <div class="set-actions">
        <button class="btn" data-action="rescan">Atualizar biblioteca</button>
        <button class="btn" data-action="clear-progress">Limpar “Continuar assistindo”</button>
        ${DEMO ? '' : '<button class="btn danger" data-action="logout">Desconectar</button>'}
      </div></div>`, 'settings-modal');

    $('#minMovie', modal).addEventListener('change', (e) => {
      settings.minMovie = Math.max(0, +e.target.value || 0);
      saveSettings(); rebuild(); onRoute();
    });
    $('#tmdbKey', modal).addEventListener('change', (e) => {
      settings.tmdbKey = e.target.value.trim();
      saveSettings();
      if (settings.tmdbKey) {
        Object.keys(tmdbCache).forEach((k) => { if (tmdbCache[k] === null) delete tmdbCache[k]; });
        toast('Buscando capas no TMDB…');
        enrichTmdb();
      }
    });
  }

  async function logout() {
    try { if (state.token && window.google) google.accounts.oauth2.revoke(state.token.access_token, () => {}); } catch { /* ignore */ }
    state.token = null;
    try { sessionStorage.removeItem('rd:token'); } catch { /* ignore */ }
    store.del('rd:raw'); store.del('rd:connected');
    const c = navigator.serviceWorker && navigator.serviceWorker.controller;
    if (c) c.postMessage({ type: 'logout' });
    state.lib = null; state.raw = null; state.user = null;
    closeModal();
    history.replaceState(null, '', location.pathname + location.search);
    renderWelcome();
  }

  // ---------- player ----------
  const video = () => $('#video');
  function openPlayer(id) {
    const it = state.byId.get(id);
    if (!it || it.kind === 'photo') { toast('Arquivo não encontrado na biblioteca.'); location.replace('#/'); return; }
    closeModal();
    const P = $('#player');
    P.hidden = false;
    document.body.classList.add('no-scroll');
    state.playing = it;
    const seq = ++state.playSeq;

    let title = it.title || it.name, sub = '';
    if (it.kind === 'episode') {
      const s = state.lib.seriesByKey.get(it.seriesKey);
      title = s ? s.title : it.name;
      sub = `T${it.season}:E${it.episode}${it.epTitle ? ' · ' + it.epTitle : ''}`;
    } else if (it.kind === 'movie' && it.year) sub = String(it.year);
    else sub = it.folderName || '';
    $('#pTitle').textContent = title;
    $('#pSub').textContent = sub;
    document.title = `${title} — ${CFG.APP_NAME}`;
    $('#pOpen').href = driveViewUrl(it.id);
    const nx = nextEpisode(it);
    $('#pNext').hidden = !nx;
    hidePlayerMsg();
    showBar();

    const v = video();
    v.pause();
    $$('track', v).forEach((t) => { if (t.src.startsWith('blob:')) URL.revokeObjectURL(t.src); t.remove(); });

    if (DEMO) { setPlayerMode('direct'); v.removeAttribute('src'); v.load(); showPlayerMsg('<p>Modo demonstração: conecte seu Google Drive para assistir.</p>'); return; }
    if (!state.swReady) {
      setPlayerMode('drive');
      showPlayerMsg('<p>O streaming direto não está ativo neste navegador (abra o site pelo endereço https do GitHub Pages e recarregue). Usando o player do Drive.</p>', 6000);
      return;
    }
    setPlayerMode(state.playerMode === 'drive' ? 'drive' : 'direct');
    if (state.playerMode === 'direct') startDirect(it, seq);
  }

  function startDirect(it, seq, at) {
    const v = video();
    v.src = streamUrl(it.id);
    const p = getProgress(it.id);
    const startAt = at != null ? at : (p && p.t > 15 && !isFinished(p) ? Math.max(0, p.t - 3) : 0);
    if (startAt) v.addEventListener('loadedmetadata', () => { if (seq === state.playSeq) v.currentTime = startAt; }, { once: true });
    v.play().catch(() => { /* autoplay bloqueado — o usuário toca no play */ });
    if (startAt > 30 && at == null) toast(`Continuando de ${Lib.formatClock(startAt)}`, 2500);
    loadSubtitles(it, seq);
  }

  function setPlayerMode(mode) {
    state.playerMode = mode;
    const v = video(), fr = $('#driveFrame'), it = state.playing;
    if (mode === 'drive') {
      v.pause(); v.removeAttribute('src'); v.load(); v.hidden = true;
      fr.hidden = false;
      if (it) fr.src = `https://drive.google.com/file/d/${it.id}/preview`;
      $('#pMode').textContent = 'Player direto (original)';
    } else {
      fr.hidden = true; fr.src = 'about:blank';
      v.hidden = false;
      $('#pMode').textContent = 'Player do Drive';
    }
  }

  async function loadSubtitles(it, seq) {
    if (!it.folderId) return;
    try {
      const files = await listAll(`'${it.folderId}' in parents and trashed=false and mimeType != '${FOLDER_MIME}'`, 'id,name,mimeType');
      if (seq !== state.playSeq) return;
      const base = Lib.stripExt(it.name).toLowerCase();
      const subs = files.filter((f) => /\.(srt|vtt)$/i.test(f.name));
      if (!subs.length) return;
      const videosHere = files.filter((f) => Lib.isVideoFile(f)).length;
      let match = subs.filter((f) => f.name.toLowerCase().startsWith(base));
      if (!match.length && videosHere === 1) match = subs;
      if (!match.length) return;
      match.sort((a, b) => (/pt|por|br/i.test(b.name) ? 1 : 0) - (/pt|por|br/i.test(a.name) ? 1 : 0));
      const v = video();
      let first = true;
      for (const s of match.slice(0, 6)) {
        const text = await fetchFileText(s.id);
        if (seq !== state.playSeq) return;
        const vtt = Lib.srtToVtt(text);
        const tr = document.createElement('track');
        tr.kind = 'subtitles';
        const tag = Lib.stripExt(s.name).slice(base.length).replace(/^[\s._-]+/, '');
        tr.label = tag || 'Legenda';
        tr.srclang = /en/i.test(tag) ? 'en' : /es/i.test(tag) ? 'es' : 'pt';
        tr.src = URL.createObjectURL(new Blob([vtt], { type: 'text/vtt' }));
        v.appendChild(tr);
        const tt = v.textTracks[v.textTracks.length - 1];
        if (tt) tt.mode = first ? 'showing' : 'hidden';
        first = false;
      }
      toast(match.length > 1 ? `${match.length} legendas carregadas` : 'Legenda carregada', 2000);
    } catch (e) { console.warn('Legendas', e); }
  }

  function showPlayerMsg(html, autoHideMs) {
    const m = $('#playerMsg');
    m.innerHTML = html;
    m.hidden = false;
    if (autoHideMs) setTimeout(() => { if (m.innerHTML === html) m.hidden = true; }, autoHideMs);
    return m;
  }
  function hidePlayerMsg() { $('#playerMsg').hidden = true; clearInterval(state.nextTimer); }

  function closePlayerUI() {
    const P = $('#player');
    if (P.hidden) return;
    const v = video();
    if (state.playing && v.currentTime && v.duration) setProgress(state.playing.id, v.currentTime, v.duration);
    v.pause(); v.removeAttribute('src'); v.load();
    $('#driveFrame').src = 'about:blank';
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    P.hidden = true;
    hidePlayerMsg();
    state.playing = null;
    state.playSeq++;
    document.title = CFG.APP_NAME;
    if ($('#lightbox').hidden && !$('#modalRoot').innerHTML) document.body.classList.remove('no-scroll');
  }
  function leavePlayer() {
    if (state.openedPlayerFromApp) { state.openedPlayerFromApp = false; history.back(); }
    else location.hash = state.lastRoute && !state.lastRoute.startsWith('#/play') ? state.lastRoute : '#/';
  }
  function play(id) {
    state.openedPlayerFromApp = true;
    location.hash = '#/play/' + encodeURIComponent(id);
  }

  async function diagnoseVideoError() {
    const it = state.playing;
    if (!it) return;
    const seq = state.playSeq;
    const at = video().currentTime || (getProgress(it.id) || {}).t || 0;
    let status = 0;
    try { status = (await fetch(streamUrl(it.id), { headers: { Range: 'bytes=0-1' } })).status; } catch { status = 0; }
    if (seq !== state.playSeq) return;
    if (status === 401) {
      const m = showPlayerMsg(`<p>A conexão com o Google expirou.</p><button class="btn primary" id="msgRenew">Reconectar e continuar</button>`);
      $('#msgRenew', m).addEventListener('click', async () => {
        if (await renewInteractive()) { hidePlayerMsg(); startDirect(it, state.playSeq, at); }
      });
    } else if (status === 403 || status === 404) {
      showPlayerMsg(`<p>O Google Drive recusou o acesso a este arquivo (erro ${status}). Ele pode ter sido removido, ou o Drive limitou downloads deste arquivo por hoje.</p>
        <button class="btn" data-action="drive-player">Tentar no player do Drive</button>`);
    } else if (status === 206 || status === 200) {
      setPlayerMode('drive');
      showPlayerMsg('<p>O navegador não reproduz este formato (comum em MKV com H.265/HEVC, AVI, WMV). Abrimos no player do Google Drive, que converte o vídeo. Para qualidade original em qualquer navegador, prefira MP4 (H.264).</p>', 9000);
    } else {
      const m = showPlayerMsg(`<p>Falha de conexão ao carregar o vídeo.</p><button class="btn primary" id="msgRetry">Tentar de novo</button>`);
      $('#msgRetry', m).addEventListener('click', () => { hidePlayerMsg(); startDirect(it, state.playSeq, at); });
    }
  }
  function resumeAfterAuth() {
    const it = state.playing, v = video();
    if (!it || state.playerMode !== 'direct') return;
    if (v.error || v.readyState < 2) {
      const at = v.currentTime || (getProgress(it.id) || {}).t || 0;
      hidePlayerMsg();
      startDirect(it, state.playSeq, at);
    }
  }

  function startNextCountdown(nx) {
    let n = 8;
    const m = showPlayerMsg(`<p>Próximo episódio em <b id="nxN">${n}</b>s</p><p class="muted">T${nx.season}:E${nx.episode}${nx.epTitle ? ' · ' + esc(nx.epTitle) : ''}</p>
      <div class="btns"><button class="btn primary" id="nxGo">Assistir agora</button><button class="btn" id="nxCancel">Cancelar</button></div>`);
    const go = () => { clearInterval(state.nextTimer); location.replace('#/play/' + encodeURIComponent(nx.id)); };
    $('#nxGo', m).addEventListener('click', go);
    $('#nxCancel', m).addEventListener('click', hidePlayerMsg);
    clearInterval(state.nextTimer);
    state.nextTimer = setInterval(() => { n--; const el = $('#nxN'); if (el) el.textContent = n; if (n <= 0) go(); }, 1000);
  }

  let barTimer = null;
  function showBar() {
    const P = $('#player');
    P.classList.remove('idle');
    clearTimeout(barTimer);
    barTimer = setTimeout(() => { if (!video().paused && state.playerMode === 'direct') P.classList.add('idle'); }, 3000);
  }

  function wirePlayer() {
    const v = video();
    let lastSave = 0;
    v.addEventListener('timeupdate', () => {
      if (!state.playing) return;
      const now = Date.now();
      if (now - lastSave > 4000) { lastSave = now; setProgress(state.playing.id, v.currentTime, v.duration); }
    });
    v.addEventListener('pause', () => { if (state.playing && v.duration) setProgress(state.playing.id, v.currentTime, v.duration); showBar(); });
    v.addEventListener('ended', () => {
      if (!state.playing) return;
      setProgress(state.playing.id, v.duration, v.duration);
      const nx = nextEpisode(state.playing);
      if (nx) startNextCountdown(nx);
    });
    v.addEventListener('error', () => { if (v.getAttribute('src')) diagnoseVideoError(); });
    $('#player').addEventListener('mousemove', showBar);
    $('#player').addEventListener('touchstart', showBar, { passive: true });
    $('#pBack').addEventListener('click', leavePlayer);
    $('#pNext').addEventListener('click', () => { const nx = nextEpisode(state.playing); if (nx) location.replace('#/play/' + encodeURIComponent(nx.id)); });
    $('#pMode').addEventListener('click', () => {
      const it = state.playing;
      if (!it) return;
      if (state.playerMode === 'direct') setPlayerMode('drive');
      else if (state.swReady) { setPlayerMode('direct'); startDirect(it, state.playSeq); }
      else toast('O player direto precisa do site aberto em https.');
    });
  }

  // ---------- fotos ----------
  const lb = { list: [], i: 0 };
  function photoList(ctx) {
    const L = state.lib;
    if (ctx.startsWith('album:')) { const a = ctx.slice(6); return L.photos.filter((p) => (p.folderId || '_') === a); }
    if (ctx.startsWith('search:')) { const r = route(); const term = Lib.slug(r.arg).replace(/-/g, ' '); return L.photos.filter((p) => Lib.slug(p.name + ' ' + p.folderName).replace(/-/g, ' ').includes(term)); }
    return L.photos;
  }
  function openLightbox(id, ctx) {
    lb.list = photoList(ctx || 'all');
    lb.i = Math.max(0, lb.list.findIndex((p) => p.id === id));
    $('#lightbox').hidden = false;
    document.body.classList.add('no-scroll');
    showPhoto();
  }
  function showPhoto() {
    const p = lb.list[lb.i];
    if (!p) return;
    const img = $('#lbImg');
    img.classList.remove('ok');
    const full = state.swReady && !DEMO ? streamUrl(p.id) : null;
    const preview = sized(p.thumb, 1600);
    img.onload = () => img.classList.add('ok');
    img.onerror = () => { if (full && img.src !== new URL(full, location.href).href) img.src = full; };
    img.src = preview || full || '';
    if (full && preview) {
      const hi = new Image();
      const want = p.id;
      hi.onload = () => { if (lb.list[lb.i] && lb.list[lb.i].id === want) img.src = full; };
      hi.src = full;
    }
    $('#lbCount').textContent = `${lb.i + 1} / ${lb.list.length}`;
    $('#lbName').textContent = p.name;
    $('#lbOpen').href = driveViewUrl(p.id);
    const dl = $('#lbDownload');
    if (full) { dl.href = full; dl.download = p.name; dl.hidden = false; } else dl.hidden = true;
    $('#lbPrev').hidden = lb.i === 0;
    $('#lbNext').hidden = lb.i >= lb.list.length - 1;
    [lb.list[lb.i + 1], lb.list[lb.i - 1]].forEach((n) => { if (n && n.thumb) new Image().src = sized(n.thumb, 1600); });
  }
  function closeLightbox() {
    $('#lightbox').hidden = true;
    $('#lbImg').removeAttribute('src');
    if ($('#player').hidden && !$('#modalRoot').innerHTML) document.body.classList.remove('no-scroll');
  }
  function stepPhoto(d) {
    const n = lb.i + d;
    if (n < 0 || n >= lb.list.length) return;
    lb.i = n;
    showPhoto();
  }
  function wireLightbox() {
    $('#lbClose').addEventListener('click', closeLightbox);
    $('#lbPrev').addEventListener('click', () => stepPhoto(-1));
    $('#lbNext').addEventListener('click', () => stepPhoto(1));
    $('.lb-stage').addEventListener('click', (e) => { if (e.target.classList.contains('lb-stage')) closeLightbox(); });
    let sx = null, sy = null;
    const box = $('#lightbox');
    box.addEventListener('touchstart', (e) => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; }, { passive: true });
    box.addEventListener('touchend', (e) => {
      if (sx == null) return;
      const dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) stepPhoto(dx < 0 ? 1 : -1);
      else if (dy > 90 && Math.abs(dy) > Math.abs(dx)) closeLightbox();
      sx = sy = null;
    });
  }

  // ---------- eventos globais ----------
  function wireGlobal() {
    document.addEventListener('click', (e) => {
      const o = e.target.closest('[data-open]');
      if (o) {
        e.preventDefault();
        const v = o.dataset.open;
        const i = v.indexOf(':');
        const kind = v.slice(0, i), id = v.slice(i + 1);
        if (kind === 'movie') openMovie(id);
        else if (kind === 'series') { closeModal(); location.hash = '#/serie/' + encodeURIComponent(id); }
        else if (kind === 'play') play(id);
        else if (kind === 'photo') openLightbox(id, o.dataset.ctx);
        return;
      }
      const a = e.target.closest('[data-action]');
      if (!a) return;
      const act = a.dataset.action;
      if (act === 'pick-folder') { closeModal(); openFolderPicker(); }
      else if (act === 'rescan') { closeModal(); manualRescan(); }
      else if (act === 'logout') logout();
      else if (act === 'clear-progress') { progress = {}; store.set('rd:progress', progress); toast('Histórico limpo.'); closeModal(); onRoute(); }
      else if (act === 'restart') { const id = a.dataset.id; delete progress[id]; saveProgress(); play(id); }
      else if (act === 'drive-player') { hidePlayerMsg(); setPlayerMode('drive'); }
      else if (act === 'connect') connect();
    });

    window.addEventListener('hashchange', onRoute);
    $('#btnSettings').addEventListener('click', openSettings);
    $('#btnRenew').addEventListener('click', renewInteractive);

    const search = $('#search');
    search.addEventListener('input', debounce(() => {
      const q = search.value.trim();
      if (q.length >= 2) location.replace('#/busca/' + encodeURIComponent(q));
      else if (!q && route().view === 'busca') location.replace('#/');
    }, 250));

    document.addEventListener('keydown', (e) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target && e.target.tagName) || '');
      if (!$('#lightbox').hidden) {
        if (e.key === 'ArrowRight') stepPhoto(1);
        else if (e.key === 'ArrowLeft') stepPhoto(-1);
        else if (e.key === 'Escape') closeLightbox();
        return;
      }
      if ($('#modalRoot').innerHTML && e.key === 'Escape') { closeModal(); return; }
      if (!$('#player').hidden && !typing) {
        const v = video();
        if (e.key === 'Escape' && !document.fullscreenElement) leavePlayer();
        else if (state.playerMode !== 'direct') return;
        else if (e.key === ' ' || e.key === 'k') { if (e.target !== v) { e.preventDefault(); v.paused ? v.play() : v.pause(); } }
        else if (e.key === 'ArrowRight' && e.target !== v) v.currentTime = Math.min(v.duration || 0, v.currentTime + 10);
        else if (e.key === 'ArrowLeft' && e.target !== v) v.currentTime = Math.max(0, v.currentTime - 10);
        else if (e.key === 'f') { document.fullscreenElement ? document.exitFullscreen() : $('#player').requestFullscreen().catch(() => v.requestFullscreen && v.requestFullscreen()); }
        else if (e.key === 'n') { const nx = nextEpisode(state.playing); if (nx) location.replace('#/play/' + encodeURIComponent(nx.id)); }
        showBar();
      }
    });
    let lastY = 0;
    window.addEventListener('scroll', () => {
      const y = window.scrollY;
      $('#topbar').classList.toggle('solid', y > 30);
      lastY = y;
    }, { passive: true });
  }

  async function manualRescan() {
    try {
      await scanDrive();
      rebuild();
      setLoading(false);
      onRoute();
      toast('Biblioteca atualizada.');
      enrichTmdb();
    } catch (e) {
      setLoading(false);
      if (!(e instanceof AuthError)) toast('Erro ao ler o Drive: ' + e.message, 6000);
    }
  }

  // ---------- telas de entrada ----------
  function renderWelcome() {
    $('#topbar').hidden = true;
    const back = store.get('rd:connected', false);
    $('#main').innerHTML = `<section class="welcome">
      <div class="welcome-bg"></div>
      <div class="welcome-card">
        <div class="brand big"><span class="brand-mark">▶</span><span>${esc(CFG.APP_NAME)}</span></div>
        <h1>${back ? 'Bem-vindo de volta.' : 'Seu Google Drive vira um cinema.'}</h1>
        <p>Filmes, séries, vídeos e fotos do seu Drive — organizados sozinhos e tocando na qualidade original.</p>
        <button class="btn google" data-action="connect">
          <svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>
          Conectar Google Drive</button>
        <ul class="features">
          <li><b>🎬 Filmes e séries</b><span>Temporadas e episódios montados pelos nomes dos arquivos e pastas.</span></li>
          <li><b>⚡ Qualidade original</b><span>O arquivo vem direto do Drive, sem recompressão, com avanço rápido.</span></li>
          <li><b>🖼️ Fotos e vídeos</b><span>Álbuns por pasta, visualizador em tela cheia e deslizar no celular.</span></li>
        </ul>
        <p class="fine">Tudo roda no seu navegador, com acesso só de leitura. Seus arquivos não passam por nenhum outro servidor.</p>
      </div></section>`;
  }
  function renderSetupNeeded() {
    $('#topbar').hidden = true;
    $('#main').innerHTML = `<section class="welcome"><div class="welcome-bg"></div><div class="welcome-card">
      <div class="brand big"><span class="brand-mark">▶</span><span>${esc(CFG.APP_NAME)}</span></div>
      <h1>Quase lá!</h1>
      <p>Falta colar o <b>Client ID do Google</b> no arquivo <code>config.js</code>. O passo a passo está no <code>README.md</code> (leva uns 10 minutos, uma vez só).</p>
      <p class="fine">Origem para cadastrar no Google Cloud: <code>${esc(location.origin)}</code></p>
      <p><a class="btn ghost" href="?demo">Ver demonstração</a></p>
    </div></section>`;
  }

  async function connect() {
    if (!state.gisReady) {
      try { await loadGis(); initTokenClient(); } catch (e) { toast(e.message, 6000); return; }
    }
    const t = await requestToken();
    if (!t) { toast('Login cancelado ou bloqueado. Permita pop-ups para este site e tente de novo.', 6000); return; }
    await startApp();
  }

  async function startApp() {
    $('#topbar').hidden = false;
    drive('about', { fields: 'user(displayName,emailAddress,photoLink)' }).then((r) => {
      state.user = r.user;
      if (r.user && r.user.photoLink) { const a = $('#avatar'); a.src = r.user.photoLink; a.hidden = false; $('#gear').style.display = 'none'; }
    }).catch(() => {});

    const cached = store.get('rd:raw', null);
    try {
      if (cached && cached.files) {
        state.raw = cached;
      } else {
        await scanDrive();
      }
    } catch (e) {
      setLoading(false);
      if (!(e instanceof AuthError)) {
        $('#main').innerHTML = `<div class="empty"><h2>Não foi possível ler o seu Drive</h2><p>${esc(e.message)}</p>
          <p class="muted">Confira se a “Google Drive API” está ativada no seu projeto do Google Cloud.</p>
          <button class="btn primary" data-action="rescan">Tentar de novo</button></div>`;
      }
      return;
    }
    setLoading(false);
    rebuild();
    onRoute();
    if (settings.root === undefined) openFolderPicker(true);
    if (cached) refreshInBackground().then(enrichTmdb); else enrichTmdb();
  }

  // ---------- demonstração ----------
  function demoRaw() {
    const F = (id, name, p) => ({ id, name, parents: [p] });
    const folders = [F('m', 'Mídia', 'R'), F('f', 'Filmes', 'm'), F('s', 'Séries', 'm'), F('v', 'Vídeos', 'm'), F('p', 'Fotos', 'm'),
      F('bb', 'Breaking Bad (2008)', 's'), F('bb1', 'Temporada 1', 'bb'), F('bb2', 'Temporada 2', 'bb'), F('dk', 'Dark (2017)', 's'),
      F('pa', 'Praia 2024', 'p'), F('an', 'Aniversário da vó', 'p'), F('vi', 'Viagem Gramado', 'v')];
    let n = 0;
    const V = (name, p, min, h = 1080) => ({ id: 'demo' + (n++) + 'xxxxxxxxxx', name, mimeType: 'video/mp4', parents: [p], size: String(min * 2.2e7),
      modifiedTime: new Date(Date.now() - n * 864e5).toISOString(), videoMediaMetadata: { durationMillis: min * 60000, width: Math.round(h * 16 / 9), height: h } });
    const I = (name, p) => ({ id: 'demo' + (n++) + 'xxxxxxxxxx', name, mimeType: 'image/jpeg', parents: [p], modifiedTime: new Date(Date.now() - n * 36e5).toISOString() });
    const files = [
      V('Interestelar.2014.2160p.BluRay.x265.mp4', 'f', 169, 2160), V('Cidade.de.Deus.2002.1080p.mp4', 'f', 130), V('Tropa de Elite (2007) 1080p.mp4', 'f', 115),
      V('O.Auto.da.Compadecida.2000.720p.mp4', 'f', 104, 720), V('Matrix.1999.1080p.BluRay.mp4', 'f', 136), V('Duna.Parte.Dois.2024.2160p.mp4', 'f', 166, 2160),
      V('Central do Brasil (1998).mp4', 'f', 113), V('Bacurau.2019.1080p.WEB-DL.mp4', 'f', 131),
      ...[1, 2, 3, 4, 5, 6, 7].map((e) => V(`Breaking.Bad.S01E0${e}.720p.mp4`, 'bb1', 47, 720)),
      ...[1, 2, 3, 4, 5].map((e) => V(`Breaking.Bad.S02E0${e}.720p.mp4`, 'bb2', 47, 720)),
      ...[1, 2, 3, 4].map((e) => V(`Dark.S01E0${e}.1080p.mp4`, 'dk', 52)),
      V('VID_20240112_183000.mp4', 'vi', 3), V('Gramado - Natal Luz.mp4', 'vi', 8), V('Cachoeira.mp4', 'vi', 1),
      ...Array.from({ length: 14 }, (_, i) => I(`IMG_${2400 + i}.jpg`, 'pa')),
      ...Array.from({ length: 9 }, (_, i) => I(`foto_${i + 1}.jpg`, 'an')),
    ];
    return { myDriveId: 'R', folders, files, scannedAt: Date.now() };
  }

  // ---------- início ----------
  async function boot() {
    applyBrand();
    wireGlobal();
    wirePlayer();
    wireLightbox();
    if (DEMO) {
      state.raw = demoRaw();
      settings = Object.assign({}, settings, { root: 'm', rootName: 'Mídia', minMovie: 50 });
      saveSettings = () => {};
      progress = { [state.raw.files[0].id]: { t: 3000, d: 10140, ts: Date.now() }, [state.raw.files[8].id]: { t: 2820, d: 2820, ts: Date.now() - 1000 }, [state.raw.files[9].id]: { t: 900, d: 2820, ts: Date.now() - 500 } };
      $('#topbar').hidden = false;
      rebuild();
      onRoute();
      return;
    }
    if (!CFG.GOOGLE_CLIENT_ID || /^COLE_AQUI/.test(CFG.GOOGLE_CLIENT_ID)) { renderSetupNeeded(); return; }
    const swPromise = setupSW();
    restoreToken();
    loadGis().then(initTokenClient).catch((e) => console.warn(e));
    state.swReady = await swPromise;
    if (tokenValid()) { postTokenToSW(); startApp(); }
    else renderWelcome();
  }

  boot();
})();
