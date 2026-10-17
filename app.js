/* Padel-Posten – klientapp. Alt innhold er kryptert med passordet. */
(() => {
'use strict';
const SALT = 'padelposten-2026-salt', ITER = 200000;
const NTFY = 'https://ntfy.sh';
const REPO_RAW = 'https://raw.githubusercontent.com/tjukken2/pp-gazette/gh-pages/';
const ON_PAGES = location.hostname.endsWith('github.io');
const DAY1 = '2026-10-16';
const $ = (s, el = document) => el.querySelector(s);
const enc = new TextEncoder(), dec = new TextDecoder();
let KEY = null, C = null, TOPIC = null;
const events = new Map();      // id -> {id,time,msg,file?,att?}
const decoded = new Map();     // id -> payload|null
const blobCache = new Map();   // id -> objectURL
const LS = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { localStorage.setItem(k, JSON.stringify(v)); }
};
const clientId = LS.get('pp_client') || (() => { const v = Math.random().toString(36).slice(2) + Date.now().toString(36); LS.set('pp_client', v); return v; })();

/* ---------- crypto ---------- */
const b64 = { enc: u8 => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); },
              dec: s => Uint8Array.from(atob(s), c => c.charCodeAt(0)) };
async function deriveKey(pw) {
  const base = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: enc.encode(SALT), iterations: ITER, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function encBytes(u8) { const iv = crypto.getRandomValues(new Uint8Array(12)); const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, KEY, u8)); const o = new Uint8Array(12 + ct.length); o.set(iv); o.set(ct, 12); return o; }
async function decBytes(u8) { return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: u8.subarray(0, 12) }, KEY, u8.subarray(12))); }
async function encStr(obj) { return 'E1:' + b64.enc(await encBytes(enc.encode(JSON.stringify(obj)))); }
async function decStr(s) { if (!s || !s.startsWith('E1:')) throw new Error('fmt'); return JSON.parse(dec.decode(await decBytes(b64.dec(s.slice(3))))); }

/* ---------- utils ---------- */
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const osloDate = (d = new Date()) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Oslo' }).format(d);
const fmtDate = iso => { const [y, m, d] = iso.split('-').map(Number); return new Intl.DateTimeFormat('nb-NO', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, d))); };
const dayNo = iso => Math.round((Date.parse(iso) - Date.parse(DAY1)) / 864e5) + 1;
const edLabel = iso => { const n = dayNo(iso); return n >= 1 && n <= 5 ? `Utgave nr. ${n} · Dag ${n} av 5` : n < 1 ? 'Forhåndsutgave' : 'Ettertrykk'; };
const paras = t => esc(t).split(/\n\s*\n|\n/).filter(p => p.trim() && !/^\[\[.*\]\]$/.test(p.trim())).map(p => `<p>${p}</p>`).join('');
function toast(msg, ms = 2600) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => t.hidden = true, ms); }
const guyById = id => C.guys.find(g => g.id === id);
const SIL = '<svg viewBox="0 0 100 110"><circle cx="50" cy="34" r="22"/><path d="M8 110c0-28 19-44 42-44s42 16 42 44z"/></svg>';

/* ---------- data loading ---------- */
async function fetchFirst(paths, opts) {
  let lastErr;
  for (const p of paths) { try { const r = await fetch(p, opts); if (r.ok) return r; lastErr = new Error(r.status); } catch (e) { lastErr = e; } }
  throw lastErr;
}
const dataUrls = rel => ON_PAGES ? [REPO_RAW + rel + '?t=' + Date.now(), rel + '?t=' + Date.now()] : [rel + '?t=' + Date.now()];

async function loadRepoEvents() {
  try {
    const r = await fetchFirst(dataUrls('data/events.json'), { cache: 'no-store' });
    const j = await r.json();
    for (const e of j.events || []) addEvent(e, true);
  } catch (e) { console.warn('events.json', e); }
}
function addEvent(e, fromRepo) {
  const ex = events.get(e.id);
  if (ex) { if (fromRepo && e.file && !ex.file) ex.file = e.file; return false; }
  events.set(e.id, e); return true;
}
function fromNtfy(m) {
  if (m.event !== 'message' || !m.message) return null;
  if (!(m.message.startsWith('E1:') || m.message === 'BIG')) return null;
  const e = { id: m.id, time: m.time, msg: m.message };
  if (m.attachment) e.att = m.attachment.url;
  return e;
}
let renderT;
let renderPending = false;
function scheduleRender() { clearTimeout(renderT); renderT = setTimeout(async () => {
  await decodeAll();
  // Ikke riv ned skjemaet mens noen skriver i undersøkelsen: oppdater bare tallene, full render etterpå.
  if (pollEl && pollEl.isConnected && pollEl.contains(document.activeElement)) { updatePoll(state()); if (!renderPending) { renderPending = true; pollEl.addEventListener('focusout', () => { renderPending = false; setTimeout(() => { if (!pollEl.contains(document.activeElement)) scheduleRender(); }, 300); }, { once: true }); } return; }
  render(); }, 250); }
function connectLive() {
  const st = $('#sync-status');
  try {
    const es = new EventSource(`${NTFY}/${TOPIC}/sse?since=all`);
    es.onopen = () => st.textContent = 'Direkte fra trykkeriet ●';
    es.onmessage = ev => { try { const e = fromNtfy(JSON.parse(ev.data)); if (e && addEvent(e)) scheduleRender(); } catch {} };
    es.onerror = () => st.textContent = 'Kobler til trykkeriet på nytt…';
  } catch (e) { pollOnce(); }
}
async function pollOnce() {
  try {
    const r = await fetch(`${NTFY}/${TOPIC}/json?poll=1&since=all`);
    const t = await r.text(); let ch = false;
    for (const line of t.split('\n')) { if (!line.trim()) continue; const e = fromNtfy(JSON.parse(line)); if (e && addEvent(e)) ch = true; }
    if (ch) scheduleRender();
  } catch (e) { console.warn('poll', e); }
}
async function evBytes(e) {
  const urls = [];
  if (e.file) urls.push(...dataUrls(e.file).map(u => u.replace(/\?t=\d+$/, '')));
  if (e.att) urls.push(e.att);
  const r = await fetchFirst(urls);
  return new Uint8Array(await r.arrayBuffer());
}
async function decodeEvent(e) {
  if (decoded.has(e.id)) return decoded.get(e.id);
  let p = null;
  try {
    if (e.msg === 'BIG') p = JSON.parse(dec.decode(await decBytes(await evBytes(e))));
    else p = await decStr(e.msg);
  } catch (err) { p = null; }
  decoded.set(e.id, p); return p;
}
async function decodeAll() { await Promise.all([...events.values()].map(decodeEvent)); }
async function imageUrl(id) {
  if (blobCache.has(id)) return blobCache.get(id);
  const e = events.get(id); const p = decoded.get(id);
  if (!e || !p) return null;
  const pr = (async () => { try { const raw = await decBytes(await evBytes(e)); return URL.createObjectURL(new Blob([raw], { type: p.mime || 'image/jpeg' })); } catch { return null; } })();
  blobCache.set(id, pr); return pr;
}

/* ---------- state derivation ---------- */
function state() {
  const list = [...events.values()].sort((a, b) => a.time - b.time || (a.id < b.id ? -1 : 1));
  const articles = new Map(), dels = [], votes = {}, photos = {}, pollV = {};
  for (const s of C.seed) articles.set(s.aid, { ...s, seed: true, ts: Date.parse(s.time || (s.date + 'T08:00:00Z')) / 1000 });
  for (const e of list) {
    const p = decoded.get(e.id); if (!p) continue;
    if (p.t === 'article' && Array.isArray(C.hidden) && C.hidden.includes(p.aid)) continue;
    if (p.t === 'article' && p.aid && p.headline) articles.set(p.aid, { ...p, ts: e.time, eid: e.id });
    else if (p.t === 'del') dels.push(p);
    else if (p.t === 'poll' && p.q === POLL.id && typeof p.d === 'string' && p.d.length >= 8 && Number.isInteger(p.n) && p.n >= 0 && p.n <= POLL.max) { delete pollV[p.d]; pollV[p.d] = p.n; }
    else if (p.t === 'vote' && guyById(p.guy) && p.c >= 0 && p.c < 4) { (votes[p.guy] ||= {})[p.voter] = p.c; }
    else if (p.t === 'photo' && p.target && p.target.startsWith('guy:')) photos[p.target.slice(4)] = e.id;
  }
  for (const d of dels) { const a = articles.get(d.aid); if (a && !a.seed && a.by === d.by) articles.delete(d.aid); }
  const tally = {};
  for (const g of C.guys) { const t = [0, 0, 0, 0]; for (const c of Object.values(votes[g.id] || {})) t[c]++; tally[g.id] = t; }
  const arts = [...articles.values()].sort((a, b) => b.date.localeCompare(a.date) || b.ts - a.ts);
  return { arts, tally, photos, poll: Object.values(pollV) };
}

/* ---------- publishing ---------- */
async function publish(payload) {
  const s = await encStr(payload);
  let r;
  if (s.length < 3800) r = await fetch(`${NTFY}/${TOPIC}`, { method: 'POST', body: s });
  else r = await fetch(`${NTFY}/${TOPIC}?filename=a.txt&message=BIG`, { method: 'PUT', body: new Blob([s]) });
  if (!r.ok) throw new Error('Trykkeriet svarte ' + r.status);
  const m = await r.json(); const e = fromNtfy(m);
  if (e) { addEvent(e); decoded.set(e.id, payload); }
  return m.id;
}
async function publishPhoto(file, target, maxSide) {
  const blob = await compress(file, maxSide);
  const bytes = await encBytes(new Uint8Array(await blob.arrayBuffer()));
  const meta = { t: 'photo', target, mime: 'image/jpeg', by: clientId };
  const ms = await encStr(meta);
  const r = await fetch(`${NTFY}/${TOPIC}?filename=p.bin&message=${encodeURIComponent(ms)}`, { method: 'PUT', body: new Blob([bytes]) });
  if (!r.ok) throw new Error('Opplasting feilet (' + r.status + ')');
  const m = await r.json(); const e = fromNtfy(m);
  if (e) { addEvent(e); decoded.set(e.id, meta); blobCache.set(e.id, Promise.resolve(URL.createObjectURL(blob))); }
  return m.id;
}
async function compress(file, maxSide) {
  let bmp;
  try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch { bmp = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(file); }); }
  const w = bmp.width, h = bmp.height, sc = Math.min(1, maxSide / Math.max(w, h));
  const cv = document.createElement('canvas'); cv.width = Math.round(w * sc); cv.height = Math.round(h * sc);
  cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
  return await new Promise(res => cv.toBlob(res, 'image/jpeg', 0.82));
}

/* ---------- video (v17) ----------
   ntfy.sh anonymous limits (checked 2026-10-17 via /v1/account): 2 MB per attachment, 20 MB stored per IP for 3 h,
   250 messages/day. Videos are split into encrypted chunks (< per-file limit), each its own ntfy message
   {t:'vchunk', vid, i, n}; the article carries videos:[{vid, parts:[eventIds], poster, mime, dur, w, h, size}]. */
const VID_MAX = 15 * 1024 * 1024, VID_MAX_S = 60;
const vidCache = new Map(); // vid -> Promise<objectURL>
const vidEls = new Map();   // vid -> [video, link] kept across re-renders so playback isn't interrupted
const fmtMB = b => (b / 1048576).toFixed(b < 10485760 ? 1 : 0).replace('.', ',') + ' MB';
const vidMime = f => f.type || (/\.mov$/i.test(f.name) ? 'video/quicktime' : 'video/mp4');
async function ntfyLimits() {
  try { const j = await (await fetch(`${NTFY}/v1/account`, { cache: 'no-store' })).json();
    return { file: j.limits.attachment_file_size, left: j.stats.attachment_total_size_remaining, msgs: j.stats.messages_remaining };
  } catch { return { file: 2097152, left: null, msgs: null }; }
}
function probeVideo(file) {
  return new Promise(res => {
    const out = { dur: null, w: 0, h: 0, poster: null }; let done = false;
    const v = document.createElement('video'); const url = URL.createObjectURL(file);
    const fin = () => { if (done) return; done = true; clearTimeout(t); v.removeAttribute('src'); v.load(); URL.revokeObjectURL(url); res(out); };
    const t = setTimeout(fin, 9000);
    v.muted = true; v.playsInline = true; v.setAttribute('playsinline', ''); v.preload = 'auto';
    v.onloadedmetadata = () => { out.dur = isFinite(v.duration) ? v.duration : null; out.w = v.videoWidth; out.h = v.videoHeight; try { v.currentTime = Math.min(0.6, (out.dur || 1) / 2); } catch { fin(); } };
    v.onseeked = () => setTimeout(() => { try {
      const sc = Math.min(1, 960 / Math.max(v.videoWidth, v.videoHeight || 1)); const cv = document.createElement('canvas');
      cv.width = Math.max(1, Math.round(v.videoWidth * sc)); cv.height = Math.max(1, Math.round(v.videoHeight * sc));
      cv.getContext('2d').drawImage(v, 0, 0, cv.width, cv.height);
      const sm = document.createElement('canvas'); sm.width = 16; sm.height = 12; const sx = sm.getContext('2d'); sx.drawImage(cv, 0, 0, 16, 12);
      const px = sx.getImageData(0, 0, 16, 12).data; let lum = 0; for (let k = 0; k < px.length; k += 4) lum += px[k] + px[k + 1] + px[k + 2];
      if (lum / (px.length / 4) / 3 < 4) { fin(); return; } // blank frame (decoder couldn't paint) – skip poster
      cv.toBlob(b => { out.poster = b && b.size > 2000 ? b : null; fin(); }, 'image/jpeg', 0.8);
    } catch { fin(); } }, 250);
    v.onerror = fin; v.src = url; v.load();
  });
}
function videoProblem(file, info) {
  if (file.size > VID_MAX) return `Videoen er for stor (${fmtMB(file.size)}). Maks ${fmtMB(VID_MAX)} – trim klippet i Bilder-appen (Rediger → dra i kantene) eller ta opp kortere.`;
  if (info.dur && info.dur > VID_MAX_S + 0.5) return `Videoen er for lang (${Math.round(info.dur)} sek). Maks ${VID_MAX_S} sekunder – trim den i Bilder-appen først.`;
  return '';
}
async function putEnc(bytes, meta, fname) {
  const ms = await encStr(meta);
  const r = await fetch(`${NTFY}/${TOPIC}?filename=${fname}&message=${encodeURIComponent(ms)}`, { method: 'PUT', body: new Blob([bytes]) });
  if (r.status === 413) throw new Error('Trykkeriet sier filen er for stor (ntfy-grense). Prøv et kortere klipp.');
  if (r.status === 429) throw new Error('Trykkeriet har nådd kvoten for dette nettverket. Vent noen timer eller prøv på mobildata.');
  if (!r.ok) throw new Error('Opplasting feilet (' + r.status + ')');
  const m = await r.json(); const e = fromNtfy(m); if (e) { addEvent(e); decoded.set(e.id, meta); }
  return m.id;
}
async function publishVideo(file, info, aid, prog) {
  const why = videoProblem(file, info); if (why) throw new Error(why);
  const lim = await ntfyLimits();
  const need = file.size + (info.poster ? info.poster.size : 0) + 4096;
  if (lim.left != null && need > lim.left) throw new Error(`Trykkeriet har bare ${fmtMB(Math.max(0, lim.left))} ledig for nettverket ditt de neste timene (videoen trenger ${fmtMB(need)}). Prøv på mobildata (skru av Wi-Fi) eller vent et par timer.`);
  const CH = Math.max(262144, Math.min(1900000, (lim.file || 2097152) - 131072));
  const n = Math.ceil(file.size / CH);
  if (lim.msgs != null && n + 3 > lim.msgs) throw new Error('Trykkeriet har nådd dagens meldingskvote for nettverket ditt. Prøv på mobildata.');
  const vid = 'v' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const parts = [];
  for (let i = 0; i < n; i++) {
    prog(`Laster opp video: del ${i + 1} av ${n}…`);
    const raw = new Uint8Array(await file.slice(i * CH, (i + 1) * CH).arrayBuffer());
    parts.push(await putEnc(await encBytes(raw), { t: 'vchunk', vid, i, n, by: clientId }, 'v.bin'));
  }
  let poster = null;
  if (info.poster) { prog('Laster opp plakatbilde…'); const pm = { t: 'photo', target: 'vid:' + vid, mime: 'image/jpeg', by: clientId };
    poster = await putEnc(await encBytes(new Uint8Array(await info.poster.arrayBuffer())), pm, 'p.bin'); blobCache.set(poster, Promise.resolve(URL.createObjectURL(info.poster))); }
  vidCache.set(vid, Promise.resolve(URL.createObjectURL(new Blob([file], { type: vidMime(file) }))));
  return { vid, parts, poster, mime: vidMime(file), dur: info.dur ? Math.round(info.dur * 10) / 10 : null, w: info.w, h: info.h, size: file.size };
}
function videoUrl(v, prog) {
  if (vidCache.has(v.vid)) return vidCache.get(v.vid);
  const pr = (async () => {
    const out = [];
    for (let i = 0; i < v.parts.length; i++) {
      const e = events.get(v.parts[i]); if (!e) throw new Error('missing');
      prog && prog(i + 1, v.parts.length);
      out.push(await decBytes(await evBytes(e)));
    }
    return URL.createObjectURL(new Blob(out, { type: v.mime || 'video/mp4' }));
  })();
  vidCache.set(v.vid, pr); pr.catch(() => vidCache.delete(v.vid)); return pr;
}
const okVideo = v => v && typeof v.vid === 'string' && Array.isArray(v.parts) && v.parts.length && v.parts.length <= 64 && v.parts.every(p => typeof p === 'string');
function videoFig(v) {
  const meta = [v.dur ? Math.round(v.dur) + ' sek' : '', v.size ? fmtMB(v.size) : ''].filter(Boolean).join(' · ');
  return `<figure class="article-video inline"><div class="vid-box" data-video="${esc(JSON.stringify({ vid: v.vid, parts: v.parts, poster: v.poster || null, mime: v.mime || '', dur: v.dur || null }))}"><div class="vid-poster"><div class="vid-ph">🎬</div><button class="reel-play" type="button" aria-label="Spill av video">▶</button><div class="vid-status">${esc(meta)}</div></div></div>${v.caption ? `<figcaption class="caption">${esc(v.caption)}</figcaption>` : ''}</figure>`;
}
/* ---------- film download («Last ned filmen») ---------- */
// Encrypted repo films (reel + seed films): decrypt once, keep the Blob; returns Promise<Blob>
const filmBlobs = new Map();
function encFilmBlob(parts, mime, onProg) {
  const key = parts[0];
  if (!filmBlobs.has(key)) {
    let done = 0;
    const pr = Promise.all(parts.map(async p => {
      const r = await fetchFirst([p + '?v=' + APP_VER, REPO_RAW + p]); const t = (await r.text()).trim();
      const raw = await decBytes(b64.dec(t.slice(3))); done++; onProg && onProg(done, parts.length); return raw;
    })).then(bufs => new Blob(bufs, { type: mime || 'video/mp4' }));
    filmBlobs.set(key, pr); pr.catch(() => filmBlobs.delete(key));
  } else if (onProg) filmBlobs.get(key).then(() => onProg(parts.length, parts.length)).catch(() => {});
  return filmBlobs.get(key);
}
const filmUrls = new Map();
async function encFilmUrl(parts, mime, onProg) {
  const key = parts[0];
  if (!filmUrls.has(key)) filmUrls.set(key, encFilmBlob(parts, mime, onProg).then(b => URL.createObjectURL(b)).catch(e => { filmUrls.delete(key); throw e; }));
  else if (onProg) onProg(parts.length, parts.length);
  return filmUrls.get(key);
}
const isIOS = () => /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isMobile = () => isIOS() || /Android/i.test(navigator.userAgent);
// getBlob: async () => Blob. Mobile: share sheet (Lagre video) – needs a fresh tap, so tap 1 fetches, tap 2 shares.
function dlButton(getBlob, filename, label = 'Last ned filmen', desc = '') {
  const wrap = document.createElement('div'); wrap.className = 'film-dl';
  wrap.innerHTML = `<button type="button" class="film-dl-btn">⬇ ${esc(label)}</button>${desc ? `<span class="film-dl-desc">${esc(desc)}</span>` : ''}<span class="film-dl-hint" aria-live="polite"></span>`;
  const btn = wrap.querySelector('button'), hint = wrap.querySelector('.film-dl-hint');
  let blob = null, busy = false;
  const deliver = async () => {
    const type = blob.type || 'video/mp4';
    if (isMobile()) {
      let file = null; try { file = new File([blob], filename, { type }); } catch {}
      if (file && navigator.canShare && navigator.share && navigator.canShare({ files: [file] })) {
        try { await navigator.share({ files: [file], title: filename }); hint.textContent = ''; return; }
        catch (e) {
          if (e && e.name === 'AbortError') { hint.textContent = ''; return; }
          if (e && e.name === 'NotAllowedError') { btn.textContent = '⬇ Trykk igjen for å lagre'; hint.textContent = 'Filmen er klar.'; return; }
        }
      }
      const u = URL.createObjectURL(blob);
      const w = window.open(u, '_blank');
      hint.textContent = 'Trykk på del-ikonet og velg «Lagre video».';
      if (!w) { const a = document.createElement('a'); a.href = u; a.target = '_blank'; a.rel = 'noopener'; a.textContent = 'Åpne filmen'; hint.append(' ', a); }
      return;
    }
    const u = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = u; a.download = filename; a.style.display = 'none';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(u), 60000);
    hint.textContent = 'Lastet ned.';
  };
  btn.onclick = async () => {
    if (busy) return;
    if (blob) return deliver();
    busy = true; btn.disabled = true; hint.textContent = 'Henter filmen…';
    try {
      blob = await getBlob(p => hint.textContent = `Henter filmen… ${p} %`);
      btn.disabled = false; busy = false;
      if (isMobile()) { btn.textContent = '⬇ Lagre filmen'; hint.textContent = 'Klar – trykk «Lagre filmen».'; }
      else await deliver();
    } catch (e) { busy = false; btn.disabled = false; hint.textContent = 'Klarte ikke å hente filmen. Prøv igjen.'; }
  };
  return wrap;
}
// Seed films (encrypted repo files like the reel): article.film = {poster, parts:[paths], mime, dur, caption}; body marker [[film]]
function seedFilmFig(f) {
  return `<figure class="article-video inline"><div class="vid-box" data-sfilm="${esc(JSON.stringify({ poster: f.poster, parts: f.parts, mime: f.mime || 'video/mp4', file: f.file || 'padel-posten-film.mp4', desc: f.dl || '' }))}"><div class="vid-poster"><div class="vid-ph">🎬</div><button class="reel-play" type="button" aria-label="Spill av film">▶</button><div class="vid-status">${f.dur ? esc(f.dur + ' sek') : ''}</div></div></div>${f.caption ? `<figcaption class="caption">▶ ${esc(f.caption)}</figcaption>` : ''}</figure>`;
}
function hydrateSeedFilms() {
  document.querySelectorAll('[data-sfilm]:not([data-vh])').forEach(el => {
    el.dataset.vh = '1'; let f; try { f = JSON.parse(el.dataset.sfilm); } catch { return; }
    const key = 'sf:' + f.parts[0];
    if (vidEls.has(key)) { el.innerHTML = ''; vidEls.get(key).forEach(n => el.appendChild(n)); return; }
    const box = el.querySelector('.vid-poster'), st = el.querySelector('.vid-status');
    defaultImageUrl(f.poster).then(u => { const ph = box.querySelector('.vid-ph'); if (u && ph) { const img = new Image(); img.alt = ''; img.src = u; ph.replaceWith(img); } });
    const dl = dlButton(prog => encFilmBlob(f.parts, f.mime, (d, n) => prog(Math.round(d / n * 100))), f.file, 'Last ned filmen', f.desc);
    el.appendChild(dl); vidEls.set(key, [box, dl]);
    box.onclick = async () => {
      if (el.dataset.loading) return; el.dataset.loading = '1';
      try {
        st.textContent = 'Henter filmen… 0 %';
        const u = await encFilmUrl(f.parts, f.mime, (d, n) => st.textContent = `Henter filmen… ${Math.round(d / n * 100)} %`);
        const vd = document.createElement('video'); vd.controls = true; vd.playsInline = true; vd.setAttribute('playsinline', ''); vd.setAttribute('webkit-playsinline', ''); vd.preload = 'auto'; vd.src = u;
        const img = box.querySelector('img'); if (img) vd.poster = img.src;
        box.replaceWith(vd); vidEls.set(key, [vd, dl]);
        vd.play().catch(() => {});
      } catch (e) { delete el.dataset.loading; st.textContent = 'Filmen kom ikke fram. Trykk for å prøve igjen.'; }
    };
  });
}
function hydrateVideos() {
  document.querySelectorAll('[data-video]:not([data-vh])').forEach(async el => {
    el.dataset.vh = '1'; let v; try { v = JSON.parse(el.dataset.video); } catch { return; }
    if (vidEls.has(v.vid)) { el.innerHTML = ''; vidEls.get(v.vid).forEach(n => el.appendChild(n)); return; }
    if (v.poster) imageUrl(v.poster).then(u => { const ph = el.querySelector('.vid-ph'); if (u && ph) { const img = new Image(); img.alt = ''; img.src = u; ph.replaceWith(img); } });
    const box = el.querySelector('.vid-poster'), st = el.querySelector('.vid-status');
    box.onclick = async () => {
      if (el.dataset.loading) return; el.dataset.loading = '1';
      try {
        const u = await videoUrl(v, (i, n) => st.textContent = `Henter video… ${i}/${n}`);
        const vd = document.createElement('video'); vd.controls = true; vd.playsInline = true; vd.setAttribute('playsinline', ''); vd.preload = 'metadata'; vd.src = u;
        const img = box.querySelector('img'); if (img) vd.poster = img.src;
        const ext = /quicktime/.test(v.mime) ? 'mov' : 'mp4';
        const dl = document.createElement('div'); dl.className = 'vid-dl';
        const hevcRisk = /quicktime/.test(v.mime) && !vd.canPlayType('video/quicktime');
        dl.innerHTML = `${hevcRisk ? '<span class="vid-warn">Nettleseren din kan kanskje ikke spille dette formatet. </span>' : ''}`;
        dl.appendChild(dlButton(async () => (await fetch(u)).blob(), `padel-posten-video-${v.vid}.${ext}`, 'Last ned videoen'));
        vd.onerror = () => { const w = dl.querySelector('.vid-warn'); if (w) w.textContent = 'Nettleseren din kan ikke spille dette formatet (f.eks. HEVC fra iPhone i Chrome). '; else dl.insertAdjacentHTML('afterbegin', '<span class="vid-warn">Nettleseren din kan ikke spille dette formatet (f.eks. HEVC fra iPhone i Chrome). </span>'); };
        el.innerHTML = ''; el.appendChild(vd); el.appendChild(dl);
        vidEls.set(v.vid, [vd, dl]);
        vd.play().catch(() => {});
      } catch (e) { delete el.dataset.loading; st.textContent = e.message === 'missing' ? 'Videoen er på vei fra trykkeriet… prøv igjen om litt.' : 'Videoen kom ikke fram. Trykk for å prøve igjen.'; }
    };
  });
}

/* ---------- views ---------- */
function setActive(h) { document.querySelectorAll('.nav a').forEach(a => a.classList.toggle('active', a.getAttribute('href') === h)); }
function render() {
  const h = location.hash || '#/'; const v = $('#view');
  const S = state();
  const today = osloDate();
  $('#dl-date').textContent = fmtDate(today);
  $('#dl-edition').textContent = edLabel(today);
  let m;
  if (h.startsWith('#/dobbeltgjengere')) { setActive('#/dobbeltgjengere'); v.innerHTML = viewLooks(S); bindLooks(); }
  else if (h.startsWith('#/rom')) { setActive('#/rom'); v.innerHTML = viewRooms(); }
  else if (h.startsWith('#/program')) { setActive('#/program'); v.innerHTML = viewProgram(); }
  else if (h.startsWith('#/arkiv')) { setActive('#/arkiv'); v.innerHTML = viewArchive(S); }
  else if (h.startsWith('#/skriv')) { setActive('#/skriv'); if (!$('#write-form')) { v.innerHTML = viewWrite(); bindWrite(); } return; }
  else if ((m = h.match(/^#\/utgave\/(\d{4}-\d\d-\d\d)/))) { setActive(''); v.innerHTML = viewEdition(S, m[1]); }
  else {
    setActive('#/');
    const ds = [...new Set(S.arts.map(a => a.date))].sort();
    const past = ds.filter(d => d <= today);
    const front = past.length ? past[past.length - 1] : (ds[0] || today);
    v.innerHTML = viewEdition(S, front, true);
  }
  const slot = $('#reel-slot'); if (slot) slot.appendChild(reelVideo());
  const ps = $('#poll-slot'); if (ps) ps.appendChild(updatePoll(S));
  hydrateImages(S);
}
let reelEl;
function reelVideo() {
  if (reelEl) return reelEl;
  const R = C.reel; reelEl = document.createElement('div'); reelEl.className = 'reel-box';
  if (!R) { reelEl.hidden = true; return reelEl; }
  reelEl.innerHTML = `<div class="reel-poster"><img alt=""><button class="reel-play" aria-label="Spill av">▶</button><div class="reel-status"></div></div>`;
  defaultImageUrl(R.poster).then(u => { if (u) reelEl.querySelector('img').src = u; });
  const poster = reelEl.querySelector('.reel-poster'), st = reelEl.querySelector('.reel-status');
  reelEl.appendChild(dlButton(prog => encFilmBlob(R.parts, 'video/mp4', (d, n) => prog(Math.round(d / n * 100))), R.file || 'padel-posten-filmavisen.mp4', 'Last ned filmen', R.dl || ''));
  poster.onclick = async () => {
    if (reelEl.dataset.loading) return; reelEl.dataset.loading = '1';
    st.textContent = 'Henter filmen fra trykkeriet… 0 %';
    try {
      const u = await encFilmUrl(R.parts, 'video/mp4', (d, n) => st.textContent = `Henter filmen fra trykkeriet… ${Math.round(d / n * 100)} %`);
      const v = document.createElement('video');
      v.controls = true; v.playsInline = true; v.setAttribute('playsinline', ''); v.setAttribute('webkit-playsinline', '');
      v.poster = poster.querySelector('img').src; v.preload = 'auto'; v.src = u;
      poster.replaceWith(v);
      v.play().catch(() => {});
    } catch (e) { delete reelEl.dataset.loading; st.textContent = 'Filmen kom ikke fram. Trykk for å prøve igjen.'; }
  };
  return reelEl;
}
function userParas(a) {
  const ps = esc(a.body).split(/\n\s*\n|\n/).filter(p => p.trim() && !/^\[\[.*\]\]$/.test(p.trim())).map(p => `<p>${p}</p>`);
  const ex = Array.isArray(a.photos) ? a.photos.filter(x => x && typeof x.id === 'string').slice(0, 8) : [];
  if (Array.isArray(a.videos)) ex.push(...a.videos.filter(okVideo).slice(0, 2).map(v => ({ ...v, isVideo: true })));
  if (!ex.length) return ps.join('');
  const fig = x => x.isVideo ? videoFig(x) : `<figure class="article-photo inline"><div class="halftone" data-img="${esc(x.id)}"><div class="initials">⌛</div></div>${x.caption ? `<figcaption class="caption">${esc(x.caption)}</figcaption>` : ''}</figure>`;
  const out = []; let k = 0;
  ps.forEach((p, i) => { out.push(p); while (k < ex.length && (i + 1) >= Math.ceil((k + 1) * ps.length / (ex.length + 1))) out.push(fig(ex[k++])); });
  while (k < ex.length) out.push(fig(ex[k++]));
  return out.join('');
}
function richParas(a) {
  return (a.rich || a.body).split(/\n\s*\n|\n/).filter(p => p.trim()).map(p => {
    const m = p.match(/^\[\[bilde:(\d+)\]\]$/);
    if (m) { const x = (a.extra || [])[+m[1] - 1]; return x ? `<figure class="article-photo inline"><div class="halftone" data-defimg="${esc(x.photo)}"><div class="initials">⌛</div></div>${x.caption ? `<figcaption class="caption">${esc(x.caption)}</figcaption>` : ''}</figure>` : ''; }
    if (p.trim() === '[[film]]' && a.film && Array.isArray(a.film.parts)) return seedFilmFig(a.film);
    { const mm = p.trim().match(/^\[\[film:(\d+)\]\]$/); if (mm && Array.isArray(a.films) && a.films[+mm[1]] && Array.isArray(a.films[+mm[1]].parts)) return seedFilmFig(a.films[+mm[1]]); }
    if (/^\[\[.*\]\]$/.test(p.trim())) return '';
    if (p.startsWith('## ')) return `<h4 class="mellomtittel">${esc(p.slice(3))}</h4>`;
    return `<p>${esc(p)}</p>`;
  }).join('');
}
function articleHtml(a, lead) {
  const own = !a.seed && a.by === clientId;
  return `<article class="${lead ? 'lead' : 'secondary'}" data-aid="${esc(a.aid)}">
    ${lead ? '<div class="extra">EKSTRA! EKSTRA!</div>' : '<div class="kicker">Siste nytt</div>'}
    <${lead ? 'h2' : 'h3'} class="headline">${esc(a.headline)}</${lead ? 'h2' : 'h3'}>
    ${a.sub ? `<p class="deck">${esc(a.sub)}</p>` : ''}
    <div class="byline"><span>Av ${esc(a.author || 'Anonym kilde')}</span><span>${esc(fmtDate(a.date).replace(/^\w+ /, ''))}</span></div>
    ${a.photo || a.defphoto ? `<figure class="article-photo"><div class="halftone" ${a.photo ? `data-img="${esc(a.photo)}"` : `data-defimg="${esc(a.defphoto)}"`}><div class="initials">⌛</div></div>${a.caption ? `<figcaption class="caption">${esc(a.caption)}</figcaption>` : ''}</figure>` : ''}
    <div class="body">${a.seed ? richParas(a) : userParas(a)}</div>
    ${own ? `<button class="del" data-del="${esc(a.aid)}">Trekk tilbake saken</button>` : ''}
  </article>`;
}
// DAGENS SITAT: content.quotes = [{date, quote, by, quip}] – shown in that date's edition (and on the front page while it is the latest edition)
function quoteBox(date) {
  return ((C && C.quotes) || []).filter(q => q.date === date).map(q => `<aside class="quote-box"><div class="qb-head">DAGENS SITAT</div><blockquote class="qb-quote">«${esc(q.quote)}»</blockquote>${q.by ? `<div class="qb-by">– ${esc(q.by)}</div>` : ''}${q.quip ? `<div class="qb-quip">${esc(q.quip)}</div>` : ''}</aside>`).join('');
}
// RESULTATER: content.results = [{date, title, rows:[{name, rounds:[..], total, poeng}], notes:[..]}] – sorted by total, ties share rank
function resultsBox(date) {
  return ((C && C.results) || []).filter(r => r.date === date).map(r => {
    const rows = [...r.rows].map(x => ({ ...x, total: x.total ?? (x.rounds || []).reduce((a, b) => a + b, 0) })).sort((a, b) => b.total - a.total);
    let rank = 0; rows.forEach((x, i) => { if (i === 0 || x.total !== rows[i - 1].total) rank = i + 1; x.rank = rank; });
    return `<aside class="results-box"><div class="rb-head">${esc(r.title || 'RESULTATER')}</div><table class="results"><thead><tr><th>#</th><th>Navn</th><th>Runder</th><th>Sum</th><th>Poeng</th></tr></thead><tbody>${rows.map(x => `<tr${x.rank === 1 ? ' class="win"' : ''}><td>${x.rank}</td><td>${esc(x.name)}</td><td class="rr">${esc((x.rounds || []).join('·'))}</td><td class="rs">${x.total}</td><td>${x.poeng ?? ''}</td></tr>`).join('')}</tbody></table>${(r.notes || []).length ? `<ul class="rb-notes">${r.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}</aside>`;
  }).join('');
}
function viewEdition(S, date, front) {
  const arts = S.arts.filter(a => a.date === date);
  const dates = [...new Set(S.arts.map(a => a.date))];
  const i = dates.indexOf(date);
  const prev = dates[i + 1], next = dates[i - 1];
  let html = `<div class="kicker" style="text-align:center">${esc(edLabel(date))} · ${esc(fmtDate(date))}</div>`;
  if (front) html += `<figure class="reel-video"><div id="reel-slot"></div><figcaption class="caption">▶ ${esc((C.reel && C.reel.label) || 'Dagens nyhetsinnslag')}</figcaption></figure>`;
  if (front) html += todayBox() + '<div id="poll-slot"></div>';
  if (!arts.length) html += quoteBox(date) + resultsBox(date);
  if (!arts.length) html += `<p class="empty">Ingen saker i denne utgaven ennå. Redaksjonen sover. <a href="#/skriv">Skriv den første!</a></p>`;
  else {
    html += articleHtml(arts[0], true);
    html += quoteBox(date) + resultsBox(date);
    if (arts.length > 1) html += `<div class="secondary-grid">${arts.slice(1).map(a => articleHtml(a, false)).join('')}</div>`;
  }
  html += `<div class="rule-double"></div><div class="btn-row">
    ${prev ? `<a class="btn ghost" href="#/utgave/${prev}">← Forrige utgave</a>` : ''}
    ${next ? `<a class="btn ghost" href="#/utgave/${next}">Neste utgave →</a>` : ''}
    <a class="btn" href="#/skriv">✎ Skriv dagens sak</a></div>`;
  setTimeout(() => {
    document.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
      if (!confirm('Trekke tilbake saken? Den forsvinner for alle.')) return;
      try { await publish({ t: 'del', aid: b.dataset.del, by: clientId }); toast('Saken er trukket tilbake.'); render(); } catch (e) { toast(e.message); }
    });
  });
  return html;
}
function viewArchive(S) {
  const by = {}; for (const a of S.arts) (by[a.date] ||= []).push(a);
  const ds = Object.keys(by).sort().reverse();
  return `<h2 class="headline" style="font-size:34px">Arkivet</h2><p class="intro">Alle utgaver av Padel-Posten. Bevis for alt som er sagt og gjort.</p>
  <div class="arch">${ds.map(d => `<a href="#/utgave/${d}"><div class="d">${esc(edLabel(d))} · ${esc(fmtDate(d))}</div><div class="h">${esc(by[d][0].headline)}</div><div class="tiny">${by[d].length} sak${by[d].length > 1 ? 'er' : ''}</div></a>`).join('')}</div>`;
}
const progDays = () => (C.program && C.program.days) || [];
const fmtProgDay = ds => { const s = new Intl.DateTimeFormat('nb-NO', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(ds + 'T12:00:00Z')); const t = s.replace(/([a-zæøå])\./gi, '$1'); return t.charAt(0).toUpperCase() + t.slice(1); };
function progItems(d) {
  return `<table class="prog">${d.items.map(i => `<tr><td class="pt">${esc(i.t)}</td><td><b>${esc(i.what)}</b>${i.note ? `<span class="pn">${esc(i.note)}</span>` : ''}${i.quip ? `<span class="pq">${esc(i.quip)}</span>` : ''}</td></tr>`).join('')}</table>`;
}
function todayBox() {
  const d = progDays().find(x => x.date === osloDate()); if (!d) return '';
  return `<aside class="today-box"><div class="tb-head"><span>I DAG</span><span>${esc(fmtProgDay(d.date))}</span></div><div class="tb-title">${esc(d.title)}</div>${progItems(d)}<a class="tb-more" href="#/program">Hele programmet →</a></aside>`;
}
/* ---------- anonym undersøkelse (v27) ----------
   Stemme = {t:'poll', q, d, n}. d er en tilfeldig enhets-id kun for denne undersøkelsen (ikke clientId, ikke navn).
   Siste stemme per d teller. Viser kun antall, snitt og median (fra 3 svar) og grov fordeling (fra 5 svar). */
const POLL = { id: 'sx1', q: 'Hvor mange ganger har du sex i måneden?', min: 3, hist: 5, max: 60 };
const pollDev = () => LS.get('pp_poll_dev') || (() => { const v = [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join(''); LS.set('pp_poll_dev', v); return v; })();
const nf1 = x => new Intl.NumberFormat('nb-NO', { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(x);
const nfm = x => new Intl.NumberFormat('nb-NO', { maximumFractionDigits: 1 }).format(x);
function pollCheck(raw) {
  const s = String(raw || '').trim().replace(/\s/g, '');
  if (!s) return 'Skriv et tall. Null er også et svar.';
  if (/^-/.test(s)) return 'Minus? Da er det noe du ikke forteller oss.';
  if (!/^\d+$/.test(s)) return 'Bare hele tall, takk. Dette er en seriøs avis.';
  const n = +s;
  if (n > POLL.max) return 'Redaksjonen tror ikke på deg. Prøv et tall mellom 0 og 60.';
  return n;
}
function pollStats(vals) {
  const a = [...vals].sort((x, y) => x - y), n = a.length;
  if (!n) return { n };
  const avg = a.reduce((s, x) => s + x, 0) / n;
  const med = n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2;
  const B = [['0', x => x === 0], ['1–2', x => x >= 1 && x <= 2], ['3–5', x => x >= 3 && x <= 5], ['6–10', x => x >= 6 && x <= 10], ['11+', x => x >= 11]];
  return { n, avg, med, hist: B.map(([l, f]) => [l, a.filter(f).length]) };
}
let pollEl;
function pollBox() {
  if (pollEl) return pollEl;
  pollEl = document.createElement('aside'); pollEl.className = 'poll-box'; pollEl.id = 'poll-box';
  pollEl.innerHTML = `<div class="pb-head">PADEL-POSTENS STORE ANONYME UNDERSØKELSE</div>
    <div class="pb-q">«${esc(POLL.q)}»</div>
    <form class="pb-form" novalidate><input id="pb-n" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="off" placeholder="0–60" aria-label="Antall ganger i måneden"><button type="submit">Send anonymt</button></form>
    <div class="pb-done" hidden>✓ Ditt svar er registrert. <button type="button" class="pb-edit">Endre svar</button></div>
    <div class="pb-msg" role="status"></div>
    <div class="pb-res"></div>
    <div class="pb-fine">Helt anonymt: ingen navn, ingen innlogging. Én stemme per telefon – nytt svar erstatter det gamle. Ingen enkeltsvar vises.</div>`;
  const form = $('.pb-form', pollEl), inp = $('#pb-n', pollEl), msg = $('.pb-msg', pollEl), done = $('.pb-done', pollEl), btn = $('button', form);
  const showForm = f => { form.hidden = !f; done.hidden = f; };
  showForm(!LS.get('pp_poll_' + POLL.id, false));
  $('.pb-edit', pollEl).onclick = () => { showForm(true); inp.value = ''; msg.textContent = ''; inp.focus(); };
  form.onsubmit = async e => {
    e.preventDefault();
    const n = pollCheck(inp.value);
    if (typeof n === 'string') { msg.textContent = n; msg.className = 'pb-msg err'; return; }
    btn.disabled = true; inp.disabled = true; msg.className = 'pb-msg'; msg.textContent = 'Sender anonymt…';
    try {
      await new Promise(r => setTimeout(r, 1500 + Math.random() * 3500)); // litt tilfeldig forsinkelse: tidspunktet avslører mindre
      await publish({ t: 'poll', q: POLL.id, d: pollDev(), n });
      LS.set('pp_poll_' + POLL.id, true); inp.value = ''; msg.textContent = 'Takk! Svaret er talt – og glemt.'; showForm(false); scheduleRender();
    } catch (err) { msg.className = 'pb-msg err'; msg.textContent = 'Trykkeriet svarte ikke. Prøv igjen.'; }
    finally { btn.disabled = false; inp.disabled = false; }
  };
  return pollEl;
}
function updatePoll(S) {
  const el = pollBox(), st = pollStats(S.poll || []), res = $('.pb-res', el);
  let h;
  if (st.n < POLL.min) h = `<div class="pb-wait"><b>${st.n}</b> ${st.n === 1 ? 'svar' : 'svar'} så langt. Tallene vises når minst ${POLL.min} har svart – av hensyn til anonymiteten.</div>`;
  else {
    h = `<div class="vstats"><div><b>${st.n}</b><span>Svar</span></div><div><b>${nf1(st.avg)}</b><span>Snitt</span></div><div><b>${nfm(st.med)}</b><span>Median</span></div></div>`;
    if (st.n >= POLL.hist) { const mx = Math.max(...st.hist.map(x => x[1]), 1); h += `<table class="pb-hist">${st.hist.map(([l, c]) => `<tr><td class="hl">${l}</td><td>${c ? `<span class="hb" style="width:${Math.round(c / mx * 100)}%"></span>` : ""}</td><td class="hc">${c}</td></tr>`).join('')}</table>`; }
    else h += `<div class="pb-wait">Fordelingen vises fra ${POLL.hist} svar.</div>`;
    h += `<div class="pb-quip">Snittet er sannsynligvis løgn, men det er vår løgn.</div>`;
  }
  if (res.innerHTML !== h) res.innerHTML = h;
  return el;
}
function viewProgram() {
  const P = C.program; if (!P) return '<p class="empty">Programmet er ikke trykket ennå.</p>';
  const today = osloDate(), V = P.venue || {};
  return `<div class="kicker">Offisielt program</div><h2 class="headline" style="font-size:34px">Programmet</h2>
  <p class="intro">Seks dager, én villa i La Quinta og et urovekkende antall padeltimer. Reisesjefen har lagt planen. Avisen tar ikke ansvar for avvik.</p>
  ${P.days.map(d => `<section class="prog-day${d.date === today ? ' is-today' : ''}"><h3 class="prog-h"><span>${esc(fmtProgDay(d.date))}</span>${d.date === today ? '<em>I DAG</em>' : ''}</h3><div class="prog-sub">${esc(d.title)}</div>${progItems(d)}</section>`).join('')}
  ${(P.staff || []).length ? `<section class="venue staff"><div class="kicker">Reisens stab</div><table class="prog">${P.staff.map(x => `<tr><td class="pt">${esc(x[0])}</td><td><b>${esc(x[1])}</b></td></tr>`).join('')}</table>${P.staffQuip ? `<p class="pq">${esc(P.staffQuip)}</p>` : ''}</section>` : ''}
  ${P.villa ? `<section class="venue villa"><div class="kicker">Bosted</div><h3 class="prog-h"><span>${esc(P.villa.name)}</span></h3><div class="prog-sub">${esc(P.villa.where || '')}</div>${P.villa.stats ? `<div class="vstats">${P.villa.stats.map(x => `<div><b>${esc(x[0])}</b><span>${esc(x[1])}</span></div>`).join('')}</div>` : ''}<p>${esc(P.villa.desc || '')}</p>${(P.villa.quips || []).length ? `<ul class="vquips">${P.villa.quips.map(q => `<li>${esc(q)}</li>`).join('')}</ul>` : ''}</section>` : ''}
  ${V.name ? `<section class="venue"><div class="kicker">Arenaen</div><h3 class="prog-h"><span>${esc(V.name)}</span></h3><div class="prog-sub">${esc(V.where || '')}</div><p>${esc(V.desc || '')}</p>${V.quip ? `<p class="pq">${esc(V.quip)}</p>` : ''}</section>` : ''}`;
}
function viewRooms() {
  return `<div class="kicker">Offisielt dokument</div><h2 class="headline" style="font-size:34px">Romfordelingen</h2>
  <p class="intro">Redaksjonen har fått tak i den hemmelige romlisten. Merk spesielt de lydisolerte enerommene.</p>
  <table class="rooms">${C.rooms.map(r => `<tr><td>${esc(r.room)}<span class="beds">${esc(r.beds)}</span></td><td>${r.guys.map(id => esc(guyById(id).name) + (['engdahl', 'hoffgaard'].includes(id) ? ' <i>(snorker)</i>' : '')).join(',<br>')}${r.note ? `<span class="note">${esc(r.note)}</span>` : ''}</td></tr>`).join('')}</table>`;
}
function viewLooks(S) {
  const my = LS.get('pp_votes', {});
  return `<div class="kicker">Stor kartlegging</div><h2 class="headline" style="font-size:clamp(30px,9vw,48px)">Dobbeltgjengere</h2>
  <p class="intro">Padel-Postens ekspertpanel har kartlagt hvilke kjendiser deltakerne ligner på. Panelet har aldri sett noen av dem. Stem på den som passer best – én stemme per mann per telefon. Last gjerne opp et bilde av deg selv, så vi har noe å sammenligne med.</p>
  ${C.guys.map(g => {
    const t = S.tally[g.id], tot = t.reduce((a, b) => a + b, 0), mine = my[g.id];
    const voted = mine !== undefined;
    const lead = tot ? t.indexOf(Math.max(...t)) : -1;
    return `<section class="guy ${voted ? 'voted' : ''}" id="g-${g.id}">
      <div class="guy-head">
        <div><div class="guy-photo halftone" ${S.photos[g.id] ? `data-img="${S.photos[g.id]}"` : g.photo ? `data-defimg="${esc(g.photo)}"` : ''}><div class="silhouette">${SIL}</div></div>
        <label class="upload-btn">📷 ${S.photos[g.id] || g.photo ? 'Bytt bilde' : 'Last opp bilde'}<input type="file" accept="image/*" data-up="${g.id}"></label></div>
        <div><p class="guy-name">${esc(g.name)}</p>${g.role ? `<div class="guy-role">${esc(g.role)}</div>` : ''}<div class="guy-room">${esc(g.room)}</div><p class="guy-tag">${esc(g.tag)}</p>
        <p class="leader">${tot ? `Folkets dom så langt: <b>${esc(g.looks[lead].name)}</b> (${tot} stemme${tot > 1 ? 'r' : ''})` : 'Ingen stemmer ennå. Bli den første!'}</p></div>
      </div>
      <div class="looks">${g.looks.map((l, i) => {
        const pct = tot ? Math.round(100 * t[i] / tot) : 0;
        return `<div class="look ${mine === i ? 'mine' : ''}">
          <div class="halftone"${l.img ? ` data-defimg="${esc(l.img)}" data-hot="${esc(l.hot || '')}"` : ''}>${l.img && !String(l.img).startsWith('data/') ? `<img loading="lazy" src="${esc(l.img)}" alt="${esc(l.name)}">` : `<div class="initials">${esc(l.name.split(' ').map(w => w[0]).slice(0, 2).join(''))}</div>`}</div>
          ${l.credit ? `<div class="credit"><a href="${esc(l.src)}" target="_blank" rel="noopener">${esc(l.credit)}</a></div>` : ''}
          <p class="look-name">${esc(l.name)}</p><div class="look-what">${esc(l.what)}</div>
          <p class="look-cap">${esc(l.cap)}</p>
          <button class="vote-btn" data-vote="${g.id}:${i}" ${voted ? 'disabled' : ''}>${mine === i ? '✔ Din stemme' : voted ? `${t[i]} stemme${t[i] === 1 ? '' : 'r'}` : 'Stem: Ligner mest!'}</button>
          <div class="bar"><span style="width:${pct}%"></span></div><div class="pct"><span>${pct}%</span><span>${t[i]}</span></div>
        </div>`;
      }).join('')}</div>
    </section>`;
  }).join('')}`;
}
function bindLooks() {
  document.querySelectorAll('[data-vote]').forEach(b => b.onclick = async () => {
    const [guy, c] = b.dataset.vote.split(':'); const my = LS.get('pp_votes', {});
    if (my[guy] !== undefined) return;
    b.disabled = true; b.textContent = 'Sender…';
    try { await publish({ t: 'vote', guy, c: +c, voter: clientId }); my[guy] = +c; LS.set('pp_votes', my); toast('Stemmen er talt! Takk for ditt bidrag til demokratiet.'); }
    catch (e) { toast('Klarte ikke å sende stemmen: ' + e.message); }
    const y = scrollY; render(); scrollTo(0, y);
  });
  document.querySelectorAll('[data-up]').forEach(inp => inp.onchange = async () => {
    const f = inp.files[0]; if (!f) return; const guy = inp.dataset.up;
    toast('Laster opp bilde av ' + guyById(guy).name + '…', 15000);
    try { await publishPhoto(f, 'guy:' + guy, 900); toast('Bildet er trykket!'); }
    catch (e) { toast('Opplasting feilet: ' + e.message); }
    const y = scrollY; render(); scrollTo(0, y);
  });
}
function viewWrite() {
  const today = osloDate(); const last = LS.get('pp_author', '');
  return `<div class="kicker">Til redaksjonen</div><h2 class="headline" style="font-size:34px">Skriv dagens sak</h2>
  <p class="intro">Alt du sender inn trykkes umiddelbart for alle med passordet. Redaksjonen tar ikke ansvar for noe som helst.</p>
  <form id="write-form" class="form">
    <label for="f-h">Overskrift *</label><input id="f-h" required maxlength="120" placeholder="F.eks. SJOKKTAP I FØRSTE KAMP">
    <label for="f-s">Ingress</label><input id="f-s" maxlength="200" placeholder="Én saftig setning">
    <div class="media-pick">
      <div class="media-title">Bilder og video <span>(valgfritt)</span></div>
      <label class="media-btn" for="f-m">📷 🎬 Legg til bilder/video</label>
      <input id="f-m" class="media-input" type="file" accept="image/*,video/*" multiple>
      <p class="hint">Velg fra Bilder-appen – gjerne flere på en gang: opptil 8 bilder og én video (maks 60 sek og 15 MB). Første bilde blir hovedbilde.</p>
      <div id="f-vid"></div>
      <div id="f-pics" class="pics"></div>
    </div>
    <p class="hint">For lang video? Trim klippet i Bilder-appen (Rediger) først. På hotell-Wi-Fi deler alle en felles kvote – bruk gjerne mobildata.</p>
    <label for="f-b">Brødtekst *</label><textarea id="f-b" required placeholder="Fortell alt. Overdriv gjerne."></textarea>
    <label for="f-a">Byline</label><input id="f-a" list="guylist" maxlength="60" value="${esc(last)}" placeholder="Ditt navn eller «Anonym kilde»">
    <datalist id="guylist">${C.guys.map(g => `<option value="${esc(g.name)}">`).join('')}<option value="Anonym kilde"></datalist>
    <label for="f-d">Utgave (dato)</label><input id="f-d" type="date" value="${today}">
    <p class="hint">Saken havner i utgaven for valgt dato. Nyeste sak blir hovedoppslag på forsiden.</p>
    <div class="btn-row"><button class="btn" type="submit" id="f-go">Send til trykkeriet</button><a class="btn ghost" href="#/">Avbryt</a></div>
  </form>`;
}
function bindWrite() {
  const mIn = $('#f-m'), box = $('#f-pics'); const pics = [];
  const draw = () => {
    box.innerHTML = pics.map((x, k) => `<div class="pic"><img src="${x.url}" alt=""><button type="button" class="pic-x" data-k="${k}" aria-label="Fjern">✕</button><input data-c="${k}" maxlength="160" value="${esc(x.caption)}" placeholder="${k ? 'Bildetekst' : 'Bildetekst (hovedbilde)'}"></div>`).join('');
    box.querySelectorAll('[data-c]').forEach(i => i.oninput = () => pics[+i.dataset.c].caption = i.value);
    box.querySelectorAll('.pic-x').forEach(b => b.onclick = () => { pics.splice(+b.dataset.k, 1); draw(); });
  };
  const vBox = $('#f-vid'); let vid = null;
  const fmtDur = d => { d = Math.round(d || 0); return `${Math.floor(d / 60)}:${String(d % 60).padStart(2, '0')}`; };
  const drawV = () => {
    vBox.innerHTML = vid ? `<div class="pic vpic"><div class="vthumb" id="f-vt">${vid.posterUrl ? `<img src="${vid.posterUrl}" alt="">` : '<div class="vid-ph small">🎬</div>'}<span class="vplay">▶</span>${vid.info.dur ? `<span class="vdur">${fmtDur(vid.info.dur)}</span>` : ''}</div><div class="vmeta">🎬 Video · ${vid.info.dur ? Math.round(vid.info.dur) + ' sek · ' : ''}${fmtMB(vid.file.size)}</div><button type="button" class="pic-x" id="f-vx" aria-label="Fjern video">✕</button><input id="f-vc" maxlength="160" value="${esc(vid.caption)}" placeholder="Videotekst"></div>` : '';
    if (!vid) return;
    $('#f-vc').oninput = e => vid.caption = e.target.value;
    $('#f-vx').onclick = () => { if (vid.url) URL.revokeObjectURL(vid.url); vid = null; drawV(); };
    $('#f-vt').onclick = () => { const t = $('#f-vt'); if (t.querySelector('video')) return; vid.url ||= URL.createObjectURL(vid.file);
      const v = document.createElement('video'); v.src = vid.url; v.controls = true; v.playsInline = true; v.setAttribute('playsinline', ''); if (vid.posterUrl) v.poster = vid.posterUrl;
      t.innerHTML = ''; t.appendChild(v); v.play().catch(() => {}); };
  };
  const isVideoFile = f => /^video\//.test(f.type) || /\.(mov|mp4|m4v|3gp|webm)$/i.test(f.name || '');
  const addVideo = async f => {
    if (f.size > VID_MAX) { toast(videoProblem(f, {}), 6000); return; }
    vBox.innerHTML = '<p class="hint">Sjekker videoen…</p>';
    const info = await probeVideo(f); const why = videoProblem(f, info);
    if (why) { drawV(); toast(why, 6000); return; }
    const cap = vid ? vid.caption : ''; if (vid && vid.url) URL.revokeObjectURL(vid.url);
    vid = { file: f, info, caption: cap, posterUrl: info.poster ? URL.createObjectURL(info.poster) : null }; drawV();
  };
  mIn.onchange = async () => {
    const files = [...mIn.files]; mIn.value = ''; if (!files.length) return;
    const vids = files.filter(isVideoFile), imgs = files.filter(f => !isVideoFile(f));
    let skipped = 0;
    for (const f of imgs) { if (pics.length < 8) pics.push({ file: f, url: URL.createObjectURL(f), caption: '' }); else skipped++; }
    draw();
    if (skipped) toast(`Maks 8 bilder – ${skipped} ble ikke lagt til.`, 4000);
    if (vids.length) { if (vids.length > 1 || vid) toast(vids.length > 1 ? 'Kun én video per sak – jeg tok den første.' : 'Kun én video per sak – den nye erstatter den forrige.', 4500); await addVideo(vids[0]); }
  };
  $('#write-form').onsubmit = async ev => {
    ev.preventDefault(); const go = $('#f-go'); go.disabled = true;
    try {
      const a = { t: 'article', aid: 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), by: clientId,
        headline: $('#f-h').value.trim(), sub: $('#f-s').value.trim(), body: $('#f-b').value.trim(),
        author: $('#f-a').value.trim() || 'Anonym kilde', date: $('#f-d').value || osloDate() };
      if (!a.headline || !a.body) throw new Error('Overskrift og brødtekst må fylles ut.');
      LS.set('pp_author', $('#f-a').value.trim());
      const up = [];
      for (let k = 0; k < pics.length; k++) {
        go.textContent = `Laster opp bilde ${k + 1} av ${pics.length}…`;
        up.push({ id: await publishPhoto(pics[k].file, 'art:' + a.aid, 1400), caption: pics[k].caption.trim() });
      }
      if (up.length) { a.photo = up[0].id; a.caption = up[0].caption; if (up.length > 1) a.photos = up.slice(1); }
      if (vid) { const vm = await publishVideo(vid.file, vid.info, a.aid, t => go.textContent = t); vm.caption = vid.caption.trim(); a.videos = [vm]; }
      go.textContent = 'Trykker…';
      await publish(a);
      toast('Stopp pressen! Saken er trykket.');
      location.hash = '#/utgave/' + a.date;
    } catch (e) { toast(e.message, 4000); go.disabled = false; go.textContent = 'Send til trykkeriet'; }
  };
}
let celebBundle;
async function defaultImageUrl(path) {
  if (blobCache.has(path)) return blobCache.get(path);
  if (path.includes('#')) {
    const [file, key] = path.split('#');
    celebBundle ||= (async () => { const r = await fetchFirst([file + '?v=' + APP_VER, REPO_RAW + file]); const t = (await r.text()).trim(); return JSON.parse(dec.decode(await decBytes(b64.dec(t.slice(3))))); })().catch(() => { celebBundle = null; return {}; });
    const pr = celebBundle.then(m => m[key] ? URL.createObjectURL(new Blob([b64.dec(m[key])], { type: 'image/jpeg' })) : null).catch(() => null);
    blobCache.set(path, pr); return pr;
  }
  const pr = (async () => { try {
    const r = await fetchFirst(dataUrls(path).map(u => u.replace(/\?t=\d+$/, '')));
    const t = (await r.text()).trim();
    const raw = await decBytes(b64.dec(t.slice(3)));
    return URL.createObjectURL(new Blob([raw], { type: 'image/jpeg' }));
  } catch { return null; } })();
  blobCache.set(path, pr); return pr;
}
function hydrateImages() {
  hydrateVideos(); hydrateSeedFilms();
  document.querySelectorAll('[data-defimg]').forEach(async el => {
    const u = (await defaultImageUrl(el.dataset.defimg)) || el.dataset.hot || null;
    if (u && el.isConnected) { const img = new Image(); img.alt = ''; img.src = u; el.innerHTML = ''; el.appendChild(img); }
  });
  document.querySelectorAll('[data-img]').forEach(async el => {
    const id = el.dataset.img; const u = await imageUrl(id);
    if (u && el.isConnected) { const img = new Image(); img.alt = ''; img.src = u; el.innerHTML = ''; el.appendChild(img); }
    else if (el.isConnected && !u && !el.querySelector('.silhouette')) el.innerHTML = '<div class="initials" style="font-size:16px;padding:20px;text-align:center">Bildet er på vei fra trykkeriet…</div>';
  });
}

/* ---------- nyhetsinnslag (filmavis) ---------- */
let reelTimers = [];
function playReel(S) {
  const latest = [...S.arts].sort((a, b) => b.ts - a.ts)[0];
  const frames = [
    { cd: 3 }, { cd: 2 }, { cd: 1 },
    { big: 'Ekstra! 15 nordmenn lander i Marbella', small: 'Racketbager, solkrem og urokkelig selvtillit' },
    { big: 'Lysnes og Grønneberg utropt til hovedroller', small: '– Selvutnevnt, bekrefter kilder' },
    { big: 'Snorkealarm i rom 6 og 7', small: 'Naboer bestiller ørepropper i bulk' },
    { big: 'Padelnivå: «Lovende»', small: 'ifølge deltakernes mødre' },
    { big: latest ? latest.headline : 'Hvem blir turens dobbeltgjenger?', small: latest ? 'Dagens hovedoppslag' : 'Stem nå!' },
    { big: 'Følg Padel-Posten hver dag', small: 'Stopp pressen – vi trykker alt' }
  ];
  const stage = $('#reel-stage'); $('#reel').hidden = false;
  reelTimers.forEach(clearTimeout); reelTimers = [];
  let t = 0;
  frames.forEach(f => {
    reelTimers.push(setTimeout(() => {
      stage.innerHTML = f.cd ? `<div class="countdown">${f.cd}</div>` :
        `<div class="spinpaper paper"><div class="mini">Padel-Posten</div><div class="big">${esc(f.big)}</div><div class="small">${esc(f.small)}</div></div>`;
    }, t));
    t += f.cd ? 1000 : 3600;
  });
  reelTimers.push(setTimeout(closeReel, t + 400));
}
function closeReel() { reelTimers.forEach(clearTimeout); $('#reel').hidden = true; $('#reel-stage').innerHTML = ''; }

/* ---------- boot ---------- */
async function unlock(pw) {
  KEY = await deriveKey(pw);
  const r = await fetchFirst(dataUrls('data/content.enc'), { cache: 'no-store' });
  C = await decStr((await r.text()).trim());
  TOPIC = C.topic;
  if (C.appMin > APP_VER) checkVersion();
}
const APP_VER = 27;
async function checkVersion() {
  try {
    const r = await fetch('version.json?t=' + Date.now(), { cache: 'no-store' }); if (!r.ok) return;
    const v = (await r.json()).v;
    if (v > APP_VER) { const k = 'pp_reload_' + v; if (sessionStorage.getItem(k)) return; sessionStorage.setItem(k, '1'); location.replace(location.pathname + '?v=' + v + '&t=' + Date.now() + location.hash); }
  } catch {}
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkVersion(); });
async function start() {
  checkVersion();
  $('#gate').hidden = true; $('#app').hidden = false;
  render();
  await loadRepoEvents();
  await decodeAll(); render();
  connectLive();
  setInterval(async () => { await loadRepoEvents(); scheduleRender(); }, 10 * 60 * 1000);
}
window.addEventListener('hashchange', () => { scrollTo(0, 0); render(); });
$('#reel-close').onclick = closeReel;
$('#logout').onclick = e => { e.preventDefault(); localStorage.removeItem('pp_pw'); location.reload(); };
$('#gate-form').onsubmit = async e => {
  e.preventDefault(); const pw = $('#gate-pw').value; const btn = e.target.querySelector('button');
  btn.disabled = true; btn.textContent = 'Sjekker…';
  try { await unlock(pw); LS.set('pp_pw', pw); $('#gate-err').hidden = true; start(); }
  catch (err) { console.warn(err); $('#gate-err').hidden = false; btn.disabled = false; btn.textContent = 'Åpne avisen'; }
};
(async () => {
  const saved = LS.get('pp_pw', null);
  if (saved) { try { await unlock(saved); start(); return; } catch { localStorage.removeItem('pp_pw'); } }
  $('#gate-pw').focus();
})();
})();
