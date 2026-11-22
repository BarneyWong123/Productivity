// Learns how YOU weigh focus, composition, eyes, exposure and expression from your own
// pick/reject decisions, and feeds those weights back into the culling score.
// Model: logistic regression on the score components, regularised toward the default weights
// so a handful of decisions nudges the scoring instead of overturning it.
import { DEFAULT_WEIGHTS } from './cull.js';

const KEY = 'cullcraft.decisions.v2';
const FEATURES = Object.keys(DEFAULT_WEIGHTS);
const MAX = 3000;
let samples = loadSamples();
function loadSamples() { try { return (JSON.parse(localStorage.getItem(KEY)) || []).filter((s) => s.x?.length === FEATURES.length); } catch { return []; } }
function save() { try { localStorage.setItem(KEY, JSON.stringify(samples.slice(-MAX))); } catch { /* storage blocked */ } }

const vec = (parts) => FEATURES.map((k) => (parts[k] === null || parts[k] === undefined ? 0.5 : parts[k]));

// Record a decision. Picks are positives; rejects and duplicates are negatives.
// Keyed per photo so changing your mind replaces the earlier sample.
export function recordDecision(photo) {
  const id = photo.key;
  samples = samples.filter((s) => s.id !== id);
  if (photo.userFlag === 'pick' || photo.userFlag === 'reject' || photo.userFlag === 'dupe') {
    samples.push({ id, x: vec(photo.parts), y: photo.userFlag === 'pick' ? 1 : 0 });
  }
  save();
  cached = null;
}
export const decisionCount = () => samples.length;
export function forgetDecisions() { samples = []; save(); cached = null; }

let cached = null, cachedPrior = null;
// Returns weights (summing to 1) or null when there isn't enough signal yet.
export function learnedWeights(prior_weights = DEFAULT_WEIGHTS) {
  if (cachedPrior !== prior_weights) { cached = null; cachedPrior = prior_weights; }
  if (cached !== undefined && cached !== null) return cached;
  const pos = samples.filter((s) => s.y === 1).length, neg = samples.length - pos;
  if (pos < 3 || neg < 3) return (cached = null);
  const prior = FEATURES.map((k) => prior_weights[k] * 8);   // prior in logit space
  let w = [...prior], b = -0.5 * prior.reduce((a, c) => a + c, 0);
  const lr = 0.5, lambda = 4 / samples.length;
  for (let it = 0; it < 400; it++) {
    const gw = new Array(w.length).fill(0); let gb = 0;
    for (const s of samples) {
      const z = b + s.x.reduce((a, v, i) => a + v * w[i], 0);
      const err = 1 / (1 + Math.exp(-z)) - s.y;
      s.x.forEach((v, i) => (gw[i] += err * v));
      gb += err;
    }
    w = w.map((wi, i) => wi - lr * (gw[i] / samples.length + lambda * (wi - prior[i])));
    b -= lr * gb / samples.length;
  }
  const pos_w = w.map((v) => Math.max(0.02, v));
  const sum = pos_w.reduce((a, c) => a + c, 0);
  cached = Object.fromEntries(FEATURES.map((k, i) => [k, pos_w[i] / sum]));
  // Blend toward defaults until there are plenty of decisions.
  const trust = Math.min(1, samples.length / 60);
  for (const k of FEATURES) cached[k] = trust * cached[k] + (1 - trust) * prior_weights[k];
  return cached;
}
