// Turns raw analysis into scores, stacks of similar shots, and pick/reject/duplicate decisions.
import { cosine } from './ai.js';

const median = (a) => { const s = a.filter((v) => v > 0).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 1; };
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const ham = (a, b) => { let s = 0; for (let i = 0; i < 64; i++) s += a[i] !== b[i]; return s; };

export const DEFAULT_WEIGHTS = { sharp: 0.32, aesthetic: 0.24, eyes: 0.2, exposure: 0.14, expression: 0.1 };

// settings: { strictness 0..1, similarity 0..1 }
export let WEIGHTS = DEFAULT_WEIGHTS;

// weights: learned from your decisions (learn.js) or null for defaults.
export function cull(photos, settings, weights) {
  WEIGHTS = weights || DEFAULT_WEIGHTS;
  const strict = settings.strictness, sim = settings.similarity;
  const eyeMed = median(photos.flatMap((p) => p.an.faces.map((f) => f.eyeSharp / Math.sqrt(f.size))));
  const tileMed = median(photos.map((p) => p.an.tileSharp));

  for (const p of photos) {
    const a = p.an, faces = a.faces;
    // Focus: judged on the eyes when there are faces, otherwise on the sharpest region.
    const focusRatio = faces.length
      ? Math.max(...faces.map((f) => f.eyeSharp / Math.sqrt(f.size))) / eyeMed
      : a.tileSharp / tileMed;
    const parts = {
      sharp: clamp01((focusRatio - 0.25) / 0.95),
      exposure: clamp01(1 - Math.abs(a.mean - 0.46) * 2.2 - a.clipHi * 5 - a.clipLo * 3),
      eyes: faces.length ? faces.filter((f) => !f.closed).length / faces.length : null,
      expression: faces.length ? clamp01(faces.reduce((s, f) => s + 0.35 + f.smile * 0.75 - f.frown * 0.6, 0) / faces.length) : null,
      aesthetic: a.clip ? clamp01((a.clip.aesthetic - 0.15) / 0.7) : null,
    };
    let wsum = 0, ssum = 0;
    for (const k in WEIGHTS) if (parts[k] !== null) { wsum += WEIGHTS[k]; ssum += WEIGHTS[k] * parts[k]; }
    p.parts = parts;
    p.focusRatio = focusRatio;
    p.score = ssum / wsum;

    const issues = [];
    const dark = a.mean < 0.12 + 0.1 * strict || a.clipLo > 0.4;
    if (dark) issues.push({ k: 'dark', t: 'Underexposed', hard: strict > 0.35 || a.mean < 0.1 });
    // Very dark frames lose edge contrast, so don't also call them blurry.
    if (!dark && focusRatio < 0.3 + 0.35 * strict) issues.push({ k: 'blur', t: faces.length ? 'Eyes out of focus' : 'Blurry', hard: true });
    const closed = faces.filter((f) => f.closed).length;
    if (closed && (strict > 0.3 || closed / faces.length > 0.5)) issues.push({ k: 'eyes', t: closed === 1 && faces.length === 1 ? 'Eyes closed' : `${closed} of ${faces.length} blinking`, hard: true });
    if (a.clipHi > 0.22 - 0.1 * strict) issues.push({ k: 'bright', t: 'Blown highlights', hard: strict > 0.5 });
    if (parts.aesthetic !== null && parts.aesthetic < 0.12 + 0.15 * strict) issues.push({ k: 'aesthetic', t: 'Weak composition', hard: strict > 0.75 });
    p.issues = issues;
  }

  // Stacks: consecutive frames of the same moment.
  const groups = [];
  let cur = [];
  photos.forEach((p, i) => {
    const prev = photos[i - 1];
    let same = false;
    if (prev) {
      const dt = Math.abs(p.time - prev.time), h = ham(p.an.hash, prev.an.hash);
      same = h <= 5 + 10 * sim || (dt < 1500 && h <= 22);
      if (!same && p.an.clip && prev.an.clip && dt < 90000)
        same = cosine(p.an.clip.emb, prev.an.clip.emb) >= 0.955 - 0.07 * sim;
    }
    if (!same && cur.length) { groups.push(cur); cur = []; }
    cur.push(p);
  });
  if (cur.length) groups.push(cur);

  groups.forEach((g, gi) => {
    const ranked = [...g].sort((a, b) => b.score - a.score);
    ranked.forEach((p, r) => {
      p.group = gi; p.rankInGroup = r;
      p.aiFlag = p.issues.some((x) => x.hard) ? 'reject' : 'dupe';
    });
    // A close-call verdict from the optional AI reviewer overrides the score ranking.
    const best = ranked.find((p) => p.reviewPick && p.aiFlag !== 'reject') || ranked.find((p) => p.aiFlag !== 'reject');
    if (best) best.aiFlag = 'pick';
    // Lenient mode keeps a close runner-up in big stacks.
    if (strict < 0.3 && ranked.length >= 4) {
      const second = ranked.find((p) => p !== best && p.aiFlag !== 'reject');
      if (second && best && best.score - second.score < 0.03) second.aiFlag = 'pick';
    }
  });

  // Stars by percentile of score across the shoot.
  const order = [...photos].sort((a, b) => b.score - a.score);
  order.forEach((p, i) => {
    const pct = i / Math.max(1, order.length - 1);
    let stars = pct < 0.1 ? 5 : pct < 0.3 ? 4 : pct < 0.6 ? 3 : pct < 0.85 ? 2 : 1;
    if (p.aiFlag === 'reject') stars = Math.min(stars, 1);
    p.aiStars = stars;
  });
  return groups.map((g) => g.map((p) => p.id));
}
