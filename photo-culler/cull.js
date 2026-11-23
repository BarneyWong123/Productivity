// Turns raw analysis into scores, stacks of similar shots, and pick/reject/duplicate decisions.
import { cosine } from './ai.js';

const median = (a) => { const s = a.filter((v) => v > 0).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 1; };
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const ham = (a, b) => { let s = 0; for (let i = 0; i < 64; i++) s += a[i] !== b[i]; return s; };

// Default importance of each component (re-learned from your decisions in learn.js).
export const DEFAULT_WEIGHTS = { sharp: 0.3, aesthetic: 0.16, eyes: 0.18, people: 0.14, exposure: 0.11, expression: 0.11 };
export let WEIGHTS = DEFAULT_WEIGHTS;

// Shoot types change what matters. Weddings/portraits are judged on eyes and expressions,
// sports on sharpness, landscapes on composition and exposure.
export const GENRES = {
  wedding: { label: 'Wedding & portrait', weights: DEFAULT_WEIGHTS },
  event: { label: 'Events & conferences', weights: { sharp: 0.3, aesthetic: 0.14, eyes: 0.2, people: 0.18, exposure: 0.1, expression: 0.08 } },
  sports: { label: 'Sports & action', weights: { sharp: 0.45, aesthetic: 0.2, eyes: 0.08, people: 0.07, exposure: 0.15, expression: 0.05 } },
  landscape: { label: 'Landscape & travel', weights: { sharp: 0.3, aesthetic: 0.4, eyes: 0.03, people: 0.02, exposure: 0.23, expression: 0.02 } },
};

// Absolute focus floors (Laplacian std on the 1024px analysis copy / on the 1600px face copy).
// Below these a frame is soft no matter how the rest of the shoot looks.
export const ABS_BLUR = 4.5, ABS_EYE_BLUR = 3.2;

// Faces that matter: ignore tiny background faces relative to the largest one in the frame.
const mainFaces = (faces) => {
  if (!faces.length) return [];
  const big = Math.max(...faces.map((f) => f.size));
  return faces.filter((f) => f.size >= big * 0.35);
};

// settings: { strictness 0..1, similarity 0..1 }; weights: learned or null for defaults.
export function cull(photos, settings, weights) {
  WEIGHTS = weights || GENRES[settings.genre || 'wedding'].weights;
  const protect = settings.protectEmotion !== false;
  const strict = settings.strictness, sim = settings.similarity;
  const eyeMed = median(photos.flatMap((p) => mainFaces(p.an.faces).map((f) => f.eyeSharp / Math.sqrt(f.size))));
  const tileMed = median(photos.map((p) => p.an.tileSharp));

  // ---- 1. stacks: consecutive frames of the same moment ----
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

  // ---- 2. per-photo components and problems ----
  for (const g of groups) {
    // Most people with open eyes anyone managed to get in this moment.
    const openCount = (p) => mainFaces(p.an.faces).filter((f) => !f.closed).length;
    const bestOpen = Math.max(0, ...g.map(openCount));
    const mostFaces = Math.max(0, ...g.map((p) => mainFaces(p.an.faces).length));

    for (const p of g) {
      const a = p.an, faces = mainFaces(a.faces);
      // Focus on the eyes, averaged over the main faces weighted by face size,
      // so a group shot where only one person is sharp doesn't pass as sharp.
      let focusRatio, eyeAbs = null;
      if (faces.length) {
        const wsum = faces.reduce((s, f) => s + f.size, 0);
        eyeAbs = faces.reduce((s, f) => s + f.eyeSharp * f.size, 0) / wsum;
        focusRatio = faces.reduce((s, f) => s + (f.eyeSharp / Math.sqrt(f.size)) * f.size, 0) / wsum / eyeMed;
      } else focusRatio = a.tileSharp / tileMed;

      const parts = {
        sharp: clamp01((focusRatio - 0.25) / 0.95),
        exposure: clamp01(1 - Math.abs(a.mean - 0.46) * 2.2 - a.clipHi * 5 - a.clipLo * 3),
        eyes: faces.length ? faces.filter((f) => !f.closed).length / faces.length : null,
        // More people looking good in the frame beats fewer, within the same moment.
        people: bestOpen > 0 ? openCount(p) / bestOpen : null,
        expression: faces.length ? clamp01(faces.reduce((s, f) => s + 0.35 + f.smile * 0.75 - f.frown * 0.6, 0) / faces.length) : null,
        aesthetic: a.clip ? clamp01((a.clip.aesthetic - 0.15) / 0.7) : null,
      };
      p.parts = parts; p.focusRatio = focusRatio;

      const issues = [];
      const dark = a.mean < 0.12 + 0.1 * strict || a.clipLo > 0.4;
      if (dark) issues.push({ k: 'dark', t: 'Underexposed', hard: strict > 0.35 || a.mean < 0.1 });
      if (!dark) {   // very dark frames lose edge contrast, so don't also call them blurry
        const relSoft = focusRatio < 0.3 + 0.35 * strict;
        const absSoft = faces.length ? eyeAbs < ABS_EYE_BLUR * (0.7 + 0.6 * strict) : a.tileSharp < ABS_BLUR * (0.7 + 0.6 * strict);
        // A strong expression can be worth more than critical focus (the slightly soft
        // frame of someone laughing or crying): keep it unless it is truly unusable.
        const emotional = protect && faces.some((f) => f.smile > 0.6 || f.frown > 0.45) && !absSoft && focusRatio > 0.18;
        if (emotional && relSoft) issues.push({ k: 'emotion', t: 'Slightly soft, kept for expression', hard: false });
        else if (relSoft || absSoft) issues.push({ k: 'blur', t: faces.length ? 'Eyes out of focus' : 'Blurry', hard: true });
        // Back/front focus: something in the frame is sharp but the eyes aren't.
        else if (faces.length && eyeAbs < a.tileSharp * (0.28 + 0.2 * strict) && a.tileSharp > ABS_BLUR * 2)
          issues.push({ k: 'missed', t: 'Focus missed the eyes', hard: strict > 0.4 });
      }
      const closed = faces.filter((f) => f.closed).length;
      if (closed && (strict > 0.3 || closed / faces.length > 0.5)) issues.push({ k: 'eyes', t: closed === 1 && faces.length === 1 ? 'Eyes closed' : `${closed} of ${faces.length} blinking`, hard: true });
      if (mostFaces >= 2 && faces.length < mostFaces) issues.push({ k: 'people', t: `${mostFaces - faces.length} fewer ${mostFaces - faces.length === 1 ? 'person' : 'people'} than best frame`, hard: false });
      if (a.clipHi > 0.22 - 0.1 * strict) issues.push({ k: 'bright', t: 'Blown highlights', hard: strict > 0.5 || a.clipHi > 0.3 });
      if (parts.aesthetic !== null && parts.aesthetic < 0.12 + 0.15 * strict) issues.push({ k: 'aesthetic', t: 'Weak composition', hard: strict > 0.75 });
      p.issues = issues;

      let ws = 0, ss = 0;
      for (const k in WEIGHTS) if (parts[k] !== null && parts[k] !== undefined) { ws += WEIGHTS[k]; ss += WEIGHTS[k] * parts[k]; }
      p.score = ws ? ss / ws : 0;
      // Problems drag the score down so the ranking agrees with the flags.
      p.score *= issues.some((x) => x.hard) ? 0.6 : 1;
    }
  }

  // ---- 3. pick the best of each stack ----
  groups.forEach((g, gi) => {
    const ranked = [...g].sort((a, b) => b.score - a.score);
    ranked.forEach((p, r) => {
      p.group = gi; p.rankInGroup = r;
      p.aiFlag = p.issues.some((x) => x.hard) ? 'reject' : 'dupe';
    });
    const best = ranked.find((p) => p.aiFlag !== 'reject');
    if (best) best.aiFlag = 'pick';
    // Strict mode: in a stack, frames far behind the winner are rejects rather than duplicates.
    if (best && strict >= 0.7) for (const p of ranked) if (p.aiFlag === 'dupe' && best.score - p.score > 0.25 - 0.15 * strict) { p.aiFlag = 'reject'; p.issues.push({ k: 'weaker', t: 'Clearly weaker than the pick', hard: true }); }
    // Lenient mode keeps a close runner-up in big stacks.
    if (strict < 0.3 && ranked.length >= 4) {
      const second = ranked.find((p) => p !== best && p.aiFlag !== 'reject');
      if (second && best && best.score - second.score < 0.03) second.aiFlag = 'pick';
    }
  });

  // ---- 4. scenes: stacks separated by a long gap in capture time (ceremony, portraits, reception…) ----
  const gap = (settings.sceneGap || 5) * 60000;
  let scene = 0;
  groups.forEach((g, i) => {
    if (i && g[0].time - groups[i - 1][groups[i - 1].length - 1].time > gap) scene++;
    g.forEach((p) => (p.scene = scene));
  });

  // ---- 5. highlights: the very best picks of the shoot, at least one per scene ----
  const picks = photos.filter((p) => p.aiFlag === 'pick');
  const want = Math.max(1, Math.round(photos.length * 0.05));
  const hl = new Set([...picks].sort((a, b) => b.score - a.score).slice(0, want));
  for (let s = 0; s <= scene; s++) {
    const best = picks.filter((p) => p.scene === s).sort((a, b) => b.score - a.score)[0];
    if (best && best.score > 0.55) hl.add(best);
  }
  photos.forEach((p) => (p.highlight = hl.has(p)));

  // ---- 6. stars by percentile of score across the shoot ----
  const order = [...photos].sort((a, b) => b.score - a.score);
  order.forEach((p, i) => {
    const pct = i / Math.max(1, order.length - 1);
    let stars = pct < 0.1 ? 5 : pct < 0.3 ? 4 : pct < 0.6 ? 3 : pct < 0.85 ? 2 : 1;
    if (p.aiFlag === 'reject') stars = Math.min(stars, 1);
    p.aiStars = stars;
  });
  return groups.map((g) => g.map((p) => p.id));
}
export function sceneCount(photos) { return photos.length ? Math.max(...photos.map((p) => p.scene ?? 0)) + 1 : 0; 
}
