// Autosave: your flags, stars, edits and AI-review verdicts are saved per photo
// (by file name + size) as you work, and restored when you open the same photos again.
const KEY = 'cullcraft.photos.v1';
let db = (() => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } })();
let timer = null, onSaved = null;

export function onSave(fn) { onSaved = fn; }

export function restore(p) {
  const s = db[p.key];
  if (!s) return false;
  if (s.f !== undefined) p.userFlag = s.f === 'none' ? null : s.f;
  if (s.s !== undefined) p.userStars = s.s;
  if (s.e) { p.edit = s.e; p.manual = !!s.m; }
  if (s.rp) { p.reviewPick = true; p.reviewNote = s.rn || null; }
  return true;
}

export function remember(p) {
  const s = {};
  if (p.userFlag !== undefined) s.f = p.userFlag === null ? 'none' : p.userFlag;
  if (p.userStars !== undefined) s.s = p.userStars;
  if (p.edit) { s.e = p.edit; s.m = p.manual; }
  if (p.reviewPick) { s.rp = 1; s.rn = p.reviewNote; }
  if (Object.keys(s).length) db[p.key] = { ...s, t: Date.now() }; else delete db[p.key];
  clearTimeout(timer);
  timer = setTimeout(flush, 300);
}

function flush() {
  // Keep the newest 20,000 photos if storage gets large.
  const keys = Object.keys(db);
  if (keys.length > 20000) keys.sort((a, b) => db[a].t - db[b].t).slice(0, keys.length - 20000).forEach((k) => delete db[k]);
  try { localStorage.setItem(KEY, JSON.stringify(db)); onSaved?.(true); }
  catch { onSaved?.(false); }
}
