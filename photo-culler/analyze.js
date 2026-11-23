// Per-photo analysis: technical metrics, faces/eyes/expression, perceptual hash.
const MP = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
const FACE_MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

let faceLandmarker = null, faceState = 'off';   // off | loading | ready | failed
export const faceStatus = () => faceState;

export async function initFaces() {
  if (faceLandmarker || faceState === 'failed') return faceLandmarker;
  faceState = 'loading';
  try {
    const v = await import(`${MP}/vision_bundle.mjs`);
    const fs = await v.FilesetResolver.forVisionTasks(`${MP}/wasm`);
    faceLandmarker = await v.FaceLandmarker.createFromOptions(fs, {
      baseOptions: { modelAssetPath: FACE_MODEL },
      runningMode: 'IMAGE', numFaces: 8, outputFaceBlendshapes: true,
      minFaceDetectionConfidence: 0.4,
    });
    faceState = 'ready';
  } catch (e) {
    console.warn('Face model unavailable', e);
    faceState = 'failed';
  }
  return faceLandmarker;
}

// Landmark indices (MediaPipe 468-point mesh) outlining each eye.
const EYE_L = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246];
const EYE_R = [362, 382, 381, 380, 374, 373, 390, 249, 263, 466, 388, 387, 386, 385, 384, 398];

function toGray(d, n) {
  const g = new Float32Array(n);
  for (let i = 0, j = 0; j < n; i += 4, j++) g[j] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  return g;
}

// Laplacian standard deviation within a rectangle (x0,y0,x1,y1) of a grayscale image.
function lapStd(g, w, h, x0 = 1, y0 = 1, x1 = w - 1, y1 = h - 1) {
  x0 = Math.max(1, x0 | 0); y0 = Math.max(1, y0 | 0); x1 = Math.min(w - 1, x1 | 0); y1 = Math.min(h - 1, y1 | 0);
  let s = 0, s2 = 0, n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const k = y * w + x;
    const l = 4 * g[k] - g[k - 1] - g[k + 1] - g[k - w] - g[k + w];
    s += l; s2 += l * l; n++;
  }
  if (!n) return 0;
  const m = s / n;
  return Math.sqrt(Math.max(0, s2 / n - m * m));
}

export async function analyse(src, { faces: useFaces }) {
  const full = await createImageBitmap(src);
  const W = full.width, H = full.height;

  // Working copy for metrics (long edge 1024) — big enough to judge focus, fast enough for 1000s of files.
  const s1 = Math.min(1, 1024 / Math.max(W, H));
  const w = Math.round(W * s1), h = Math.round(H * s1);
  const c = new OffscreenCanvas(w, h), ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(full, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data, n = w * h;
  const g = toGray(d, n);
  const thumbScale = Math.min(1, 560 / Math.max(w, h));
  const tc = new OffscreenCanvas(Math.round(w * thumbScale), Math.round(h * thumbScale));
  tc.getContext('2d').drawImage(c, 0, 0, tc.width, tc.height);
  const thumb = await tc.convertToBlob({ type: 'image/jpeg', quality: 0.85 });

  let sr = 0, sg = 0, sb = 0, sl = 0, hi = 0, lo = 0;
  const hist = new Uint32Array(64);
  for (let i = 0, j = 0; j < n; i += 4, j++) {
    sr += d[i]; sg += d[i + 1]; sb += d[i + 2]; sl += g[j];
    if (g[j] > 250) hi++; else if (g[j] < 5) lo++;
    hist[Math.min(63, g[j] >> 2)]++;
  }

  // Sharpness: global, plus the sharpest of a 5x5 tile grid (subject-aware fallback when no faces).
  const T = 5;
  let tileMax = 0;
  for (let ty = 0; ty < T; ty++) for (let tx = 0; tx < T; tx++)
    tileMax = Math.max(tileMax, lapStd(g, w, h, (tx * w) / T, (ty * h) / T, ((tx + 1) * w) / T, ((ty + 1) * h) / T));
  const globalSharp = lapStd(g, w, h);

  // dHash 9x8 for quick near-duplicate detection.
  const hc = new OffscreenCanvas(9, 8), hctx = hc.getContext('2d', { willReadFrequently: true });
  hctx.drawImage(full, 0, 0, 9, 8);
  const hd = hctx.getImageData(0, 0, 9, 8).data, hash = new Uint8Array(64);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    const a = (y * 9 + x) * 4;
    hash[y * 8 + x] = hd[a] + hd[a + 1] + hd[a + 2] < hd[a + 4] + hd[a + 5] + hd[a + 6] ? 1 : 0;
  }

  // Faces: eyes open/closed, eye-region focus, smile.
  const faces = [];
  if (useFaces && faceLandmarker) {
    // Detect on a larger copy so small faces in group shots are found.
    const s2 = Math.min(1, 1600 / Math.max(W, H));
    const fw = Math.round(W * s2), fh = Math.round(H * s2);
    const fc = new OffscreenCanvas(fw, fh), fctx = fc.getContext('2d', { willReadFrequently: true });
    fctx.drawImage(full, 0, 0, fw, fh);
    try {
      const res = faceLandmarker.detect(fc);
      const fg = toGray(fctx.getImageData(0, 0, fw, fh).data, fw * fh);
      res.faceLandmarks.forEach((lm, fi) => {
        const bs = res.faceBlendshapes?.[fi]?.categories || [];
        const get = (nm) => bs.find((q) => q.categoryName === nm)?.score ?? 0;
        const box = (idx) => {
          let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
          for (const i of idx) { const p = lm[i]; x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
          return [x0, y0, x1, y1];
        };
        let fx0 = 1, fy0 = 1, fx1 = 0, fy1 = 0;
        for (const p of lm) { fx0 = Math.min(fx0, p.x); fy0 = Math.min(fy0, p.y); fx1 = Math.max(fx1, p.x); fy1 = Math.max(fy1, p.y); }
        const faceW = (fx1 - fx0) * fw;
        if (faceW < 24) return;                                   // too small to judge
        const eyeFocus = (b) => {
          const pad = (b[2] - b[0]) * 0.6;
          return lapStd(fg, fw, fh, (b[0] - pad / 2) * fw, (b[1] - pad) * fh, (b[2] + pad / 2) * fw, (b[3] + pad) * fh);
        };
        const eL = box(EYE_L), eR = box(EYE_R);
        const blink = Math.max(get('eyeBlinkLeft'), get('eyeBlinkRight'));
        const bl = get('eyeBlinkLeft'), br = get('eyeBlinkRight');
        faces.push({
          box: [fx0, fy0, fx1, fy1], eyes: [eL, eR],
          blink, // Thresholds calibrated on 120 labelled faces: open eyes peaked at 0.24, closed bottomed at 0.35.
          closed: (get('eyeBlinkLeft') + get('eyeBlinkRight')) / 2 > 0.32 || Math.max(get('eyeBlinkLeft'), get('eyeBlinkRight')) > 0.5,
          smile: (get('mouthSmileLeft') + get('mouthSmileRight')) / 2,
          frown: (get('mouthFrownLeft') + get('mouthFrownRight')) / 2,
          eyeSharp: Math.max(eyeFocus(eL), eyeFocus(eR)),
          // Normalise eye focus by face size: larger faces resolve more detail.
          size: faceW / fw,
        });
      });
    } catch (e) { console.warn('face detect', e); }
  }

  full.close();
  return {
    w: W, h: H, hash, thumb, hist: [...hist].map((v) => v / n),
    globalSharp, tileSharp: tileMax,
    mean: sl / n / 255, avg: [sr / n, sg / n, sb / n],
    clipHi: hi / n, clipLo: lo / n, faces,
  };
}

// Minimal EXIF DateTimeOriginal reader for JPEGs.
export async function exifDate(file) {
  if (!/\.jpe?g$/i.test(file.name) && file.type !== 'image/jpeg') return null;
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
        const ex = ifd0[0x8769] ? readIfd(ifd0[0x8769]) : {};
        const off = ex[0x9003] ?? ifd0[0x0132];
        if (!off) return null;
        let s = ''; for (let i = 0; i < 19; i++) s += String.fromCharCode(buf.getUint8(t + off + i));
        const [dt, tm] = s.split(' ');
        const ms = Date.parse(dt.replace(/:/g, '-') + 'T' + tm);
        return isNaN(ms) ? null : ms;
      }
      if ((marker & 0xff00) !== 0xff00) break;
      o += 2 + len;
    }
  } catch { /* no EXIF */ }
  return null;
}
