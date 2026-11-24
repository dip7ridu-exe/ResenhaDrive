/*
 * library.js — organiza os arquivos do Drive em Filmes, Séries, Vídeos e Fotos.
 * Funções puras (sem acesso à rede), usadas pelo app.js.
 */
(function (root) {
  'use strict';

  const VIDEO_EXT = /\.(mp4|m4v|mkv|webm|mov|avi|wmv|flv|ts|m2ts|mts|3gp|ogv|mpg|mpeg)$/i;
  const ART_RX = /^(poster|capa|cover|folder|fanart|backdrop|background|banner|fundo)\.(jpe?g|png|webp)$/i;
  const BACKDROP_RX = /^(fanart|backdrop|background|banner|fundo)\./i;
  const SERIES_CAT = /^(s[ée]ries?( de tv)?|tv|tv shows?|shows?|animes?|novelas?|desenhos?|doramas?|k-?dramas?)$/i;
  const MOVIE_CAT = /^(filmes?|movies?|cinema)$/i;
  const JUNK = /\b(2160p|1440p|1080p|1080i|720p|576p|480p|360p|4k|uhd|hdr10\+?|hdr|bluray|blu ray|brrip|bdrip|bdremux|remux|web ?dl|webrip|hdtv|hdrip|dvdrip|dvdscr|hdcam|x264|x265|h ?264|h ?265|hevc|avc|aac\d?|ac3|e?ac3|dts(?: ?hd)?|ddp?5|atmos|dual(?: ?audio)?|dublado|legendado|nacional|proper|repack|extended|unrated|imax|10bit|8bit|amzn|dsnp|hmax|www)\b/i;

  const collator = new Intl.Collator('pt-BR', { numeric: true, sensitivity: 'base' });
  const naturalCompare = (a, b) => collator.compare(a || '', b || '');

  function stripExt(n) {
    return String(n || '').replace(/\.[A-Za-z0-9]{2,4}$/, '');
  }
  function normalizeName(n) {
    return stripExt(n).replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();
  }
  function slug(s) {
    return String(s || '')
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .toLowerCase().replace(/&/g, ' e ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'sem-nome';
  }
  function isVideoFile(f) {
    return String(f.mimeType || '').startsWith('video/') || VIDEO_EXT.test(f.name || '');
  }

  // "Interstellar.2014.1080p.BluRay.x264" -> { title: "Interstellar", year: 2014 }
  function cleanTitle(raw) {
    let t = normalizeName(raw).replace(/\[[^\]]*\]|\{[^}]*\}/g, ' ');
    t = t.replace(/^\s*www \S+ \S+\s*-\s*/i, '');
    let year = null;
    const years = [...t.matchAll(/(?:^|[\s(\-])((?:19[2-9]|20[0-4])\d)(?=[\s)\-]|$)/g)].filter((m) => m.index > 0);
    if (years.length) {
      const m = years[0];
      year = +m[1];
      t = t.slice(0, m.index);
    }
    const jm = t.match(JUNK);
    if (jm && jm.index > 0) t = t.slice(0, jm.index);
    t = t.replace(/\(\s*\)/g, '').replace(/[\s\-–:(,]+$/, '').replace(/^[\s\-–:]+/, '').replace(/\s+/g, ' ').trim();
    if (!t) t = normalizeName(raw);
    return { title: t, year };
  }

  function seasonFromFolder(name) {
    const n = String(name || '').trim();
    const m =
      n.match(/(?:temporada|season|temp\.?)\s*[._-]?\s*(\d{1,2})\b/i) ||
      n.match(/^[ST]\s*(\d{1,2})$/i) ||
      n.match(/^(\d{1,2})\s*(?:ª|a|º|o)?\s*temporada\b/i) ||
      n.match(/^(\d{1,2})(?:st|nd|rd|th)\s+season\b/i);
    return m ? +m[1] : null;
  }

  // Procura S01E02, 1x02, T01E02 no nome do arquivo
  function parseEpisode(fileName) {
    const n = normalizeName(fileName);
    let m = n.match(/\b[ST](\d{1,2})\s*-?\s*E(\d{1,3})(?:\s*-?\s*E\d{1,3})?\b/i);
    if (!m) m = n.match(/\b(\d{1,2})x(\d{2,3})\b/i);
    if (!m) return null;
    return { season: +m[1], episode: +m[2], index: m.index, end: m.index + m[0].length, norm: n };
  }

  function guessEpisodeNumber(fileName) {
    let n = normalizeName(fileName);
    let m = n.match(/\b(?:ep|epis[oó]dio|episode|e|cap[ií]tulo|cap)\s*-?\s*(\d{1,3})\b/i);
    if (m) return +m[1];
    n = n.replace(/\b\d{3,4}[pi]\b/gi, ' ').replace(/\b(19|20)\d{2}\b/g, ' ').replace(/\b[xh] ?26[45]\b/gi, ' ');
    m = n.match(/\b(\d{1,3})\b/);
    return m ? +m[1] : null;
  }

  function episodeTitle(fileName, ep) {
    if (!ep) {
      const t = cleanTitle(fileName).title;
      return t;
    }
    let rest = ep.norm.slice(ep.end).replace(/^[\s\-–:.]+/, '');
    const jm = rest.match(JUNK);
    if (jm) rest = rest.slice(0, jm.index);
    rest = rest.replace(/\[[^\]]*\]/g, '').replace(/[\s\-–:(]+$/, '').trim();
    return rest;
  }

  function qualityLabel(w, h) {
    w = +w || 0; h = +h || 0;
    const big = Math.max(w, h), small = Math.min(w, h);
    if (!big) return '';
    if (big >= 3800 || small >= 2100) return '4K';
    if (big >= 2500 || small >= 1400) return '1440p';
    if (big >= 1900 || small >= 1000) return '1080p';
    if (big >= 1260 || small >= 700) return '720p';
    return 'SD';
  }

  function formatDuration(sec) {
    sec = Math.round(+sec || 0);
    if (!sec) return '';
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    if (h) return `${h}h${String(m).padStart(2, '0')}`;
    if (m) return `${m} min`;
    return `${s}s`;
  }

  function formatClock(sec) {
    sec = Math.max(0, Math.floor(+sec || 0));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
  }

  function formatSize(bytes) {
    bytes = +bytes || 0;
    if (!bytes) return '';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (bytes >= 1024 && i < u.length - 1) { bytes /= 1024; i++; }
    return (i >= 3 ? bytes.toFixed(1) : Math.round(bytes)) + ' ' + u[i];
  }

  function srtToVtt(text) {
    let s = String(text || '').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
    if (/^WEBVTT/.test(s)) return s;
    s = s.replace(/(^|[\s>])(\d):(\d{2}):(\d{2})[,.](\d{1,3})/gm, '$10$2:$3:$4.$5');
    s = s.replace(/(\d{2}:\d{2}:\d{2}),(\d{1,3})/g, '$1.$2');
    return 'WEBVTT\n\n' + s.trim() + '\n';
  }

  function exifDate(t) {
    // "2023:05:01 12:00:00" -> ISO
    const m = String(t || '').match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
    return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}` : null;
  }

  /**
   * Monta a biblioteca.
   * @param {object} o
   *   folders: [{id,name,parents}]   files: [arquivos do Drive]
   *   root: null (tudo) | 'mydrive' | id de pasta     myDriveId: id da raiz do Meu Drive
   *   minMovieMinutes: número
   */
  function buildLibrary(o) {
    const folders = o.folders || [], files = o.files || [];
    const root = o.root || null, myDriveId = o.myDriveId || null;
    const minMovie = o.minMovieMinutes == null ? 50 : +o.minMovieMinutes;

    const fmap = new Map(folders.map((f) => [f.id, f]));
    const pathCache = new Map();
    function pathOf(id) {
      if (!id) return [];
      if (pathCache.has(id)) return pathCache.get(id);
      const chain = [];
      const seen = new Set();
      let cur = id;
      while (cur && fmap.has(cur) && !seen.has(cur)) {
        seen.add(cur);
        const f = fmap.get(cur);
        chain.unshift(f);
        cur = f.parents && f.parents[0];
      }
      pathCache.set(id, chain);
      return chain;
    }
    function relPath(file) {
      const pid = file.parents && file.parents[0];
      const chain = pathOf(pid);
      if (!root) return chain;
      if (root === 'mydrive') {
        const topParent = chain.length ? chain[0].parents && chain[0].parents[0] : pid;
        return topParent && topParent === myDriveId ? chain : null;
      }
      const idx = chain.findIndex((f) => f.id === root);
      return idx < 0 ? null : chain.slice(idx);
    }

    const art = {};
    const videos = [], images = [];
    for (const f of files) {
      const rel = relPath(f);
      if (rel === null) continue;
      const isImage = String(f.mimeType || '').startsWith('image/');
      if (isImage && ART_RX.test(f.name || '')) {
        const pid = (f.parents && f.parents[0]) || '_';
        const a = art[pid] || (art[pid] = {});
        if (BACKDROP_RX.test(f.name)) a.backdrop = a.backdrop || f.id;
        else a.poster = a.poster || f.id;
        continue;
      }
      if (isVideoFile(f)) videos.push({ f, rel });
      else if (isImage) images.push({ f, rel });
    }

    const videoCount = new Map();
    for (const { f } of videos) {
      const p = (f.parents && f.parents[0]) || '_';
      videoCount.set(p, (videoCount.get(p) || 0) + 1);
    }

    function base(f, rel) {
      const vm = f.videoMediaMetadata || {};
      const parent = rel[rel.length - 1];
      return {
        id: f.id,
        name: f.name,
        mime: f.mimeType || '',
        size: +f.size || 0,
        thumb: f.thumbnailLink || null,
        duration: vm.durationMillis ? Math.round(+vm.durationMillis / 1000) : 0,
        width: +vm.width || 0,
        height: +vm.height || 0,
        created: f.createdTime || '',
        modified: f.modifiedTime || f.createdTime || '',
        folderId: (f.parents && f.parents[0]) || null,
        folderName: parent ? parent.name : 'Meu Drive',
      };
    }

    const seriesMap = new Map();
    const movies = [], vids = [];

    for (const { f, rel } of videos) {
      const item = base(f, rel);
      const names = rel.map((r) => String(r.name || '').trim());
      const parent = rel[rel.length - 1];
      const gp = rel[rel.length - 2];
      const ep = parseEpisode(f.name);
      const pSeason = parent ? seasonFromFolder(parent.name) : null;
      const catIdx = names.findIndex((n) => SERIES_CAT.test(n));
      const underSeriesCat = catIdx >= 0 && catIdx < rel.length - 1;

      if (ep || pSeason !== null || underSeriesCat) {
        let showFolder = null, showTitle = null, showYear = null;
        if (pSeason !== null && gp && !SERIES_CAT.test(gp.name.trim())) showFolder = gp;
        else if (underSeriesCat && seasonFromFolder(rel[catIdx + 1].name) === null) showFolder = rel[catIdx + 1];

        if (!showFolder && ep && ep.index > 0) {
          const c = cleanTitle(ep.norm.slice(0, ep.index));
          showTitle = c.title; showYear = c.year;
        }
        if (!showFolder && !showTitle && parent && !SERIES_CAT.test(parent.name.trim()) && pSeason === null) showFolder = parent;
        let artFolder = showFolder ? showFolder.id : null;
        if (!artFolder && showTitle && parent) {
          const holder = pSeason !== null ? gp : parent;
          if (holder && slug(cleanTitle(holder.name).title) === slug(showTitle)) artFolder = holder.id;
        }
        if (showFolder) {
          const c = cleanTitle(showFolder.name);
          showTitle = c.title; showYear = c.year;
        }
        if (!showTitle) showTitle = 'Sem nome';

        const season = ep ? ep.season : (pSeason != null ? pSeason : 1);
        const episode = ep ? ep.episode : guessEpisodeNumber(f.name);
        const key = slug(showTitle);
        let s = seriesMap.get(key);
        if (!s) {
          s = { key, kind: 'series', title: showTitle, year: showYear, artFolder, episodes: [] };
          seriesMap.set(key, s);
        }
        if (!s.artFolder && artFolder) s.artFolder = artFolder;
        if (!s.year && showYear) s.year = showYear;
        let et = episodeTitle(f.name, ep);
        if (!ep && et) {
          let r = normalizeName(et);
          const st = showTitle.toLowerCase();
          if (r.toLowerCase().startsWith(st)) r = r.slice(st.length);
          r = r.replace(/\b(?:ep|epis[oó]dio|episode|cap[ií]tulo|cap|e)?\s*[.\-]?\s*\d{1,3}\b/gi, ' ').replace(/^[\s\-–:.]+|[\s\-–:.]+$/g, '').trim();
          et = /[a-zà-ú]{2,}/i.test(r) ? r : '';
        }
        s.episodes.push(Object.assign(item, { kind: 'episode', seriesKey: key, season, episode, epTitle: et }));
        continue;
      }

      const inMovieCat = names.some((n) => MOVIE_CAT.test(n));
      const mins = item.duration / 60;
      const alone = videoCount.get(item.folderId || '_') === 1;
      if (inMovieCat || (minMovie > 0 && mins >= minMovie)) {
        let { title, year } = cleanTitle(f.name);
        let artFolder = alone && parent && !MOVIE_CAT.test(parent.name.trim()) ? parent.id : null;
        if (inMovieCat && alone && parent && !MOVIE_CAT.test(parent.name.trim())) {
          const c = cleanTitle(parent.name);
          title = c.title; year = c.year || year;
        }
        movies.push(Object.assign(item, { kind: 'movie', title, year, artFolder }));
        continue;
      }
      vids.push(Object.assign(item, { kind: 'video', title: normalizeName(f.name) }));
    }

    const series = [...seriesMap.values()];
    for (const s of series) {
      s.episodes.sort((a, b) =>
        a.season - b.season ||
        (a.episode == null ? 1e9 : a.episode) - (b.episode == null ? 1e9 : b.episode) ||
        naturalCompare(a.name, b.name));
      const bySeason = new Map();
      for (const e of s.episodes) {
        if (!bySeason.has(e.season)) bySeason.set(e.season, []);
        const list = bySeason.get(e.season);
        if (e.episode == null) e.episode = list.length + 1;
        list.push(e);
      }
      s.seasons = [...bySeason.keys()].sort((a, b) => a - b);
      s.modified = s.episodes.reduce((m, e) => (e.modified > m ? e.modified : m), '');
      s.thumb = (s.episodes.find((e) => e.thumb) || {}).thumb || null;
    }
    series.sort((a, b) => naturalCompare(a.title, b.title));
    movies.sort((a, b) => naturalCompare(a.title, b.title));
    vids.sort((a, b) => (b.modified || '').localeCompare(a.modified || ''));

    const albumsMap = new Map();
    const photos = images.map(({ f, rel }) => {
      const it = base(f, rel);
      const im = f.imageMediaMetadata || {};
      it.kind = 'photo';
      it.width = +im.width || 0;
      it.height = +im.height || 0;
      it.date = exifDate(im.time) || f.createdTime || f.modifiedTime || '';
      const aid = it.folderId || '_';
      let a = albumsMap.get(aid);
      if (!a) { a = { id: aid, name: it.folderName, count: 0, cover: it.id, date: '' }; albumsMap.set(aid, a); }
      a.count++;
      if (it.date > a.date) { a.date = it.date; a.cover = it.id; }
      return it;
    });
    photos.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    const albums = [...albumsMap.values()].sort((a, b) => (b.date || '').localeCompare(a.date || ''));

    return { movies, series, videos: vids, photos, albums, art };
  }

  /** Conta mídias por pasta (incluindo subpastas) — usado no seletor de pasta. */
  function countMediaByFolder(folders, files) {
    const fmap = new Map(folders.map((f) => [f.id, f]));
    const counts = new Map();
    for (const f of files) {
      let cur = f.parents && f.parents[0];
      const seen = new Set();
      while (cur && !seen.has(cur)) {
        seen.add(cur);
        counts.set(cur, (counts.get(cur) || 0) + 1);
        const p = fmap.get(cur);
        cur = p && p.parents && p.parents[0];
      }
    }
    return counts;
  }

  root.Lib = {
    buildLibrary, countMediaByFolder, cleanTitle, parseEpisode, seasonFromFolder, guessEpisodeNumber,
    slug, stripExt, normalizeName, naturalCompare, qualityLabel, formatDuration, formatClock, formatSize,
    srtToVtt, isVideoFile, VIDEO_EXT,
  };
})(typeof window !== 'undefined' ? window : globalThis);
