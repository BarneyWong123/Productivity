// CullCraft — local AI photo culling and learned auto-editing.
import { isRaw, rawToJpeg } from './raw.js';
import { analyse, exifDate, initFaces, faceStatus } from './analyze.js';
import { initClip, clipAnalyse, clipStatus } from './ai.js';
import { cull, WEIGHTS, GENRES } from './cull.js';
import { LOOKS, applyLook, SLIDERS, ZERO, autoParams, styled, learnFrom, styleInfo, resetStyle, applyEdit } from './edit.js';
import { exportZip, csvReport, writeSidecars, canWriteFolder, download } from './export.js';
import { sampleShoot } from './sample.js';
import { recordDecision, learnedWeights, decisionCount, forgetDecisions } from './learn.js';
import { restore, remember, onSave } from './persist.js';
import { reviewSettings, saveReviewSettings, closeCalls, reviewStack } from './review.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const IMG_EXT = /\.(jpe?g|png|webp)$/i;

// ---------------- state ----------------
class Photo {
  constructor(id, file, src) {
    Object.assign(this, { id, file, src, name: file.name, key: `${file.name}:${file.size}`, raw: isRaw(file) });
    this.userFlag = undefined; this.userStars = undefined; this.edit = null; this.manual = false;
  }
  get flag() { return this.userFlag !== undefined ? this.userFlag : this.aiFlag; }
  get stars() { return this.userStars ?? this.aiStars ?? 0; }
}
let photos = [], groups = [], analysing = false;
const ui = { multi: new Set(), scene: null, survey: false, flags: new Set(), rating: 'any', edited: 'any', people: 'any', by: 'any', sort: 'time', reason: null, sel: null, loupe: false, compare: false, faces: true, before: false, tab: 'analysis' };

const SETTINGS_KEY = 'cullcraft.settings.v1';
const settings = Object.assign(
  { strictness: 0.5, similarity: 0.5, collapse: false, thumb: 200, faces: true, scene: true, genre: 'wedding', protectEmotion: true, sceneGap: 5 },
  (() => { try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch { return {}; } })(),
);
const saveSettings = () => { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* blocked */ } };

// ---------------- loading ----------------
const pickFiles = (e) => { load(e.target.files); e.target.value = ''; };
['#fileInput', '#folderInput', '#fileInput2', '#folderInput2'].forEach((s) => ($(s).onchange = pickFiles));
$('#sampleBtn').onclick = async () => { toast('Generating sample shoot…'); load(await sampleShoot(), 'Sample shoot'); };

let dragDepth = 0;
addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; document.body.classList.add('dragging'); });
addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', async (e) => {
  e.preventDefault(); dragDepth = 0; document.body.classList.remove('dragging');
  const entries = [...e.dataTransfer.items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.some((en) => en.isDirectory)) return load(e.dataTransfer.files);
  const out = [];
  const walk = async (en) => {
    if (en.isFile) out.push(await new Promise((res, rej) => en.file(res, rej)));
    else if (en.isDirectory) {
      const r = en.createReader();
      for (;;) { const b = await new Promise((res, rej) => r.readEntries(res, rej)); if (!b.length) break; for (const x of b) await walk(x); }
    }
  };
  for (const en of entries) await walk(en);
  load(out, entries.length === 1 && entries[0].isDirectory ? entries[0].name : null);
});

async function load(list, name) {
  if (analysing) return toast('Still analysing the current shoot. Wait for it to finish.');
  let files = [...list].filter((f) => IMG_EXT.test(f.name) || /image\/(jpeg|png|webp)/.test(f.type) || isRaw(f));
  // RAW+JPEG pairs: keep the RAW, skip its JPEG twin.
  const stem = (f) => f.name.replace(/\.[^.]+$/, '').toLowerCase();
  const raws = new Set(files.filter(isRaw).map(stem));
  files = files.filter((f) => isRaw(f) || !raws.has(stem(f)));
  if (!files.length) return toast('No photos found. CullCraft reads JPEG, PNG, WebP and RAW (ARW, NEF, CR2, DNG and more).');

  analysing = true;
  if (ui.loupe) closeLoupe();
  photos.forEach((p) => URL.revokeObjectURL(p.thumbUrl));
  cache.clear();
  photos = []; groups = []; ui.sel = null; ui.reason = null; ui.filter = 'all';
  const folder = name || files[0].webkitRelativePath?.split('/')[0] || 'Untitled shoot';
  $('#shootName').textContent = folder;
  $('#shootMeta').textContent = `${files.length} photos`;
  $('#welcome').hidden = true;
  $('#exportBtn').disabled = true;

  progress('Loading AI models', 'downloaded once, then cached', 0);
  if (settings.faces) { const pf = initFaces(); engineStatus(); await pf; }
  if (settings.scene) { const pc = initClip((f, file) => progress('Downloading scene model', file || '', f)); engineStatus(); await pc; }
  engineStatus();

  const t0 = performance.now();
  let restored = 0;
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const eta = i > 2 ? Math.round(((performance.now() - t0) / i) * (files.length - i) / 1000) : null;
    progress(`Analysing ${i + 1} of ${files.length}`, `${f.name}${eta !== null ? ` · about ${fmtDur(eta)} left` : ''}`, i / files.length);
    try {
      let src = f, rawTime = null;
      if (isRaw(f)) ({ blob: src, time: rawTime } = await rawToJpeg(f));
      const p = new Photo(i, f, src);
      p.an = await analyse(src, { faces: settings.faces && faceStatus() === 'ready' });
      p.an.clip = settings.scene ? await clipAnalyse(src) : null;
      p.time = rawTime ?? (await exifDate(f)) ?? f.lastModified;
      p.thumbUrl = URL.createObjectURL(p.an.thumb);
      if (restore(p)) restored++;
      photos.push(p);
      if (photos.length % 12 === 1) renderPending();
    } catch (err) { console.warn('Skipped', f.name, err); }
  }
  photos.sort((a, b) => a.time - b.time || a.name.localeCompare(b.name));
  photos.forEach((p, i) => (p.id = i));
  analysing = false;
  hideProgress();
  if (!photos.length) { $('#welcome').hidden = false; $('#grid').innerHTML = ''; return toast('None of those files could be read.'); }
  const secs = Math.max(1, Math.round((performance.now() - t0) / 1000));
  $('#shootMeta').textContent = `${photos.length} photos · analysed in ${fmtDur(secs)}`;
  $('#exportBtn').disabled = false; $('#applyStyle').disabled = false;
  groups = cull(photos, settings, learnedWeights(GENRES[settings.genre].weights));
  ui.sel = visible()[0]?.id ?? null;
  render();
  const skipped = files.length - photos.length;
  toast(`Culled ${photos.length} photos into ${groups.length} moments: ${countOf('pick')} picks.${skipped ? ` ${skipped} file(s) couldn't be read.` : ''}${restored ? ` Restored your earlier work on ${restored}.` : ''}`);
}
const fmtDur = (s) => (s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`);

function recull() {
  if (!photos.length || analysing) return;
  groups = cull(photos, settings, learnedWeights(GENRES[settings.genre].weights));
  render();
  if (ui.loupe) drawLoupe();
}

// ---------------- grid ----------------
const isHL = (p) => p.highlight && p.flag === 'pick';
const countOf = (f) => photos.filter((p) => p.flag === f).length;
const peopleIn = (p) => p.an.faces.filter((f) => f.size >= 0.02).length;
const filtersActive = () => ui.flags.size || ui.scene !== null || ui.reason || ui.rating !== 'any' || ui.edited !== 'any' || ui.people !== 'any' || ui.by !== 'any';
function visible() {
  let list = photos;
  if (ui.flags.size) list = list.filter((p) => ui.flags.has(p.flag) || (ui.flags.has('highlight') && isHL(p)));
  if (ui.scene !== null) list = list.filter((p) => p.scene === ui.scene);
  if (ui.reason) list = list.filter((p) => p.issues.some((i) => i.k === ui.reason));
  if (ui.rating === 'unrated') list = list.filter((p) => p.userStars === undefined);
  else if (ui.rating === 'rated') list = list.filter((p) => p.userStars !== undefined);
  else if (ui.rating !== 'any') { const [op, n] = [ui.rating[0], +ui.rating.slice(1)]; list = list.filter((p) => (op === '=' ? p.stars === n : op === '>' ? p.stars >= n : p.stars <= n)); }
  if (ui.edited !== 'any') list = list.filter((p) => (ui.edited === 'yes' ? !!p.edit : ui.edited === 'hand' ? p.manual : !p.edit));
  if (ui.people !== 'any') list = list.filter((p) => (ui.people === '0' ? peopleIn(p) === 0 : peopleIn(p) >= +ui.people));
  if (ui.by === 'you') list = list.filter((p) => p.userFlag !== undefined || p.userStars !== undefined);
  else if (ui.by === 'ai') list = list.filter((p) => p.userFlag === undefined);
  else if (ui.by === 'review') list = list.filter((p) => p.reviewPick);
  const by = { score: (x, y) => y.score - x.score, stars: (x, y) => y.stars - x.stars || y.score - x.score, name: (x, y) => x.name.localeCompare(y.name, undefined, { numeric: true }) }[ui.sort];
  if (by) list = [...list].sort(by);
  if (settings.collapse && !filtersActive()) {
    list = groups.map((g) => {
      const members = g.map((id) => photos[id]);
      return members.find((p) => p.flag === 'pick') || [...members].sort((a, b) => b.score - a.score)[0];
    });
  }
  return list;
}
const starHtml = (n) => '★'.repeat(n) + `<span class="off">${'★'.repeat(5 - n)}</span>`;
const FLAG_TEXT = { pick: 'Pick', dupe: 'Duplicate', reject: 'Reject' };
const escHtml = (s) => s.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);

function cardHtml(p) {
  const g = groups[p.group] || [];
  const cls = ['card', p.flag || '', p.id === ui.sel ? 'sel' : '', ui.multi.size > 1 && ui.multi.has(p.id) ? 'msel' : '', isHL(p) ? 'hl' : '', p.userFlag !== undefined ? 'user' : ''].join(' ');
  const why = p.flag === 'reject' ? p.issues.filter((i) => i.hard).map((i) => `<span>${i.t}</span>`).join('') : '';
  return `<div class="${cls}" data-id="${p.id}">
    <div class="ph" style="background-image:url('${p.thumbUrl}')"></div>
    ${p.flag ? `<span class="flag">${FLAG_TEXT[p.flag]}</span>` : ''}
    ${isHL(p) ? '<span class="hlb" title="Highlight: one of the best photos of the shoot">◆ Highlight</span>' : ''}
    <span class="best" title="AI score out of 100">${Math.round(p.score * 100)}</span>
    <div class="why">${why}</div>
    <div class="hov" aria-label="Quick actions">
      <button data-act="pick" class="${p.flag === 'pick' ? 'on' : ''}" title="Pick (P)">✓</button>
      <button data-act="reject" class="${p.flag === 'reject' ? 'on' : ''}" title="Reject (X)">✕</button>
      <span class="hstars">${[1, 2, 3, 4, 5].map((n) => `<button data-act="star" data-n="${n}" class="${n <= p.stars ? 'lit' : ''}" title="${n} star${n > 1 ? 's' : ''}">★</button>`).join('')}</span>
      <button data-act="edit" title="Edit (E)">Edit</button>
      <button data-act="open" title="Full view (Enter)">⤢</button>
    </div>
    ${p.edit ? '<span class="edited" title="Edited">EDITED</span>' : ''}
    <div class="meta"><span class="stars">${starHtml(p.stars)}</span>${g.length > 1 ? `<span title="Rank in stack">#${p.rankInGroup + 1}/${g.length}</span>` : ''}<span class="nm">${escHtml(p.name)}</span></div>
  </div>`;
}

function render() {
  $('#filterbar').hidden = !photos.length;
  renderScenes(); batchBar();
  updateCounts();
  const grid = $('#grid');
  if (!photos.length) { grid.innerHTML = ''; return; }
  const vis = visible();
  if (!vis.some((p) => p.id === ui.sel)) ui.sel = vis[0]?.id ?? null;
  let html = '', lastG = -1, open = false, lastScene = -1;
  const byStack = !filtersActive() && ui.sort === 'time' && !settings.collapse;
  if (!byStack) html += '<div class="cards">';
  for (const p of vis) {
    if (byStack && p.group !== lastG) {
      if (open) html += '</div></div>';
      lastG = p.group;
      const g = groups[p.group];
      const t = new Date(photos[g[0]].time);
      if (p.scene !== lastScene) { lastScene = p.scene; html += sceneHeader(p.scene); }
      html += `<div class="stack"><div class="stack-h"><strong>${g.length > 1 ? `Stack of ${g.length}` : 'Single'}</strong><span>${isNaN(t) ? '' : t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span><span class="line"></span></div><div class="cards">`;
      open = true;
    }
    html += cardHtml(p);
  }
  html += byStack ? (open ? '</div></div>' : '') : '</div>';
  if (!vis.length) html = '<p class="muted" style="text-align:center;margin-top:12vh">No photos match this filter.</p>';
  grid.innerHTML = html;
  scrollSel();
}
function sceneInfo(s) {
  const ps = photos.filter((p) => p.scene === s);
  const t0 = new Date(ps[0].time), t1 = new Date(ps[ps.length - 1].time);
  const fmt = (d) => (isNaN(d) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
  return { ps, picks: ps.filter((p) => p.flag === 'pick').length, span: `${fmt(t0)}–${fmt(t1)}`, cover: ps.find(isHL) || ps.find((p) => p.flag === 'pick') || ps[0] };
}
function sceneHeader(s) {
  const i = sceneInfo(s);
  return `<h2 class="scene-h">Scene ${s + 1}<span>${i.span} · ${i.ps.length} photos · ${i.picks} picks</span></h2>`;
}
function renderScenes() {
  const n = photos.length ? Math.max(...photos.map((p) => p.scene ?? 0)) + 1 : 0;
  $('#scenes').innerHTML = n ? Array.from({ length: n }, (_, s) => {
    const i = sceneInfo(s);
    return `<li data-s="${s}" class="${ui.scene === s ? 'on' : ''}"><img src="${i.cover.thumbUrl}" alt=""><div><b>Scene ${s + 1}</b><small>${i.span} · ${i.ps.length} · ${i.picks} picks</small></div></li>`;
  }).join('') : '<li class="muted">Scenes appear after culling</li>';
}
$('#scenes').onclick = (e) => { const li = e.target.closest('li[data-s]'); if (!li) return; ui.scene = ui.scene === +li.dataset.s ? null : +li.dataset.s; render(); };

function renderPending() {
  $('#grid').innerHTML = `<div class="cards">${photos.map((p) => `<div class="card pending"><div class="ph" style="background-image:url('${p.thumbUrl}')"></div><div class="meta"><span class="nm">${escHtml(p.name)}</span></div></div>`).join('')}</div>`;
}
function refreshCard(p) {
  const el = $(`.card[data-id="${p.id}"]`);
  if (el) el.outerHTML = cardHtml(p);
  updateCounts();
}
function scrollSel() { $(`.card[data-id="${ui.sel}"]`)?.scrollIntoView({ block: 'nearest' }); }
function select(id, keepMulti) {
  if (!keepMulti && ui.multi.size > 1) { ui.multi = new Set([id]); ui.sel = id; render(); return; }
  if (!keepMulti) ui.multi = new Set([id]);
  const prev = ui.sel; ui.sel = id;
  $(`.card[data-id="${prev}"]`)?.classList.remove('sel');
  $(`.card[data-id="${id}"]`)?.classList.add('sel');
  scrollSel();
}
$('#grid').addEventListener('click', (e) => {
  const c = e.target.closest('.card[data-id]'); if (!c) return;
  const p = photos[+c.dataset.id], b = e.target.closest('button[data-act]');
  if (!b && (e.shiftKey || e.metaKey || e.ctrlKey)) {
    if (e.shiftKey && ui.sel !== null) {
      const vis = visible(), i0 = vis.findIndex((q) => q.id === ui.sel), i1 = vis.findIndex((q) => q.id === p.id);
      if (!(e.metaKey || e.ctrlKey)) ui.multi = new Set();
      vis.slice(Math.min(i0, i1), Math.max(i0, i1) + 1).forEach((q) => ui.multi.add(q.id));
    } else if (ui.multi.has(p.id) && ui.multi.size > 1) ui.multi.delete(p.id);
    else ui.multi.add(p.id);
    ui.sel = p.id; render(); return;
  }
  if (!(b && ui.multi.size > 1 && ui.multi.has(p.id))) select(p.id);
  if (!b) return;
  e.stopPropagation();
  const act = b.dataset.act;
  if (act === 'pick' || act === 'reject') { const off = p.flag === act && p.userFlag !== undefined; batch((q) => setFlag(q, act, off)); }
  else if (act === 'star') { const n = p.userStars === +b.dataset.n ? 0 : +b.dataset.n; batch((q) => setStars(q, n)); }
  else if (act === 'edit') { openLoupe(); setTab('edit'); }
  else if (act === 'open') openLoupe();
});
$('#grid').addEventListener('dblclick', (e) => { if (e.target.closest('button')) return; const c = e.target.closest('.card[data-id]'); if (c) { select(+c.dataset.id); openLoupe(); } });

function updateCounts() {
  const n = photos.length, c = { pick: countOf('pick'), dupe: countOf('dupe'), reject: countOf('reject'), highlight: photos.filter(isHL).length };
  $('#fbCount').textContent = n ? `Showing ${visible().length} of ${n}` : '';
  $('#fbClear').hidden = !filtersActive();
  $$('#filters button').forEach((b) => {
    b.classList.toggle('on', b.dataset.f === 'all' ? !ui.flags.size : ui.flags.has(b.dataset.f));
    b.querySelector('b').textContent = !n ? '' : b.dataset.f === 'all' ? n : c[b.dataset.f];
  });
  $('#keepRate').textContent = n ? `${Math.round((c.pick / n) * 100)}%` : '—';
  ['pick', 'dupe', 'reject'].forEach((k) => ($(`#overviewBar .${k}`).style.width = n ? `${(c[k] / n) * 100}%` : 0));
  $('#legend').innerHTML = n ? [['pick', 'Picks'], ['dupe', 'Duplicates'], ['reject', 'Rejects']].map(([k, l]) => `<li><i class="dot ${k}"></i>${l}<b>${c[k]}</b></li>`).join('') : '';
  const reasons = {};
  for (const p of photos) if (p.flag !== 'pick') for (const i of p.issues) (reasons[i.k] ??= { t: i.t, n: 0 }).n++;
  if (reasons.eyes) reasons.eyes.t = 'Eyes closed / blinking';
  if (reasons.blur) reasons.blur.t = 'Out of focus / blurry';
  const keys = Object.keys(reasons);
  const allReasons = {};
  for (const p of photos) for (const i of p.issues) allReasons[i.k] ??= reasons[i.k]?.t || i.t;
  $('#fb-reason').innerHTML = '<option value="">Any problem</option>' + Object.entries(allReasons).map(([k, t]) => `<option value="${k}" ${ui.reason === k ? 'selected' : ''}>${t}</option>`).join('');
  $('#reasons').innerHTML = keys.length
    ? keys.sort((a, b) => reasons[b].n - reasons[a].n).map((k) => `<li data-r="${k}" class="${ui.reason === k ? 'on' : ''}">${reasons[k].t}<b>${reasons[k].n}</b></li>`).join('')
    : `<li class="muted">${n ? 'No problems found' : 'Nothing yet'}</li>`;
  const nd = decisionCount(), lw = learnedWeights(GENRES[settings.genre].weights);
  $('#learnText').textContent = lw
    ? `Scoring is tuned to ${nd} of your decisions. Focus ${pct(lw.sharp)}, composition ${pct(lw.aesthetic)}, eyes ${pct(lw.eyes)}, exposure ${pct(lw.exposure)}, expression ${pct(lw.expression)}.`
    : `Override a few picks and rejects (${nd} so far, at least 3 of each needed) and CullCraft re-weights its scoring to match your taste.`;
  $('#reviewBtn').disabled = !photos.length || analysing;
  const ns = styleInfo();
  $('#styleText').textContent = ns
    ? `Learned from ${ns} photo${ns > 1 ? 's' : ''} you edited by hand. Auto-edit applies it on top of exposure and white-balance correction.`
    : 'Edit a few photos by hand and CullCraft learns your look, then applies it to every pick.';
}
$('#reasons').onclick = (e) => { const li = e.target.closest('li[data-r]'); if (!li) return; ui.reason = ui.reason === li.dataset.r ? null : li.dataset.r; $('#fb-reason').value = ui.reason || ''; render(); };
// Flag filters combine like Lightroom: click to toggle each one; "All" clears them.
$$('#filters button').forEach((b) => (b.onclick = (e) => {
  const f = b.dataset.f;
  if (f === 'all') ui.flags.clear();
  else if (ui.flags.has(f)) ui.flags.delete(f);
  else { if (!e.shiftKey && !e.metaKey && !e.ctrlKey && ui.flags.size && false) ui.flags.clear(); ui.flags.add(f); }
  render();
}));
['rating', 'edited', 'people', 'by', 'sort'].forEach((k) => ($(`#fb-${k}`).onchange = (e) => { ui[k] = e.target.value; render(); }));
$('#fb-reason').onchange = (e) => { ui.reason = e.target.value || null; render(); };
$('#fbClear').onclick = () => {
  ui.flags.clear(); ui.reason = null; Object.assign(ui, { rating: 'any', edited: 'any', people: 'any', by: 'any' });
  ['rating', 'edited', 'people', 'by'].forEach((k) => ($(`#fb-${k}`).value = 'any')); $('#fb-reason').value = '';
  render();
};

// ---------------- sidebar controls ----------------
const pct = (v) => `${Math.round(v * 100)}%`;
function bindRange(id, key, after) {
  const el = $(`#${id}`), out = $(`#${id}Out`);
  el.value = settings[key]; if (out) out.textContent = pct(settings[key]);
  let t;
  el.oninput = () => { settings[key] = +el.value; if (out) out.textContent = pct(settings[key]); saveSettings(); clearTimeout(t); t = setTimeout(after, 120); };
}
bindRange('strictness', 'strictness', recull);
bindRange('similarity', 'similarity', recull);
bindRange('thumbSize', 'thumb', () => document.documentElement.style.setProperty('--thumb', `${settings.thumb}px`));
document.documentElement.style.setProperty('--thumb', `${settings.thumb}px`);
$('#genre').innerHTML = Object.entries(GENRES).map(([k, g]) => `<option value="${k}">${g.label}</option>`).join('');
$('#genre').value = settings.genre;
$('#genre').onchange = (e) => { settings.genre = e.target.value; saveSettings(); recull(); toast(`Scoring tuned for ${GENRES[settings.genre].label.toLowerCase()}.`); };
$('#protect').checked = settings.protectEmotion;
$('#protect').onchange = (e) => { settings.protectEmotion = e.target.checked; saveSettings(); recull(); };
$('#sceneGap').value = settings.sceneGap;
$('#sceneGap').onchange = (e) => { settings.sceneGap = Math.max(1, +e.target.value || 5); saveSettings(); recull(); };
$('#collapse').checked = settings.collapse;
$('#collapse').onchange = (e) => { settings.collapse = e.target.checked; saveSettings(); render(); };
$('#useFaces').checked = settings.faces;
$('#useScene').checked = settings.scene;
$('#useFaces').onchange = (e) => { settings.faces = e.target.checked; saveSettings(); engineStatus(); if (photos.length) toast('Applies to the next shoot you open.'); };
$('#useScene').onchange = (e) => { settings.scene = e.target.checked; saveSettings(); engineStatus(); if (photos.length) toast('Applies to the next shoot you open.'); };
function engineStatus() {
  const label = { off: 'not loaded', loading: 'loading…', ready: 'ready', failed: 'unavailable' };
  const set = (el, on, st) => { el.textContent = on ? label[st] : 'off'; el.className = `st ${on ? st : ''}`; el.title = st === 'failed' ? 'The model could not be downloaded. Check your internet connection and reload.' : ''; };
  set($('#faceSt'), settings.faces, faceStatus());
  set($('#sceneSt'), settings.scene, clipStatus());
}
engineStatus();
$('#applyStyle').onclick = () => {
  let n = 0;
  for (const p of photos) if (p.flag === 'pick' && !p.manual) { p.edit = styled(p.an); remember(p); n++; }
  toast(`Edited ${n} pick${n === 1 ? '' : 's'}${styleInfo() ? ' in your style' : ' with auto-correction'}.`);
  if (ui.loupe) drawLoupe();
};
$('#relearn').onclick = () => { recull(); toast(learnedWeights(GENRES[settings.genre].weights) ? 'Re-culled using weights learned from your decisions.' : 'Not enough decisions yet: override at least 3 picks and 3 rejects.'); };
$('#forgetLearn').onclick = () => { forgetDecisions(); recull(); toast('Forgot your culling decisions. Using default weights.'); };

// ---------------- optional AI close-call review ----------------
$('#orKey').value = reviewSettings.key; $('#orModel').value = reviewSettings.model;
$('#orKey').onchange = (e) => { reviewSettings.key = e.target.value.trim(); saveReviewSettings(); };
$('#orModel').onchange = (e) => { reviewSettings.model = e.target.value.trim() || 'google/gemini-2.5-flash'; saveReviewSettings(); };
$('#reviewBtn').onclick = async () => {
  if (!reviewSettings.key) return toast('Paste your OpenRouter API key first.');
  const calls = closeCalls(photos, groups);
  if (!calls.length) return toast('No close calls: every stack has a clear winner.');
  const btn = $('#reviewBtn'); btn.disabled = true;
  let changed = 0, done = 0, failed = 0, lastErr = '';
  for (const stack of calls) {
    progress(`AI reviewing close calls ${done + 1} of ${calls.length}`, `${stack.length} contenders · ${reviewSettings.model}`, done / calls.length);
    try {
      const { best, reason } = await reviewStack(stack);
      const before = stack.find((p) => p.aiFlag === 'pick');
      stack.forEach((p) => { p.reviewPick = p === best; p.reviewNote = p === best ? reason : null; remember(p); });
      if (before !== best) changed++;
    } catch (err) { failed++; lastErr = err.message; if (/key/i.test(err.message)) break; }
    done++;
  }
  hideProgress(); btn.disabled = false;
  recull();
  toast(failed && failed === done ? `Review failed: ${lastErr}` : `Reviewed ${done - failed} close call${done - failed === 1 ? '' : 's'}; changed the pick in ${changed}.${failed ? ` ${failed} failed: ${lastErr}` : ''}`);
};

$('#resetStyle').onclick = () => { resetStyle(); updateCounts(); toast('Learned style cleared.'); };

// ---------------- selection & batch ----------------
let quietBatch = false;
const targets = () => (ui.multi.size > 1 ? [...ui.multi].map((id) => photos[id]) : [photos[ui.sel]].filter(Boolean));
function batch(fn) {
  const t = targets();
  if (t.length === 1) return fn(t[0]);
  quietBatch = true; t.forEach((p) => fn(p)); quietBatch = false;
  t.forEach(remember);
  render(); if (ui.loupe) drawLoupe();
  toast(`Updated ${t.length} photos.`);
}
function batchBar() {
  const n = ui.multi.size > 1 ? ui.multi.size : 0;
  $('#batchbar').hidden = !n || ui.loupe;
  $('#bbCount').textContent = `${n} selected`;
}
let clipboard = null;
function copyEdit() {
  const p = photos[ui.sel]; if (!p) return;
  if (!p.edit) return toast('This photo has no edits to copy.');
  clipboard = { ...p.edit }; toast(`Copied edit settings from ${p.name}.`);
}
function pasteEdit() {
  if (!clipboard) return toast('Copy edit settings from a photo first (Ctrl/⌘+C).');
  const t = targets();
  t.forEach((p) => { p.edit = { ...clipboard }; p.manual = false; remember(p); });
  toast(`Pasted edit settings to ${t.length} photo${t.length > 1 ? 's' : ''}.`);
  if (ui.loupe) drawLoupe(); else render();
}
function lookTo(key) {
  const t = targets();
  t.forEach((p) => { p.edit = applyLook(p.an, key, styled); p.manual = false; remember(p); });
  toast(`Applied “${LOOKS[key].label}” to ${t.length} photo${t.length > 1 ? 's' : ''}.`);
  if (ui.loupe) drawLoupe(); else render();
}
$('#batchbar').onclick = (e) => {
  const b = e.target.closest('button[data-b]'); if (!b) return;
  const v = b.dataset.b;
  if (v === 'pick' || v === 'reject' || v === 'dupe') batch((q) => setFlag(q, v, false));
  else if (v === 'clear') batch((q) => { q.userFlag = undefined; q.userStars = undefined; recordDecision(q); });
  else if (v.startsWith('s')) batch((q) => setStars(q, +v.slice(1)));
  else if (v === 'paste') pasteEdit();
  else if (v === 'none') { ui.multi = new Set([ui.sel]); render(); }
};
$('#bbLook').innerHTML = '<option value="">Apply look…</option>' + Object.entries(LOOKS).map(([k, l]) => `<option value="${k}">${l.label}</option>`).join('');
$('#bbLook').onchange = (e) => { if (e.target.value) lookTo(e.target.value); e.target.value = ''; };

// ---------------- flags ----------------
function setFlag(p, f, toggleOff) {
  // Pressing the same flag again hands the photo back to the AI decision.
  p.userFlag = (toggleOff ?? (p.flag === f && p.userFlag !== undefined)) ? undefined : f;
  recordDecision(p);
  if (!quietBatch) afterChange(p);
}
function setStars(p, n) { p.userStars = n; if (!quietBatch) afterChange(p); }
function afterChange(p) {
  remember(p);
  if (ui.loupe) { loupeHeader(p); drawStrip(p); inspector(p, true); }
  else if (visible().some((q) => q.id === p.id)) refreshCard(p);
  else render();
  updateCounts();
}

// ---------------- keyboard ----------------
addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!$('#exportMenu').hidden) $('#exportMenu').hidden = true;
    else if (!$('#zoomView').hidden) $('#zoomView').hidden = true;
    else if (ui.survey) { ui.survey = false; drawLoupe(); }
    else if (ui.loupe) closeLoupe();
    else if (ui.multi.size > 1) { ui.multi = new Set([ui.sel]); render(); }
    return;
  }
  const typing = e.target.matches('input[type=range], input[type=text], input[type=password], input[type=number], select');
  if (!typing && (e.metaKey || e.ctrlKey) && !e.altKey) {
    const k = e.key.toLowerCase();
    if (k === 'c') { copyEdit(); e.preventDefault(); return; }
    if (k === 'v') { pasteEdit(); e.preventDefault(); return; }
    if (k === 'a' && !ui.loupe) { ui.multi = new Set(visible().map((q) => q.id)); render(); e.preventDefault(); return; }
  }
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
  const vis = visible(), idx = vis.findIndex((p) => p.id === ui.sel), p = vis[idx];
  if (!p) return;
  const go = (d) => { const n = vis[Math.max(0, Math.min(vis.length - 1, idx + d))]; if (n && n.id !== ui.sel) { select(n.id); if (ui.loupe) drawLoupe(); } };
  switch (e.key.toLowerCase()) {
    case 'arrowright': go(1); break;
    case 'arrowleft': go(-1); break;
    case 'arrowdown': if (ui.loupe) return; go(cols()); break;
    case 'arrowup': if (ui.loupe) return; go(-cols()); break;
    case 'p': case 'x': case 'd': {
      const f = { p: 'pick', x: 'reject', d: 'dupe' }[e.key.toLowerCase()];
      if (targets().length > 1) batch((q) => setFlag(q, f, false)); else { setFlag(p, f); go(1); }
      break;
    }
    case 'u': batch((q) => { q.userFlag = undefined; q.userStars = undefined; recordDecision(q); if (!quietBatch) afterChange(q); }); break;
    case '0': case '1': case '2': case '3': case '4': case '5': batch((q) => setStars(q, +e.key)); break;
    case 's': if (!ui.loupe) openLoupe(); ui.survey = !ui.survey; drawLoupe(); break;
    case 'z': if (!ui.loupe) return; zoomAt(photos[ui.sel], null); break;
    case 'enter': case ' ': ui.loupe ? closeLoupe() : openLoupe(); break;
    case 'c': ui.compare = !ui.compare; ui.loupe ? drawLoupe() : openLoupe(); break;
    case 'f': if (e.shiftKey) { toggleFullscreen(); break; } if (!ui.loupe) return; ui.faces = !ui.faces; drawOverlay(p); syncToggles(); break;
    case 'e': if (!ui.loupe) openLoupe(); setTab(ui.tab === 'edit' ? 'analysis' : 'edit'); break;
    case 'a': if (!ui.loupe) return; $('#autoBtn').click(); break;
    case '\\': if (ui.loupe && !ui.before) { ui.before = true; paintMain(p); syncToggles(); } break;
    default: return;
  }
  e.preventDefault();
});
addEventListener('keyup', (e) => { if (e.key === '\\' && ui.before) { ui.before = false; const p = photos[ui.sel]; if (p) paintMain(p); syncToggles(); } });
function cols() { const c = $(`.card[data-id="${ui.sel}"]`)?.parentElement || $('.cards'); return c ? getComputedStyle(c).gridTemplateColumns.split(' ').length : 1; }

// ---------------- full screen ----------------
function toggleFullscreen() {
  if (!ui.loupe) openLoupe();
  const el = document.documentElement;
  if (document.fullscreenElement) document.exitFullscreen?.();
  else (el.requestFullscreen?.() || Promise.reject()).catch(() => toast('Full screen is not available here. Press F11 in your browser instead.'));
}
document.addEventListener('fullscreenchange', () => { $('#togFull').classList.toggle('on', !!document.fullscreenElement); document.body.classList.toggle('full', !!document.fullscreenElement); setTimeout(placeOverlay, 50); });

// ---------------- loupe ----------------
const cache = new Map();   // id -> {w,h,base:ImageData}
async function preview(p) {
  if (cache.has(p.id)) return cache.get(p.id);
  const bmp = await createImageBitmap(p.src);
  const s = Math.min(1, 2200 / Math.max(bmp.width, bmp.height));
  const c = new OffscreenCanvas(Math.round(bmp.width * s), Math.round(bmp.height * s));
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0, c.width, c.height); bmp.close();
  const v = { w: c.width, h: c.height, base: ctx.getImageData(0, 0, c.width, c.height) };
  cache.set(p.id, v);
  if (cache.size > 8) cache.delete(cache.keys().next().value);
  return v;
}
async function paint(canvas, p, withEdit) {
  const v = await preview(p);
  if (canvas.width !== v.w || canvas.height !== v.h) { canvas.width = v.w; canvas.height = v.h; }
  const ctx = canvas.getContext('2d');
  if (withEdit && p.edit) ctx.putImageData(applyEdit(new ImageData(new Uint8ClampedArray(v.base.data), v.w, v.h), p.edit), 0, 0);
  else ctx.putImageData(v.base, 0, 0);
}
async function paintMain(p) { await paint($('#cMain'), p, !ui.before); placeOverlay(); drawOverlay(p); }

function openLoupe() { if (ui.sel === null) return; ui.loupe = true; $('#loupe').hidden = false; $('#batchbar').hidden = true; drawLoupe(); }
function closeLoupe() { ui.loupe = false; ui.compare = false; ui.survey = false; $('#zoomView').hidden = true; $('#loupe').hidden = true; render(); }
$('#backBtn').onclick = closeLoupe;

let drawSeq = 0;
async function drawLoupe() {
  const p = photos[ui.sel]; if (!p) return closeLoupe();
  const seq = ++drawSeq;
  loupeHeader(p); drawStrip(p); inspector(p); syncToggles();
  const g = groups[p.group].map((id) => photos[id]);
  const best = g.find((q) => q.flag === 'pick' && q !== p) || [...g].sort((a, b) => b.score - a.score).find((q) => q !== p);
  const cmp = ui.compare && best && !ui.survey;
  $('#frameCmp').hidden = !cmp;
  $('#frameMain').hidden = ui.survey;
  $('#survey').hidden = !ui.survey;
  if (ui.survey) drawSurvey(p, g);
  drawKeyFaces(p);
  $('#frameMain figcaption').textContent = cmp ? `${p.name} · ${Math.round(p.score * 100)}` : '';
  await paintMain(p);
  if (cmp && seq === drawSeq) {
    await paint($('#cCmp'), best, true);
    $('#frameCmp figcaption').textContent = `${best.name} · ${Math.round(best.score * 100)} · ${FLAG_TEXT[best.flag] || ''}`;
  }
  if (ui.compare && !best) toast('This photo has no similar shots to compare with.');
  placeOverlay();
}
function loupeHeader(p) {
  const vis = visible(), i = vis.findIndex((q) => q.id === p.id);
  $('#lName').textContent = p.name;
  $('#lPos').textContent = `${i + 1} of ${vis.length} · scene ${p.scene + 1} · moment ${p.group + 1} of ${groups.length}${isHL(p) ? ' · ◆ Highlight' : ''}`;
  $$('.flagbtn').forEach((b) => b.classList.toggle('on', p.flag === b.dataset.flag));
  $('#lStars').innerHTML = [1, 2, 3, 4, 5].map((n) => `<span data-s="${n}" class="${n <= p.stars ? '' : 'off'}">★</span>`).join('');
}
$$('.flagbtn').forEach((b) => (b.onclick = () => setFlag(photos[ui.sel], b.dataset.flag)));
$('#lStars').onclick = (e) => { const s = e.target.dataset.s; if (s) setStars(photos[ui.sel], +s); };
// Survey: every frame of the moment side by side, like laying prints on a table.
function drawSurvey(p, g) {
  $('#survey').style.setProperty('--n', g.length <= 4 ? g.length : Math.ceil(Math.sqrt(g.length * 1.5)));
  $('#survey').innerHTML = g.map((q) => `<figure data-id="${q.id}" class="${q.id === p.id ? 'on' : ''} ${q.flag || ''}">
      <img src="${q.thumbUrl}" alt=""><figcaption><span class="sflag">${FLAG_TEXT[q.flag] || ''}</span><b>${Math.round(q.score * 100)}</b>
      <button data-sf="pick" title="Pick">✓</button><button data-sf="reject" title="Reject">✕</button></figcaption></figure>`).join('');
}
$('#survey').onclick = (e) => {
  const f = e.target.closest('figure[data-id]'); if (!f) return;
  const q = photos[+f.dataset.id], b = e.target.closest('button[data-sf]');
  ui.sel = q.id; ui.multi = new Set([q.id]);
  if (b) setFlag(q, b.dataset.sf);
  drawLoupe();
};

// Key Faces: full-resolution crops of every face, for checking focus on the eyes without zooming.
let fullBmp = { id: -1, bmp: null };
async function fullRes(p) {
  if (fullBmp.id === p.id) return fullBmp.bmp;
  fullBmp.bmp?.close?.();
  fullBmp = { id: p.id, bmp: await createImageBitmap(p.src) };
  return fullBmp.bmp;
}
async function drawKeyFaces(p) {
  const box = $('#keyFaces');
  const faces = p.an.faces;
  if (!faces.length) { box.innerHTML = `<p class="fine">${faceStatus() === 'ready' ? 'No faces detected.' : 'Face analysis is off or unavailable.'}</p>`; return; }
  box.innerHTML = faces.map((f, i) => `<button class="kf ${f.closed ? 'bad' : ''}" data-i="${i}" title="Click to check focus at 100%"><canvas width="132" height="132"></canvas>
    <span>${f.closed ? 'Eyes closed' : 'Eyes open'} · ${f.smile > 0.45 ? 'smiling' : f.frown > 0.35 ? 'frowning' : 'neutral'}</span></button>`).join('');
  const bmp = await fullRes(p);
  if (photos[ui.sel] !== p) return;
  faces.forEach((f, i) => {
    const c = box.querySelector(`[data-i="${i}"] canvas`); if (!c) return;
    const [x0, y0, x1, y1] = f.box, W = bmp.width, H = bmp.height;
    const s = Math.max((x1 - x0) * W, (y1 - y0) * H) * 1.15, cx = ((x0 + x1) / 2) * W, cy = ((y0 + y1) / 2) * H;
    c.getContext('2d').drawImage(bmp, cx - s / 2, cy - s / 2, s, s, 0, 0, 132, 132);
  });
}
$('#keyFaces').onclick = (e) => { const b = e.target.closest('.kf'); if (!b) return; const p = photos[ui.sel], f = p.an.faces[+b.dataset.i]; zoomAt(p, [(f.eyes[0][0] + f.eyes[1][2]) / 2, (f.eyes[0][1] + f.eyes[1][3]) / 2]); };

// 100% zoom from the original file (not the preview), centred on a point (normalised 0..1).
async function zoomAt(p, pt) {
  if (!pt) { const f = p.an.faces[0]; pt = f ? [(f.box[0] + f.box[2]) / 2, (f.box[1] + f.box[3]) / 2] : [0.5, 0.5]; }
  const zv = $('#zoomView'), c = $('#cZoom'), bmp = await fullRes(p);
  zv.hidden = false;
  const r = zv.getBoundingClientRect();
  c.width = Math.min(bmp.width, Math.round(r.width)); c.height = Math.min(bmp.height, Math.round(r.height));
  const sx = Math.max(0, Math.min(bmp.width - c.width, pt[0] * bmp.width - c.width / 2));
  const sy = Math.max(0, Math.min(bmp.height - c.height, pt[1] * bmp.height - c.height / 2));
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, sx, sy, c.width, c.height, 0, 0, c.width, c.height);
  if (p.edit) ctx.putImageData(applyEdit(ctx.getImageData(0, 0, c.width, c.height), p.edit), 0, 0);
  $('#zoomInfo').textContent = `100% · ${p.name} · click or Esc to close`;
}
$('#zoomView').onclick = () => ($('#zoomView').hidden = true);
$('#cMain').onclick = (e) => {
  const r = e.target.getBoundingClientRect();
  zoomAt(photos[ui.sel], [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height]);
};

function syncToggles() {
  $('#togSurvey').classList.toggle('on', ui.survey);
  $('#togFaces').classList.toggle('on', ui.faces);
  $('#togCompare').classList.toggle('on', ui.compare);
  $('#togBefore').classList.toggle('on', ui.before);
}
$('#togFull').onclick = toggleFullscreen;
$('#cMain').ondblclick = toggleFullscreen;
$('#togFaces').onclick = () => { ui.faces = !ui.faces; drawOverlay(photos[ui.sel]); syncToggles(); };
$('#togCompare').onclick = () => { ui.compare = !ui.compare; drawLoupe(); };
$('#togSurvey').onclick = () => { ui.survey = !ui.survey; drawLoupe(); };
$('#togBefore').onpointerdown = () => { ui.before = true; paintMain(photos[ui.sel]); syncToggles(); };
$('#togBefore').onpointerup = $('#togBefore').onpointerleave = () => { if (ui.before) { ui.before = false; paintMain(photos[ui.sel]); syncToggles(); } };

function drawStrip(p) {
  const g = groups[p.group].map((id) => photos[id]);
  $('#strip').hidden = g.length < 2;
  $('#strip').innerHTML = g.map((q) => `<button data-id="${q.id}" class="${q.id === p.id ? 'on' : ''} ${q.flag || ''}" title="${escHtml(q.name)}"><img src="${q.thumbUrl}" alt=""><span>${q.flag === 'pick' ? '★ ' : ''}${Math.round(q.score * 100)}</span></button>`).join('');
  $('#strip .on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
$('#strip').onclick = (e) => { const b = e.target.closest('button[data-id]'); if (b) { ui.sel = +b.dataset.id; drawLoupe(); } };

// The face overlay is positioned exactly over the drawn image.
function placeOverlay() {
  const c = $('#cMain'), svg = $('#faceOverlay'), fr = $('#frameMain').getBoundingClientRect(), r = c.getBoundingClientRect();
  Object.assign(svg.style, { left: `${r.left - fr.left}px`, top: `${r.top - fr.top}px`, width: `${r.width}px`, height: `${r.height}px` });
}
addEventListener('resize', () => ui.loupe && placeOverlay());
function drawOverlay(p) {
  const svg = $('#faceOverlay');
  if (!p || !ui.faces || !p.an.faces.length) { svg.innerHTML = ''; return; }
  const ns = 'vector-effect="non-scaling-stroke" fill="none"';
  svg.innerHTML = p.an.faces.map((f) => {
    const col = f.closed ? 'var(--reject)' : 'var(--pick)';
    const [x0, y0, x1, y1] = f.box;
    const eyes = f.eyes.map(([a, b, c, d]) => `<rect x="${a}" y="${b}" width="${c - a}" height="${Math.max(d - b, 0.004)}" stroke="${col}" stroke-width="2" ${ns}/>`).join('');
    return `<rect x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}" stroke="${col}" stroke-opacity=".6" stroke-width="1.5" stroke-dasharray="5 4" ${ns}/>${eyes}`;
  }).join('');
}

// ---------------- inspector ----------------
function setTab(t) {
  ui.tab = t;
  $$('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
  $('#tabAnalysis').hidden = t !== 'analysis'; $('#tabEdit').hidden = t !== 'edit';
}
$$('.tabs button').forEach((b) => (b.onclick = () => setTab(b.dataset.tab)));

const PART_LABEL = { people: 'People in frame', sharp: 'Focus', aesthetic: 'Composition & appeal', eyes: 'Eyes open', exposure: 'Exposure', expression: 'Expression' };
const meterColor = (v) => (v >= 0.66 ? 'var(--pick)' : v >= 0.4 ? 'var(--dupe)' : 'var(--reject)');
function inspector(p, keepSliders) {
  const g = groups[p.group];
  $('#vScore').innerHTML = `${Math.round(p.score * 100)}<small>/100</small>`;
  $('#ringVal').style.strokeDashoffset = 106.8 * (1 - p.score);
  $('#ringVal').style.stroke = meterColor(p.score);
  const verdict = p.flag === 'pick' ? (g.length > 1 ? `Best of ${g.length} similar shots` : 'Keeper')
    : p.flag === 'dupe' ? `#${p.rankInGroup + 1} of ${g.length} similar shots`
    : p.flag === 'reject' ? 'Rejected' : 'Not flagged';
  $('#vText').textContent = verdict + (p.userFlag !== undefined ? ' · your call' : '');
  $('#reviewNote').hidden = !p.reviewNote;
  $('#reviewNote').textContent = p.reviewNote ? `AI reviewer chose this frame: ${p.reviewNote}` : '';
  $('#issues').innerHTML = p.issues.length ? p.issues.map((i) => `<span class="chip">${i.t}</span>`).join('') : '<span class="chip ok">No technical problems</span>';
  $('#parts').innerHTML = Object.keys(PART_LABEL).map((k) => {
    const v = p.parts[k];
    const w = Math.round(WEIGHTS[k] * 100);
    if (v === null || v === undefined) return `<div class="na"><dt>${PART_LABEL[k]}</dt><dd>${k === 'aesthetic' ? 'model off' : 'no faces'}</dd><div class="meter"></div></div>`;
    return `<div title="${w}% of the overall score"><dt>${PART_LABEL[k]}</dt><dd>${Math.round(v * 100)}</dd><div class="meter"><i style="width:${v * 100}%;background:${meterColor(v)}"></i></div></div>`;
  }).join('');
  drawHist(p.an.hist);
  const t = new Date(p.time);
  $('#fileInfo').innerHTML = [['Size', `${p.an.w} × ${p.an.h}`], ['Type', p.raw ? `RAW · ${p.name.split('.').pop().toUpperCase()}` : (p.file.type.replace('image/', '') || 'image').toUpperCase()],
    ['Captured', isNaN(t) ? '—' : t.toLocaleString()], ['File size', `${(p.file.size / 1048576).toFixed(1)} MB`]].map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
  if (!keepSliders) sliders(p);
}
function drawHist(h) {
  const c = $('#hist'), ctx = c.getContext('2d'), W = c.width, H = c.height, mx = Math.max(...h) || 1;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--muted');
  ctx.globalAlpha = 0.6;
  ctx.beginPath(); ctx.moveTo(0, H);
  h.forEach((v, i) => ctx.lineTo((i / (h.length - 1)) * W, H - Math.sqrt(v / mx) * (H - 4)));
  ctx.lineTo(W, H); ctx.closePath(); ctx.fill(); ctx.globalAlpha = 1;
}

// ---------------- editing ----------------
const fmtVal = (s, v) => (s.fmt || ((x) => (x > 0 ? '+' : '') + Math.round(x * 100)))(v);
$('#looks').innerHTML = Object.entries(LOOKS).map(([k, l]) => `<button data-look="${k}" class="look" title="${l.hint}"><i style="background:${l.swatch}"></i>${l.label}</button>`).join('');
$('#looks').onclick = (e) => { const b = e.target.closest('[data-look]'); if (b) lookTo(b.dataset.look); };
$('#copyBtn').onclick = copyEdit;
$('#pasteBtn').onclick = pasteEdit;
function sliders(p) {
  const e = p.edit || ZERO();
  $('#sliders').innerHTML = SLIDERS.map((s) => `<div class="slider ${e[s.k] ? 'changed' : ''}"><label for="sl-${s.k}">${s.label}<output data-k="${s.k}" title="Double-click to reset">${fmtVal(s, e[s.k])}</output></label>
      <input id="sl-${s.k}" type="range" data-k="${s.k}" min="${s.min}" max="${s.max}" step="${s.step}" value="${e[s.k]}"></div>`).join('');
  $('#editNote').textContent = p.manual ? 'Hand-edited. CullCraft learns your style from this photo.'
    : p.edit ? 'Auto-edited. Adjust any slider and CullCraft will learn from it.' : 'Hold \\ (or the Original button) to compare with the unedited photo.';
}
let paintRaf, learnT;
$('#sliders').addEventListener('input', (e) => {
  const p = photos[ui.sel], k = e.target.dataset.k; if (!p || !k) return;
  p.edit = p.edit || ZERO(); p.edit[k] = +e.target.value; p.manual = true;
  e.target.parentElement.querySelector('output').textContent = fmtVal(SLIDERS.find((x) => x.k === k), p.edit[k]);
  e.target.parentElement.classList.toggle('changed', p.edit[k] !== 0);
  cancelAnimationFrame(paintRaf); paintRaf = requestAnimationFrame(() => paint($('#cMain'), p, true));
  clearTimeout(learnT); learnT = setTimeout(() => { remember(p); learnFrom(p); updateCounts(); $('#editNote').textContent = 'Hand-edited. CullCraft learns your style from this photo.'; }, 600);
});
$('#sliders').addEventListener('dblclick', (e) => {
  const k = e.target.dataset.k, p = photos[ui.sel]; if (!k || !p?.edit) return;
  p.edit[k] = 0; remember(p); sliders(p); paint($('#cMain'), p, true);
});
$('#autoBtn').onclick = () => { const p = photos[ui.sel]; p.edit = autoParams(p.an); p.manual = false; remember(p); sliders(p); paintMain(p); };
$('#styleBtn').onclick = () => {
  const p = photos[ui.sel]; p.edit = styled(p.an); p.manual = false; remember(p); sliders(p); paintMain(p);
  if (!styleInfo()) toast('No style learned yet, so this is plain auto-correction. Edit a photo by hand first.');
};
$('#resetBtn').onclick = () => { const p = photos[ui.sel]; p.edit = null; p.manual = false; remember(p); sliders(p); paintMain(p); };

// ---------------- export ----------------
$('#exportBtn').onclick = (e) => {
  e.stopPropagation();
  $('#exportMenu').hidden = !$('#exportMenu').hidden;
  $('#exportMenu [data-x=folder]').disabled = !canWriteFolder();
};
addEventListener('click', (e) => { if (!e.target.closest('.menu-wrap')) $('#exportMenu').hidden = true; });
$('#exportMenu').onclick = async (e) => {
  const b = e.target.closest('button[data-x]'); if (!b) return;
  $('#exportMenu').hidden = true;
  try {
    if (b.dataset.x === 'csv') download(new Blob([csvReport(photos)], { type: 'text/csv' }), 'cullcraft-report.csv');
    else if (b.dataset.x === 'folder') {
      const n = await writeSidecars(photos);
      toast(`Wrote ${n} .xmp sidecars. In Lightroom select the photos, then Metadata → Read Metadata from Files.`);
    } else {
      const full = b.dataset.x === 'zip';
      const blob = await exportZip(photos, { includeFiles: full, onProgress: (i, n) => progress(full ? 'Exporting picks' : 'Writing sidecars', '', i / n) });
      hideProgress();
      download(blob, full ? 'cullcraft-picks.zip' : 'cullcraft-sidecars.zip');
      toast(full ? `Exported ${countOf('pick')} picks with Lightroom sidecars.` : 'Sidecars exported. Put the .xmp files next to your originals.');
    }
  } catch (err) {
    hideProgress();
    if (err.name !== 'AbortError') toast(`Export failed: ${err.message}`);
  }
};

// ---------------- progress & toast ----------------
function progress(label, detail, f) {
  $('#progress').hidden = false;
  $('#pLabel').textContent = label; $('#pDetail').textContent = detail;
  $('#pBar').style.width = `${Math.round(f * 100)}%`;
}
function hideProgress() { $('#progress').hidden = true; }
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.h); toast.h = setTimeout(() => (t.hidden = true), 5000);
}
onSave((ok) => {
  const el = $('#saveState');
  el.textContent = ok ? 'All changes saved' : 'Could not save: browser storage is full or blocked';
  el.className = `save ${ok ? 'ok' : 'bad'}`;
});
updateCounts();
