// CullCraft — local AI photo culling and learned auto-editing.
import { isRaw, rawToJpeg } from './raw.js';
import { analyse, exifDate, initFaces, faceStatus } from './analyze.js';
import { initClip, clipAnalyse, clipStatus } from './ai.js';
import { cull, WEIGHTS } from './cull.js';
import { SLIDERS, ZERO, autoParams, styled, learnFrom, styleInfo, resetStyle, applyEdit } from './edit.js';
import { exportZip, csvReport, writeSidecars, canWriteFolder, download } from './export.js';
import { sampleShoot } from './sample.js';
import { recordDecision, learnedWeights, decisionCount, forgetDecisions } from './learn.js';
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
const ui = { filter: 'all', reason: null, sel: null, loupe: false, compare: false, faces: true, before: false, tab: 'analysis' };

const SETTINGS_KEY = 'cullcraft.settings.v1';
const settings = Object.assign(
  { strictness: 0.5, similarity: 0.5, collapse: false, thumb: 200, faces: true, scene: true },
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
  groups = cull(photos, settings, learnedWeights());
  ui.sel = visible()[0]?.id ?? null;
  render();
  const skipped = files.length - photos.length;
  toast(`Culled ${photos.length} photos into ${groups.length} moments: ${countOf('pick')} picks.${skipped ? ` ${skipped} file(s) couldn't be read.` : ''}`);
}
const fmtDur = (s) => (s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`);

function recull() {
  if (!photos.length || analysing) return;
  groups = cull(photos, settings, learnedWeights());
  render();
  if (ui.loupe) drawLoupe();
}

// ---------------- grid ----------------
const countOf = (f) => photos.filter((p) => p.flag === f).length;
function visible() {
  let list = photos;
  if (ui.filter !== 'all') list = list.filter((p) => p.flag === ui.filter);
  if (ui.reason) list = list.filter((p) => p.issues.some((i) => i.k === ui.reason));
  if (settings.collapse && ui.filter === 'all' && !ui.reason) {
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
  const cls = ['card', p.flag || '', p.id === ui.sel ? 'sel' : '', p.userFlag !== undefined ? 'user' : ''].join(' ');
  const why = p.flag === 'reject' ? p.issues.filter((i) => i.hard).map((i) => `<span>${i.t}</span>`).join('') : '';
  return `<div class="${cls}" data-id="${p.id}">
    <div class="ph" style="background-image:url('${p.thumbUrl}')"></div>
    ${p.flag ? `<span class="flag">${FLAG_TEXT[p.flag]}</span>` : ''}
    <span class="best" title="AI score out of 100">${Math.round(p.score * 100)}</span>
    <div class="why">${why}</div>
    <div class="meta"><span class="stars">${starHtml(p.stars)}</span>${g.length > 1 ? `<span title="Rank in stack">#${p.rankInGroup + 1}/${g.length}</span>` : ''}<span class="nm">${escHtml(p.name)}</span></div>
  </div>`;
}

function render() {
  updateCounts();
  const grid = $('#grid');
  if (!photos.length) { grid.innerHTML = ''; return; }
  const vis = visible();
  if (!vis.some((p) => p.id === ui.sel)) ui.sel = vis[0]?.id ?? null;
  let html = '', lastG = -1, open = false;
  const byStack = ui.filter === 'all' && !ui.reason && !settings.collapse;
  if (!byStack) html += '<div class="cards">';
  for (const p of vis) {
    if (byStack && p.group !== lastG) {
      if (open) html += '</div></div>';
      lastG = p.group;
      const g = groups[p.group];
      const t = new Date(photos[g[0]].time);
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
function renderPending() {
  $('#grid').innerHTML = `<div class="cards">${photos.map((p) => `<div class="card pending"><div class="ph" style="background-image:url('${p.thumbUrl}')"></div><div class="meta"><span class="nm">${escHtml(p.name)}</span></div></div>`).join('')}</div>`;
}
function refreshCard(p) {
  const el = $(`.card[data-id="${p.id}"]`);
  if (el) el.outerHTML = cardHtml(p);
  updateCounts();
}
function scrollSel() { $(`.card[data-id="${ui.sel}"]`)?.scrollIntoView({ block: 'nearest' }); }
function select(id) {
  const prev = ui.sel; ui.sel = id;
  $(`.card[data-id="${prev}"]`)?.classList.remove('sel');
  $(`.card[data-id="${id}"]`)?.classList.add('sel');
  scrollSel();
}
$('#grid').addEventListener('click', (e) => { const c = e.target.closest('.card[data-id]'); if (c) select(+c.dataset.id); });
$('#grid').addEventListener('dblclick', (e) => { const c = e.target.closest('.card[data-id]'); if (c) { select(+c.dataset.id); openLoupe(); } });

function updateCounts() {
  const n = photos.length, c = { pick: countOf('pick'), dupe: countOf('dupe'), reject: countOf('reject') };
  $$('#filters button').forEach((b) => {
    b.classList.toggle('on', b.dataset.f === ui.filter);
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
  $('#reasons').innerHTML = keys.length
    ? keys.sort((a, b) => reasons[b].n - reasons[a].n).map((k) => `<li data-r="${k}" class="${ui.reason === k ? 'on' : ''}">${reasons[k].t}<b>${reasons[k].n}</b></li>`).join('')
    : `<li class="muted">${n ? 'No problems found' : 'Nothing yet'}</li>`;
  const nd = decisionCount(), lw = learnedWeights();
  $('#learnText').textContent = lw
    ? `Scoring is tuned to ${nd} of your decisions. Focus ${pct(lw.sharp)}, composition ${pct(lw.aesthetic)}, eyes ${pct(lw.eyes)}, exposure ${pct(lw.exposure)}, expression ${pct(lw.expression)}.`
    : `Override a few picks and rejects (${nd} so far, at least 3 of each needed) and CullCraft re-weights its scoring to match your taste.`;
  $('#reviewBtn').disabled = !photos.length || analysing;
  const ns = styleInfo();
  $('#styleText').textContent = ns
    ? `Learned from ${ns} photo${ns > 1 ? 's' : ''} you edited by hand. Auto-edit applies it on top of exposure and white-balance correction.`
    : 'Edit a few photos by hand and CullCraft learns your look, then applies it to every pick.';
}
$('#reasons').onclick = (e) => { const li = e.target.closest('li[data-r]'); if (!li) return; ui.reason = ui.reason === li.dataset.r ? null : li.dataset.r; ui.filter = 'all'; render(); };
$$('#filters button').forEach((b) => (b.onclick = () => { ui.filter = b.dataset.f; ui.reason = null; render(); }));

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
  for (const p of photos) if (p.flag === 'pick' && !p.manual) { p.edit = styled(p.an); n++; }
  toast(`Edited ${n} pick${n === 1 ? '' : 's'}${styleInfo() ? ' in your style' : ' with auto-correction'}.`);
  if (ui.loupe) drawLoupe();
};
$('#relearn').onclick = () => { recull(); toast(learnedWeights() ? 'Re-culled using weights learned from your decisions.' : 'Not enough decisions yet: override at least 3 picks and 3 rejects.'); };
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
      stack.forEach((p) => { p.reviewPick = p === best; p.reviewNote = p === best ? reason : null; });
      if (before !== best) changed++;
    } catch (err) { failed++; lastErr = err.message; if (/key/i.test(err.message)) break; }
    done++;
  }
  hideProgress(); btn.disabled = false;
  recull();
  toast(failed && failed === done ? `Review failed: ${lastErr}` : `Reviewed ${done - failed} close call${done - failed === 1 ? '' : 's'}; changed the pick in ${changed}.${failed ? ` ${failed} failed: ${lastErr}` : ''}`);
};

$('#resetStyle').onclick = () => { resetStyle(); updateCounts(); toast('Learned style cleared.'); };

// ---------------- flags ----------------
function setFlag(p, f) {
  p.userFlag = p.flag === f && p.userFlag !== undefined ? undefined : f;   // pressing again hands back to the AI decision
  recordDecision(p);
  afterChange(p);
}
function setStars(p, n) { p.userStars = n; afterChange(p); }
function afterChange(p) {
  if (ui.loupe) { loupeHeader(p); drawStrip(p); inspector(p, true); }
  else if (visible().some((q) => q.id === p.id)) refreshCard(p);
  else render();
  updateCounts();
}

// ---------------- keyboard ----------------
addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { if (!$('#exportMenu').hidden) $('#exportMenu').hidden = true; else if (ui.loupe) closeLoupe(); return; }
  if (e.target.matches('input[type=range], input[type=text], input[type=password]') || e.metaKey || e.ctrlKey || e.altKey) return;
  const vis = visible(), idx = vis.findIndex((p) => p.id === ui.sel), p = vis[idx];
  if (!p) return;
  const go = (d) => { const n = vis[Math.max(0, Math.min(vis.length - 1, idx + d))]; if (n && n.id !== ui.sel) { select(n.id); if (ui.loupe) drawLoupe(); } };
  switch (e.key.toLowerCase()) {
    case 'arrowright': go(1); break;
    case 'arrowleft': go(-1); break;
    case 'arrowdown': if (ui.loupe) return; go(cols()); break;
    case 'arrowup': if (ui.loupe) return; go(-cols()); break;
    case 'p': setFlag(p, 'pick'); go(1); break;
    case 'x': setFlag(p, 'reject'); go(1); break;
    case 'd': setFlag(p, 'dupe'); go(1); break;
    case 'u': p.userFlag = undefined; p.userStars = undefined; recordDecision(p); afterChange(p); break;
    case '0': case '1': case '2': case '3': case '4': case '5': setStars(p, +e.key); break;
    case 'enter': case ' ': ui.loupe ? closeLoupe() : openLoupe(); break;
    case 'c': ui.compare = !ui.compare; ui.loupe ? drawLoupe() : openLoupe(); break;
    case 'f': if (!ui.loupe) return; ui.faces = !ui.faces; drawOverlay(p); syncToggles(); break;
    case 'e': if (!ui.loupe) openLoupe(); setTab(ui.tab === 'edit' ? 'analysis' : 'edit'); break;
    case 'a': if (!ui.loupe) return; $('#autoBtn').click(); break;
    case '\\': if (ui.loupe && !ui.before) { ui.before = true; paintMain(p); syncToggles(); } break;
    default: return;
  }
  e.preventDefault();
});
addEventListener('keyup', (e) => { if (e.key === '\\' && ui.before) { ui.before = false; const p = photos[ui.sel]; if (p) paintMain(p); syncToggles(); } });
function cols() { const c = $(`.card[data-id="${ui.sel}"]`)?.parentElement || $('.cards'); return c ? getComputedStyle(c).gridTemplateColumns.split(' ').length : 1; }

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

function openLoupe() { if (ui.sel === null) return; ui.loupe = true; $('#loupe').hidden = false; drawLoupe(); }
function closeLoupe() { ui.loupe = false; ui.compare = false; $('#loupe').hidden = true; render(); }
$('#backBtn').onclick = closeLoupe;

let drawSeq = 0;
async function drawLoupe() {
  const p = photos[ui.sel]; if (!p) return closeLoupe();
  const seq = ++drawSeq;
  loupeHeader(p); drawStrip(p); inspector(p); syncToggles();
  const g = groups[p.group].map((id) => photos[id]);
  const best = g.find((q) => q.flag === 'pick' && q !== p) || [...g].sort((a, b) => b.score - a.score).find((q) => q !== p);
  const cmp = ui.compare && best;
  $('#frameCmp').hidden = !cmp;
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
  $('#lPos').textContent = `${i + 1} of ${vis.length} · moment ${p.group + 1} of ${groups.length}`;
  $$('.flagbtn').forEach((b) => b.classList.toggle('on', p.flag === b.dataset.flag));
  $('#lStars').innerHTML = [1, 2, 3, 4, 5].map((n) => `<span data-s="${n}" class="${n <= p.stars ? '' : 'off'}">★</span>`).join('');
}
$$('.flagbtn').forEach((b) => (b.onclick = () => setFlag(photos[ui.sel], b.dataset.flag)));
$('#lStars').onclick = (e) => { const s = e.target.dataset.s; if (s) setStars(photos[ui.sel], +s); };
function syncToggles() {
  $('#togFaces').classList.toggle('on', ui.faces);
  $('#togCompare').classList.toggle('on', ui.compare);
  $('#togBefore').classList.toggle('on', ui.before);
}
$('#togFaces').onclick = () => { ui.faces = !ui.faces; drawOverlay(photos[ui.sel]); syncToggles(); };
$('#togCompare').onclick = () => { ui.compare = !ui.compare; drawLoupe(); };
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

const PART_LABEL = { sharp: 'Focus', aesthetic: 'Composition & appeal', eyes: 'Eyes open', exposure: 'Exposure', expression: 'Expression' };
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
    if (v === null) return `<div class="na"><dt>${PART_LABEL[k]}</dt><dd>${k === 'aesthetic' ? 'model off' : 'no faces'}</dd><div class="meter"></div></div>`;
    return `<div title="${w}% of the overall score"><dt>${PART_LABEL[k]}</dt><dd>${Math.round(v * 100)}</dd><div class="meter"><i style="width:${v * 100}%;background:${meterColor(v)}"></i></div></div>`;
  }).join('');
  drawHist(p.an.hist);
  $('#faceList').innerHTML = p.an.faces.length
    ? p.an.faces.map((f, i) => `<div><b>${i + 1}</b><span class="${f.closed ? 'bad' : 'good'}">${f.closed ? 'Eyes closed' : 'Eyes open'}</span><span class="muted">${f.smile > 0.45 ? 'Smiling' : f.frown > 0.35 ? 'Frowning' : 'Neutral'}</span></div>`).join('')
    : `<p class="fine">${faceStatus() === 'ready' ? 'No faces detected.' : 'Face analysis is off or unavailable.'}</p>`;
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
  clearTimeout(learnT); learnT = setTimeout(() => { learnFrom(p); updateCounts(); $('#editNote').textContent = 'Hand-edited. CullCraft learns your style from this photo.'; }, 600);
});
$('#sliders').addEventListener('dblclick', (e) => {
  const k = e.target.dataset.k, p = photos[ui.sel]; if (!k || !p?.edit) return;
  p.edit[k] = 0; sliders(p); paint($('#cMain'), p, true);
});
$('#autoBtn').onclick = () => { const p = photos[ui.sel]; p.edit = autoParams(p.an); p.manual = false; sliders(p); paintMain(p); };
$('#styleBtn').onclick = () => {
  const p = photos[ui.sel]; p.edit = styled(p.an); p.manual = false; sliders(p); paintMain(p);
  if (!styleInfo()) toast('No style learned yet, so this is plain auto-correction. Edit a photo by hand first.');
};
$('#resetBtn').onclick = () => { const p = photos[ui.sel]; p.edit = null; p.manual = false; sliders(p); paintMain(p); };

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
updateCounts();
