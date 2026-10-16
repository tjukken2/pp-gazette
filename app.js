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
const paras = t => esc(t).split(/\n\s*\n|\n/).filter(p => p.trim()).map(p => `<p>${p}</p>`).join('');
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
function scheduleRender() { clearTimeout(renderT); renderT = setTimeout(async () => { await decodeAll(); render(); }, 250); }
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
  const articles = new Map(), dels = [], votes = {}, photos = {};
  for (const s of C.seed) articles.set(s.aid, { ...s, seed: true, ts: Date.parse(s.time || (s.date + 'T08:00:00Z')) / 1000 });
  for (const e of list) {
    const p = decoded.get(e.id); if (!p) continue;
    if (p.t === 'article' && p.aid && p.headline) articles.set(p.aid, { ...p, ts: e.time, eid: e.id });
    else if (p.t === 'del') dels.push(p);
    else if (p.t === 'vote' && guyById(p.guy) && p.c >= 0 && p.c < 4) { (votes[p.guy] ||= {})[p.voter] = p.c; }
    else if (p.t === 'photo' && p.target && p.target.startsWith('guy:')) photos[p.target.slice(4)] = e.id;
  }
  for (const d of dels) { const a = articles.get(d.aid); if (a && !a.seed && a.by === d.by) articles.delete(d.aid); }
  const tally = {};
  for (const g of C.guys) { const t = [0, 0, 0, 0]; for (const c of Object.values(votes[g.id] || {})) t[c]++; tally[g.id] = t; }
  const arts = [...articles.values()].sort((a, b) => b.date.localeCompare(a.date) || b.ts - a.ts);
  return { arts, tally, photos };
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
  hydrateImages(S);
}
function richParas(a) {
  return a.body.split(/\n\s*\n|\n/).filter(p => p.trim()).map(p => {
    const m = p.match(/^\[\[bilde:(\d+)\]\]$/);
    if (m) { const x = (a.extra || [])[+m[1] - 1]; return x ? `<figure class="article-photo inline"><div class="halftone" data-defimg="${esc(x.photo)}"><div class="initials">⌛</div></div>${x.caption ? `<figcaption class="caption">${esc(x.caption)}</figcaption>` : ''}</figure>` : ''; }
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
    <div class="body">${a.seed ? richParas(a) : paras(a.body)}</div>
    ${own ? `<button class="del" data-del="${esc(a.aid)}">Trekk tilbake saken</button>` : ''}
  </article>`;
}
function viewEdition(S, date, front) {
  const arts = S.arts.filter(a => a.date === date);
  const dates = [...new Set(S.arts.map(a => a.date))];
  const i = dates.indexOf(date);
  const prev = dates[i + 1], next = dates[i - 1];
  let html = `<div class="kicker" style="text-align:center">${esc(edLabel(date))} · ${esc(fmtDate(date))}</div>`;
  if (front) html += `<div class="reel-teaser" id="reel-open"><span class="play">▶</span><span><b>Se dagens nyhetsinnslag</b><br><small>Filmavisen fra Haciendaen – ca. 25 sekunder</small></span></div>`;
  if (!arts.length) html += `<p class="empty">Ingen saker i denne utgaven ennå. Redaksjonen sover. <a href="#/skriv">Skriv den første!</a></p>`;
  else {
    html += articleHtml(arts[0], true);
    if (arts.length > 1) html += `<div class="secondary-grid">${arts.slice(1).map(a => articleHtml(a, false)).join('')}</div>`;
  }
  html += `<div class="rule-double"></div><div class="btn-row">
    ${prev ? `<a class="btn ghost" href="#/utgave/${prev}">← Forrige utgave</a>` : ''}
    ${next ? `<a class="btn ghost" href="#/utgave/${next}">Neste utgave →</a>` : ''}
    <a class="btn" href="#/skriv">✎ Skriv dagens sak</a></div>`;
  setTimeout(() => {
    const r = $('#reel-open'); if (r) r.onclick = () => playReel(S);
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
        <div><p class="guy-name">${esc(g.name)}</p><div class="guy-room">${esc(g.room)}</div><p class="guy-tag">${esc(g.tag)}</p>
        <p class="leader">${tot ? `Folkets dom så langt: <b>${esc(g.looks[lead].name)}</b> (${tot} stemme${tot > 1 ? 'r' : ''})` : 'Ingen stemmer ennå. Bli den første!'}</p></div>
      </div>
      <div class="looks">${g.looks.map((l, i) => {
        const pct = tot ? Math.round(100 * t[i] / tot) : 0;
        return `<div class="look ${mine === i ? 'mine' : ''}">
          <div class="halftone">${l.img ? `<img loading="lazy" src="${esc(l.img)}" alt="${esc(l.name)}">` : `<div class="initials">${esc(l.name.split(' ').map(w => w[0]).slice(0, 2).join(''))}</div>`}</div>
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
    <label for="f-b">Brødtekst *</label><textarea id="f-b" required placeholder="Fortell alt. Overdriv gjerne."></textarea>
    <label for="f-p">Bilde (valgfritt)</label><input id="f-p" type="file" accept="image/*"><img id="preview-img" alt="">
    <label for="f-c">Bildetekst</label><input id="f-c" maxlength="160" placeholder="F.eks. Her ser vi Baard etter tredje sett">
    <label for="f-a">Byline</label><input id="f-a" list="guylist" maxlength="60" value="${esc(last)}" placeholder="Ditt navn eller «Anonym kilde»">
    <datalist id="guylist">${C.guys.map(g => `<option value="${esc(g.name)}">`).join('')}<option value="Anonym kilde"></datalist>
    <label for="f-d">Utgave (dato)</label><input id="f-d" type="date" value="${today}">
    <p class="hint">Saken havner i utgaven for valgt dato. Nyeste sak blir hovedoppslag på forsiden.</p>
    <div class="btn-row"><button class="btn" type="submit" id="f-go">Send til trykkeriet</button><a class="btn ghost" href="#/">Avbryt</a></div>
  </form>`;
}
function bindWrite() {
  const p = $('#f-p'), pv = $('#preview-img');
  p.onchange = () => { const f = p.files[0]; if (f) { pv.src = URL.createObjectURL(f); pv.style.display = 'block'; } else pv.style.display = 'none'; };
  $('#write-form').onsubmit = async ev => {
    ev.preventDefault(); const go = $('#f-go'); go.disabled = true;
    try {
      const a = { t: 'article', aid: 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), by: clientId,
        headline: $('#f-h').value.trim(), sub: $('#f-s').value.trim(), body: $('#f-b').value.trim(), caption: $('#f-c').value.trim(),
        author: $('#f-a').value.trim() || 'Anonym kilde', date: $('#f-d').value || osloDate() };
      if (!a.headline || !a.body) throw new Error('Overskrift og brødtekst må fylles ut.');
      LS.set('pp_author', $('#f-a').value.trim());
      if (p.files[0]) { go.textContent = 'Laster opp bilde…'; a.photo = await publishPhoto(p.files[0], 'art:' + a.aid, 1400); }
      go.textContent = 'Trykker…';
      await publish(a);
      toast('Stopp pressen! Saken er trykket.');
      location.hash = '#/utgave/' + a.date;
    } catch (e) { toast(e.message, 4000); go.disabled = false; go.textContent = 'Send til trykkeriet'; }
  };
}
async function defaultImageUrl(path) {
  if (blobCache.has(path)) return blobCache.get(path);
  const pr = (async () => { try {
    const r = await fetchFirst(dataUrls(path).map(u => u.replace(/\?t=\d+$/, '')));
    const t = (await r.text()).trim();
    const raw = await decBytes(b64.dec(t.slice(3)));
    return URL.createObjectURL(new Blob([raw], { type: 'image/jpeg' }));
  } catch { return null; } })();
  blobCache.set(path, pr); return pr;
}
function hydrateImages() {
  document.querySelectorAll('[data-defimg]').forEach(async el => {
    const u = await defaultImageUrl(el.dataset.defimg);
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
    { big: 'Ekstra! 15 nordmenn lander i La Quinta', small: 'Racketbager, solkrem og urokkelig selvtillit' },
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
}
async function start() {
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
