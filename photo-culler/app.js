// CullCraft — local AI photo culling + learned auto-editing.
import { isRaw, rawToJpeg } from './raw.js';
const $ = (s) => document.querySelector(s);
const photos = [];      // {id,file,url,name,time,w,h,an:{...},flag,stars,group,edit,manual}
let groups = [];        // arrays of photo ids
let filter = 'all', sel = 0, inLoupe = false, comparing = false;
let faceLandmarker = null;

const SLIDERS = [
  { k: 'exposure',   label: 'Exposure',   min: -3,  max: 3,   step: 0.05 },
  { k: 'contrast',   label: 'Contrast',   min: -1,  max: 1,   step: 0.01 },
  { k: 'temp',       label: 'Temperature',min: -1,  max: 1,   step: 0.01 },
  { k: 'tint',       label: 'Tint',       min: -1,  max: 1,   step: 0.01 },
  { k: 'highlights', label: 'Highlights', min: -1,  max: 1,   step: 0.01 },
  { k: 'shadows',    label: 'Shadows',    min: -1,  max: 1,   step: 0.01 },
  { k: 'saturation', label: 'Saturation', min: -1,  max: 1,   step: 0.01 },
];
const ZERO = () => Object.fromEntries(SLIDERS.map((s) => [s.k, 0]));

// ---------------- loading & analysis ----------------
$('#fileInput').onchange = (e) => load(e.target.files);
$('#folderInput').onchange = (e) => load(e.target.files);
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', async (e) => {
  e.preventDefault();
  // Dropped folders arrive as directory entries, not files: walk them recursively.
  const entries = [...e.dataTransfer.items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.some((en) => en.isDirectory)) return load(e.dataTransfer.files);
  const out = [];
  const walk = async (en) => {
    if (en.isFile) out.push(await new Promise((res, rej) => en.file(res, rej)));
    else if (en.isDirectory) {
      const reader = en.createReader();
      for (;;) {
        const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const b of batch) await walk(b);
      }
    }
  };
  for (const en of entries) await walk(en);
  load(out);
});

async function load(fileList) {
  const files = [...fileList].filter((f) => /image\/(jpeg|png|webp)/.test(f.type) || /\.(jpe?g|png|webp)$/i.test(f.name) || isRaw(f));
  if (!files.length) return toast('No supported photos found. Use JPEG, PNG, WebP or RAW (ARW, NEF, CR2, DNG…).');
  photos.length = 0;
  const useFaces = $('#faceToggle').checked;
  if (useFaces && !faceLandmarker) await initFaces();
  showProgress(0, files.length, 'Analysing');
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    try {
      let src = f, rawTime = null;
      if (isRaw(f)) ({ blob: src, time: rawTime } = await rawToJpeg(f));
      const p = { id: i, file: f, src, raw: isRaw(f), name: f.name, url: URL.createObjectURL(src), flag: null, stars: 0, edit: null, manual: false };
      p.an = await analyse(src, useFaces);
      p.time = rawTime ?? p.an.exifTime ?? f.lastModified;
      photos.push(p);
    } catch (err) { console.warn('skip', f.name, err); }
    showProgress(i + 1, files.length, 'Analysing');
  }
  photos.sort((a, b) => a.time - b.time || a.name.localeCompare(b.name));
  photos.forEach((p, i) => (p.id = i));
  cull();
  hideProgress();
  sel = 0;
  $('#exportBtn').disabled = $('#applyStyle').disabled = false;
  render();
}

async function initFaces() {
  try {
    showProgress(0, 1, 'Loading eye-detection model');
    const v = await import('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs');
    const fs = await v.FilesetResolver.forVisionTasks('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm');
    faceLandmarker = await v.FaceLandmarker.createFromOptions(fs, {
      baseOptions: { modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task' },
      runningMode: 'IMAGE', numFaces: 6, outputFaceBlendshapes: true,
    });
  } catch (e) {
    console.warn('Face model unavailable', e);
    $('#faceToggle').checked = false;
  }
}

async function analyse(file, useFaces) {
  const full = await createImageBitmap(file);
  const W = full.width, H = full.height;
  const scale = Math.min(1, 640 / Math.max(W, H));
  const w = Math.round(W * scale), h = Math.round(H * scale);
  const c = new OffscreenCanvas(w, h), ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(full, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  const n = w * h, g = new Float32Array(n);
  let sr = 0, sg = 0, sb = 0, sl = 0, hi = 0, lo = 0;
  for (let i = 0, j = 0; j < n; i += 4, j++) {
    const r = d[i], gr = d[i + 1], b = d[i + 2];
    const l = 0.299 * r + 0.587 * gr + 0.114 * b;
    g[j] = l; sr += r; sg += gr; sb += b; sl += l;
    if (l > 250) hi++; else if (l < 5) lo++;
  }
  // Sharpness: variance of Laplacian; also take the max over a 4x4 tile grid so a
  // sharp subject on a blurred background still scores as sharp.
  const T = 4, tv = new Float64Array(T * T * 3);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const k = y * w + x;
    const lap = 4 * g[k] - g[k - 1] - g[k + 1] - g[k - w] - g[k + w];
    const t = (Math.floor((y * T) / h) * T + Math.floor((x * T) / w)) * 3;
    tv[t] += lap; tv[t + 1] += lap * lap; tv[t + 2]++;
  }
  let totS = 0, totS2 = 0, totN = 0, tileMax = 0;
  for (let t = 0; t < tv.length; t += 3) {
    totS += tv[t]; totS2 += tv[t + 1]; totN += tv[t + 2];
    const m = tv[t] / tv[t + 2]; tileMax = Math.max(tileMax, tv[t + 1] / tv[t + 2] - m * m);
  }
  const m = totS / totN, globalVar = totS2 / totN - m * m;
  const sharp = Math.sqrt(0.4 * globalVar + 0.6 * tileMax);

  // dHash (9x8)
  const hc = new OffscreenCanvas(9, 8), hctx = hc.getContext('2d', { willReadFrequently: true });
  hctx.drawImage(full, 0, 0, 9, 8);
  const hd = hctx.getImageData(0, 0, 9, 8).data, bits = [];
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    const a = (y * 9 + x) * 4, b = a + 4;
    bits.push(hd[a] + hd[a + 1] + hd[a + 2] < hd[b] + hd[b + 1] + hd[b + 2] ? 1 : 0);
  }

  // Faces / eyes
  let faces = 0, closed = 0;
  if (useFaces && faceLandmarker) {
    try {
      const res = faceLandmarker.detect(c);
      faces = res.faceLandmarks.length;
      for (const bs of res.faceBlendshapes || []) {
        const get = (nm) => bs.categories.find((q) => q.categoryName === nm)?.score ?? 0;
        if ((get('eyeBlinkLeft') + get('eyeBlinkRight')) / 2 > 0.5) closed++;
      }
    } catch (e) { console.warn(e); }
  }
  full.close();
  return {
    w: W, h: H, sharp, hash: bits,
    mean: sl / n / 255, avg: [sr / n, sg / n, sb / n],
    clipHi: hi / n, clipLo: lo / n, faces, closed,
    exifTime: await exifDate(file),
  };
}

// Minimal EXIF DateTimeOriginal reader (JPEG only).
async function exifDate(file) {
  if (file.type !== 'image/jpeg') return null;
  const buf = new DataView(await file.slice(0, 128 * 1024).arrayBuffer());
  try {
    let o = 2;
    while (o < buf.byteLength - 4) {
      const marker = buf.getUint16(o), len = buf.getUint16(o + 2);
      if (marker === 0xffe1 && buf.getUint32(o + 4) === 0x45786966) {
        const t = o + 10, le = buf.getUint16(t) === 0x4949;
        const u16 = (p) => buf.getUint16(t + p, le), u32 = (p) => buf.getUint32(t + p, le);
        const readIfd = (p) => {
          const cnt = u16(p), out = {};
          for (let i = 0; i < cnt; i++) { const e = p + 2 + i * 12; out[u16(e)] = u32(e + 8); }
          return out;
        };
        const ifd0 = readIfd(u32(4));
        const exif = ifd0[0x8769] ? readIfd(ifd0[0x8769]) : {};
        const off = exif[0x9003] ?? ifd0[0x0132];
        if (!off) return null;
        let s = ''; for (let i = 0; i < 19; i++) s += String.fromCharCode(buf.getUint8(t + off + i));
        const [dt, tm] = s.split(' ');
        const ms = Date.parse(dt.replace(/:/g, '-') + 'T' + tm);
        return isNaN(ms) ? null : ms;
      }
      o += 2 + len;
    }
  } catch { /* ignore */ }
  return null;
}

// ---------------- culling ----------------
const ham = (a, b) => a.reduce((s, v, i) => s + (v !== b[i]), 0);

function cull() {
  // Relative sharpness (percentile within this shoot)
  const sorted = photos.map((p) => p.an.sharp).sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)] || 1;
  for (const p of photos) {
    const a = p.an;
    a.sharpRel = sorted.findIndex((v) => v >= a.sharp) / Math.max(1, sorted.length - 1);
    const expo = 1 - Math.min(1, Math.abs(a.mean - 0.47) * 2.2 + a.clipHi * 6 + a.clipLo * 4);
    const eyes = a.faces ? 1 - a.closed / a.faces : 0.7;
    const sharpAbs = Math.min(1, a.sharp / (med * 1.3));
    a.score = 0.45 * (0.5 * sharpAbs + 0.5 * a.sharpRel) + 0.25 * expo + 0.3 * eyes;
    a.issues = [];
    if (a.sharp < med * 0.45) a.issues.push('blurry');
    if (a.faces && a.closed) a.issues.push(`${a.closed}/${a.faces} eyes closed`);
    if (a.clipHi > 0.12) a.issues.push('blown highlights');
    if (a.mean < 0.12) a.issues.push('too dark');
    p.stars = Math.max(1, Math.min(5, Math.round(a.score * 5)));
  }
  // Group: consecutive similar frames
  groups = [];
  let cur = [];
  photos.forEach((p, i) => {
    const prev = photos[i - 1];
    const similar = prev && (ham(p.an.hash, prev.an.hash) <= 10 ||
      (Math.abs(p.time - prev.time) < 3000 && ham(p.an.hash, prev.an.hash) <= 20));
    if (!similar && cur.length) { groups.push(cur); cur = []; }
    cur.push(p.id);
  });
  if (cur.length) groups.push(cur);
  groups.forEach((g, gi) => {
    g.forEach((id) => (photos[id].group = gi));
    const best = g.map((id) => photos[id]).sort((a, b) => b.an.score - a.an.score)[0];
    for (const id of g) {
      const p = photos[id];
      if (p.an.issues.some((s) => s === 'blurry' || s.includes('eyes'))) p.flag = 'reject';
      else if (p === best) p.flag = 'pick';
      else p.flag = 'dupe';
    }
    // Never leave a group with no pick if something is usable
    if (!g.some((id) => photos[id].flag === 'pick') && best.an.issues.length === 0) best.flag = 'pick';
  });
}

// ---------------- grid UI ----------------
const visible = () => photos.filter((p) => filter === 'all' || (filter === 'none' ? !p.flag : p.flag === filter));
const starStr = (n) => '★'.repeat(n) + '☆'.repeat(5 - n);

function render() {
  const counts = { all: photos.length, pick: 0, reject: 0, dupe: 0, none: 0 };
  photos.forEach((p) => counts[p.flag || 'none']++);
  document.querySelectorAll('#filters button').forEach((b) => {
    b.classList.toggle('active', b.dataset.f === filter);
    b.querySelector('span').textContent = counts[b.dataset.f];
  });
  const vis = visible();
  sel = Math.min(sel, Math.max(0, vis.length - 1));
  const grid = $('#grid');
  if (!photos.length) return;
  grid.innerHTML = '';
  let lastG = -1, cards;
  vis.forEach((p, i) => {
    if (p.group !== lastG) {
      lastG = p.group;
      const size = groups[p.group].length;
      const g = document.createElement('div'); g.className = 'group';
      g.innerHTML = `<h4>${size > 1 ? `Stack of ${size} similar` : 'Single'}</h4><div class="cards"></div>`;
      grid.appendChild(g); cards = g.lastChild;
    }
    const c = document.createElement('div');
    c.className = `card ${p.flag || ''} ${i === sel ? 'sel' : ''}`;
    const badges = [p.flag ? `<span class="badge ${p.flag}">${p.flag === 'dupe' ? 'duplicate' : p.flag}</span>` : '',
      ...p.an.issues.map((s) => `<span class="badge">${s}</span>`), p.manual ? '<span class="badge">edited</span>' : ''].join('');
    c.innerHTML = `<img loading="lazy" src="${p.url}"><div class="badges">${badges}</div>
      <div class="info"><span class="stars">${starStr(p.stars)}</span><span>${p.name}</span></div>`;
    c.onclick = () => { sel = i; render(); };
    c.ondblclick = () => { sel = i; openLoupe(); };
    cards.appendChild(c);
  });
  grid.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
}

document.querySelectorAll('#filters button').forEach((b) => (b.onclick = () => { filter = b.dataset.f; sel = 0; render(); }));

document.addEventListener('keydown', (e) => {
  if (e.target.type === 'range' || e.target.type === 'text') return;
  const vis = visible(), p = vis[sel];
  if (!p) return;
  const k = e.key.toLowerCase();
  const move = (d) => { sel = Math.max(0, Math.min(vis.length - 1, sel + d)); };
  if (k === 'arrowright') move(1);
  else if (k === 'arrowleft') move(-1);
  else if (k === 'arrowdown' && !inLoupe) move(colCount());
  else if (k === 'arrowup' && !inLoupe) move(-colCount());
  else if (k === 'p') { p.flag = 'pick'; if (!inLoupe && filter === 'all') move(1); }
  else if (k === 'x') { p.flag = 'reject'; if (!inLoupe && filter === 'all') move(1); }
  else if (k === 'u') p.flag = null;
  else if (k >= '1' && k <= '5') p.stars = +k;
  else if (k === 'enter' || k === ' ') { e.preventDefault(); inLoupe ? closeLoupe() : openLoupe(); return; }
  else if (k === 'escape') { closeLoupe(); return; }
  else if (k === 'c') { comparing = !comparing; if (!inLoupe) openLoupe(); else drawLoupe(); return; }
  else return;
  e.preventDefault();
  render();
  if (inLoupe) drawLoupe();
});
function colCount() {
  const c = document.querySelector('.cards');
  return c ? getComputedStyle(c).gridTemplateColumns.split(' ').length : 1;
}

// ---------------- editing ----------------
function autoParams(a) {
  const [r, g, b] = a.avg, m = (r + g + b) / 3 || 1;
  return {
    ...ZERO(),
    exposure: clamp(Math.log2(0.46 / Math.max(0.02, a.mean)) * 0.8, -2, 2),
    temp: clamp((b - r) / m * 0.8, -0.6, 0.6),          // gray-world white balance
    tint: clamp(((r + b) / 2 - g) / m * 0.8, -0.5, 0.5),
    highlights: a.clipHi > 0.02 ? -clamp(a.clipHi * 6, 0, 0.6) : 0,
    shadows: a.clipLo > 0.03 ? clamp(a.clipLo * 5, 0, 0.5) : 0,
    contrast: 0.1, saturation: 0.05,
  };
}
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Learned style = average (manual - auto) over photos you edited by hand.
function learnedStyle() {
  const ed = photos.filter((p) => p.manual && p.edit);
  if (!ed.length) return null;
  const s = ZERO();
  for (const p of ed) { const a = autoParams(p.an); for (const k in s) s[k] += (p.edit[k] - a[k]) / ed.length; }
  return { style: s, n: ed.length };
}
function styledParams(p) {
  const a = autoParams(p.an), L = learnedStyle();
  if (L) for (const k in a) a[k] += L.style[k];
  return a;
}

function applyEdit(imgData, e) {
  const d = imgData.data;
  const gain = 2 ** e.exposure;
  const wb = [1 + e.temp * 0.25 - e.tint * 0.1, 1 + e.tint * 0.2, 1 - e.temp * 0.25 - e.tint * 0.1];
  const luts = wb.map((w) => {
    const lut = new Uint8ClampedArray(256);
    for (let i = 0; i < 256; i++) {
      let v = Math.pow(i / 255, 2.2) * gain * w;           // linear light
      v = Math.pow(Math.max(0, v), 1 / 2.2);               // back to display
      if (v > 0.5) v = 0.5 + (v - 0.5) * (1 + e.highlights * 0.8 * (v - 0.5) * 2); // highlights
      else v = v + e.shadows * 0.5 * v * (1 - v * 2) * 2;  // shadows
      v = 0.5 + (v - 0.5) * (1 + e.contrast);              // contrast
      lut[i] = v * 255;
    }
    return lut;
  });
  const sat = 1 + e.saturation;
  for (let i = 0; i < d.length; i += 4) {
    let r = luts[0][d[i]], g = luts[1][d[i + 1]], b = luts[2][d[i + 2]];
    if (sat !== 1) { const l = 0.299 * r + 0.587 * g + 0.114 * b; r = l + (r - l) * sat; g = l + (g - l) * sat; b = l + (b - l) * sat; }
    d[i] = r; d[i + 1] = g; d[i + 2] = b;
  }
  return imgData;
}

async function renderTo(canvas, p, maxDim) {
  const bmp = await createImageBitmap(p.src);
  const s = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
  canvas.width = Math.round(bmp.width * s); canvas.height = Math.round(bmp.height * s);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  if (p.edit) ctx.putImageData(applyEdit(ctx.getImageData(0, 0, canvas.width, canvas.height), p.edit), 0, 0);
}

// ---------------- loupe ----------------
function openLoupe() { if (!visible().length) return; inLoupe = true; $('#loupe').hidden = false; drawLoupe(); }
function closeLoupe() { inLoupe = false; comparing = false; $('#loupe').hidden = true; render(); }

let drawToken = 0;
async function drawLoupe() {
  const tok = ++drawToken, p = visible()[sel];
  if (!p) return closeLoupe();
  const a = p.an;
  $('#meta').innerHTML = [
    ['File', p.name], ['Flag', p.flag || '—'], ['Rating', `<span class="stars">${starStr(p.stars)}</span>`],
    ['AI score', (a.score * 100).toFixed(0)], ['Sharpness', `${(a.sharpRel * 100).toFixed(0)}th pct`],
    ['Faces', a.faces ? `${a.faces} (${a.closed} closed)` : '—'], ['Issues', a.issues.join(', ') || 'none'],
    ['Size', `${a.w}×${a.h}`],
  ].map(([k, v]) => `<div><span>${k}</span><span>${v}</span></div>`).join('');
  buildSliders(p);
  const L = learnedStyle();
  $('#styleInfo').textContent = L ? `Learned style from ${L.n} hand-edited photo(s). “Auto-edit picks” applies it.`
    : 'Edit a few photos by hand — CullCraft learns your style and applies it to the rest.';
  await renderTo($('#mainCanvas'), p, 1800);
  const cmp = $('#compareCanvas');
  const g = groups[p.group], other = g.find((id) => id !== p.id);
  cmp.hidden = !(comparing && other !== undefined);
  if (!cmp.hidden && tok === drawToken) await renderTo(cmp, photos[other], 1800);
}

function buildSliders(p) {
  const e = p.edit || ZERO();
  $('#sliders').innerHTML = SLIDERS.map((s) => `<div class="slider"><label>${s.label}<span>${e[s.k].toFixed(2)}</span></label>
    <input type="range" data-k="${s.k}" min="${s.min}" max="${s.max}" step="${s.step}" value="${e[s.k]}"></div>`).join('');
  let pending;
  $('#sliders').querySelectorAll('input').forEach((inp) => (inp.oninput = () => {
    p.edit = p.edit || ZERO(); p.edit[inp.dataset.k] = +inp.value; p.manual = true;
    inp.previousElementSibling.lastChild.textContent = (+inp.value).toFixed(2);
    clearTimeout(pending); pending = setTimeout(() => renderTo($('#mainCanvas'), p, 1800), 60);
  }));
}
$('#autoBtn').onclick = () => { const p = visible()[sel]; p.edit = styledParams(p); p.manual = false; drawLoupe(); };
$('#resetBtn').onclick = () => { const p = visible()[sel]; p.edit = null; p.manual = false; drawLoupe(); };

$('#applyStyle').onclick = () => {
  let n = 0;
  for (const p of photos) if (p.flag === 'pick' && !p.manual) { p.edit = styledParams(p); n++; }
  toast(`Auto-edited ${n} pick(s)${learnedStyle() ? ' using your learned style' : ''}.`);
  if (inLoupe) drawLoupe();
};

// ---------------- export ----------------
$('#exportBtn').onclick = async () => {
  const picks = photos.filter((p) => p.flag === 'pick');
  if (!picks.length) return toast('No picks to export.');
  const zip = new JSZip(), c = document.createElement('canvas');
  const csv = ['file,flag,stars,score,issues'];
  for (const p of photos) csv.push(`"${p.name}",${p.flag || ''},${p.stars},${p.an.score.toFixed(3)},"${p.an.issues.join('; ')}"`);
  zip.file('culling-report.csv', csv.join('\n'));
  for (let i = 0; i < picks.length; i++) {
    showProgress(i, picks.length, 'Exporting');
    const p = picks[i];
    if (p.edit) {
      await renderTo(c, p, 100000);
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.95));
      zip.file(p.name.replace(/\.\w+$/, '') + '_edit.jpg', blob);
    } else zip.file(p.name, p.file);
  }
  showProgress(picks.length, picks.length, 'Zipping');
  const out = await zip.generateAsync({ type: 'blob' });
  hideProgress();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(out); a.download = 'cullcraft-picks.zip'; a.click();
};

// ---------------- progress ----------------
function showProgress(i, n, label) {
  $('#progress').hidden = false;
  $('#progress .bar').style.width = `${(i / n) * 100}%`;
  $('#progress .label').textContent = `${label} ${i}/${n}`;
}
function hideProgress() { $('#progress').hidden = true; }

// In-page message (browser alert() dialogs are blocked in some embeds).
function toast(msg) {
  let t = document.getElementById('toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); }
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.h); toast.h = setTimeout(() => (t.hidden = true), 4000);
}
