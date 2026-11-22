// Non-destructive editing, auto-correction, and a style profile learned from your own edits.
export const SLIDERS = [
  { k: 'exposure', label: 'Exposure', min: -3, max: 3, step: 0.05, fmt: (v) => (v > 0 ? '+' : '') + v.toFixed(2) + ' EV' },
  { k: 'contrast', label: 'Contrast', min: -1, max: 1, step: 0.01 },
  { k: 'highlights', label: 'Highlights', min: -1, max: 1, step: 0.01 },
  { k: 'shadows', label: 'Shadows', min: -1, max: 1, step: 0.01 },
  { k: 'temp', label: 'Temperature', min: -1, max: 1, step: 0.01, grad: 'linear-gradient(90deg,#4f8cff,#ddd,#ffb347)' },
  { k: 'tint', label: 'Tint', min: -1, max: 1, step: 0.01, grad: 'linear-gradient(90deg,#3fbf5f,#ddd,#d65ad6)' },
  { k: 'vibrance', label: 'Vibrance', min: -1, max: 1, step: 0.01 },
  { k: 'saturation', label: 'Saturation', min: -1, max: 1, step: 0.01 },
];
export const ZERO = () => Object.fromEntries(SLIDERS.map((s) => [s.k, 0]));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function autoParams(a) {
  const [r, g, b] = a.avg, m = (r + g + b) / 3 || 1;
  return {
    ...ZERO(),
    exposure: clamp(Math.log2(0.46 / Math.max(0.02, a.mean)) * 0.75, -2, 2),
    temp: clamp(((b - r) / m) * 0.7, -0.5, 0.5),                 // gray-world white balance
    tint: clamp((((r + b) / 2 - g) / m) * 0.7, -0.4, 0.4),
    highlights: a.clipHi > 0.01 ? -clamp(0.15 + a.clipHi * 5, 0, 0.7) : 0,
    shadows: a.clipLo > 0.02 ? clamp(0.1 + a.clipLo * 4, 0, 0.6) : 0,
    contrast: 0.08, vibrance: 0.12,
  };
}

// ---- learned style (persists in this browser) ----
const KEY = 'cullcraft.style.v1';
let profile = load();
function load() {
  try { return JSON.parse(localStorage.getItem(KEY)) || { sum: ZERO(), n: 0 }; } catch { return { sum: ZERO(), n: 0 }; }
}
function save() { try { localStorage.setItem(KEY, JSON.stringify(profile)); } catch { /* storage blocked */ } }

// Record how a hand edit differs from the automatic correction. Each photo counts once (latest edit wins).
const contributions = new Map();
export function learnFrom(photo) {
  const auto = autoParams(photo.an), delta = ZERO();
  for (const k in delta) delta[k] = photo.edit[k] - auto[k];
  const prev = contributions.get(photo.key);
  if (prev) for (const k in delta) profile.sum[k] -= prev[k]; else profile.n++;
  for (const k in delta) profile.sum[k] += delta[k];
  contributions.set(photo.key, delta);
  save();
}
export function styleInfo() { return profile.n; }
export function resetStyle() { profile = { sum: ZERO(), n: 0 }; contributions.clear(); save(); }
export function styled(a) {
  const p = autoParams(a);
  if (profile.n) for (const k in p) p[k] += profile.sum[k] / profile.n;
  return p;
}

// ---- pixel pipeline ----
export function applyEdit(img, e) {
  const d = img.data, gain = 2 ** e.exposure;
  const wb = [1 + e.temp * 0.22 - e.tint * 0.08, 1 + e.tint * 0.16, 1 - e.temp * 0.22 - e.tint * 0.08];
  const luts = wb.map((w) => {
    const lut = new Uint8ClampedArray(256);
    for (let i = 0; i < 256; i++) {
      let v = Math.pow(Math.pow(i / 255, 2.2) * gain * w, 1 / 2.2);
      // Highlight/shadow recovery as smooth tone-curve bends.
      if (e.highlights) { const t = clamp((v - 0.5) * 2, 0, 1.5); v += e.highlights * 0.25 * t * t; }
      if (e.shadows) { const t = clamp(1 - v * 2.2, 0, 1); v += e.shadows * 0.22 * t * t; }
      if (e.contrast) { const x = clamp(v, 0, 1); v = x + e.contrast * 0.6 * (x - 0.5) * (1 - Math.abs(2 * x - 1)) * 1.6; }
      // Soft shoulder instead of a hard clip.
      if (v > 0.9) v = 0.9 + 0.1 * (1 - Math.exp(-(v - 0.9) * 10));
      lut[i] = v * 255;
    }
    return lut;
  });
  const sat = 1 + e.saturation, vib = e.vibrance;
  for (let i = 0; i < d.length; i += 4) {
    let r = luts[0][d[i]], g = luts[1][d[i + 1]], b = luts[2][d[i + 2]];
    if (sat !== 1 || vib) {
      const l = 0.299 * r + 0.587 * g + 0.114 * b;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      const cur = mx ? (mx - mn) / mx : 0;
      const k = sat * (1 + vib * (1 - cur));                 // vibrance boosts muted colours most
      r = l + (r - l) * k; g = l + (g - l) * k; b = l + (b - l) * k;
    }
    d[i] = r; d[i + 1] = g; d[i + 2] = b;
  }
  return img;
}

// Lightroom-compatible develop settings for XMP sidecars.
export function toCrs(e) {
  const r = (v, s = 100) => Math.round(v * s);
  return {
    'crs:Exposure2012': e.exposure.toFixed(2), 'crs:Contrast2012': r(e.contrast),
    'crs:Highlights2012': r(e.highlights), 'crs:Shadows2012': r(e.shadows),
    'crs:IncrementalTemperature': r(e.temp, 60), 'crs:IncrementalTint': r(e.tint, 60),
    'crs:Vibrance': r(e.vibrance), 'crs:Saturation': r(e.saturation),
  };
}
