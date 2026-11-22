// Generates a small example shoot so the app can be tried without your own photos.
// Five scenes, each a short burst with realistic flaws (soft focus, camera shake, bad exposure).
function scene(ctx, w, h, seed, jitter) {
  const rnd = mulberry(seed);
  const hues = [[205, 30], [25, 45], [280, 25], [160, 30], [10, 20]][seed % 5];
  const sky = ctx.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, `hsl(${hues[0]} 55% 62%)`);
  sky.addColorStop(1, `hsl(${hues[1]} 70% 82%)`);
  ctx.fillStyle = sky; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = `hsl(${hues[1]} 90% 85%)`;
  ctx.beginPath(); ctx.arc(w * (0.2 + rnd() * 0.6), h * 0.28, h * 0.08, 0, 7); ctx.fill();
  for (let layer = 0; layer < 3; layer++) {
    ctx.fillStyle = `hsl(${hues[0] + 40} ${25 + layer * 10}% ${48 - layer * 12}%)`;
    ctx.beginPath(); ctx.moveTo(0, h);
    for (let x = 0; x <= w; x += w / 12) ctx.lineTo(x, h * (0.55 + layer * 0.1) + Math.sin(x / w * 6 + seed + layer) * h * 0.05 + rnd() * h * 0.03);
    ctx.lineTo(w, h); ctx.fill();
  }
  // Textured foreground (gives the focus detector real detail to measure).
  for (let i = 0; i < 900; i++) {
    ctx.fillStyle = `hsla(${hues[0] + 60} 30% ${20 + rnd() * 30}% / .8)`;
    ctx.fillRect(rnd() * w, h * 0.82 + rnd() * h * 0.18, 2 + rnd() * 3, 6 + rnd() * 14);
  }
  // Subject: a figure, slightly moved per frame.
  const x = w * (0.42 + jitter * 0.04), y = h * 0.52;
  ctx.fillStyle = '#2b2530';
  ctx.beginPath(); ctx.arc(x, y, h * 0.06, 0, 7); ctx.fill();
  ctx.beginPath(); ctx.ellipse(x, y + h * 0.2, h * 0.08, h * 0.15, 0, 0, 7); ctx.fill();
  ctx.strokeStyle = '#f3e9dc'; ctx.lineWidth = 2;
  for (let i = 0; i < 14; i++) { ctx.beginPath(); ctx.moveTo(x - 30 + i * 4, y - 40); ctx.lineTo(x - 26 + i * 4, y - 70); ctx.stroke(); }
}
function mulberry(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

export async function sampleShoot() {
  const w = 1500, h = 1000, files = [];
  const base = Date.UTC(2026, 9, 18, 15, 0, 0);
  const flaws = [[null, 'soft', null], [null, null, 'dark'], ['shake', null, null, null], [null, 'bright'], [null, 'soft', null]];
  let n = 1, t = base;
  for (let s = 0; s < flaws.length; s++) {
    for (let f = 0; f < flaws[s].length; f++) {
      const c = new OffscreenCanvas(w, h), ctx = c.getContext('2d');
      const flaw = flaws[s][f];
      if (flaw === 'soft') ctx.filter = 'blur(5px)';
      if (flaw === 'shake') ctx.filter = 'blur(3px)';
      if (flaw === 'dark') ctx.filter = 'brightness(0.22)';
      if (flaw === 'bright') ctx.filter = 'brightness(2.4)';
      scene(ctx, w, h, s, f);
      const blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
      const file = new File([blob], `SAMPLE_${String(n++).padStart(4, '0')}.jpg`, { type: 'image/jpeg', lastModified: t });
      files.push(file);
      t += 700;
    }
    t += 45000;
  }
  return files;
}
