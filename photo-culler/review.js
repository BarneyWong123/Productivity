// Optional: ask a vision LLM (via OpenRouter, with your own key) to break close calls —
// stacks where the top frames score within a few points of each other.
// Only the contenders of those stacks are sent, as small JPEG previews.
const KEY = 'cullcraft.review.v1';
export const reviewSettings = (() => {
  try { return { model: 'google/gemini-2.5-flash', key: '', ...JSON.parse(localStorage.getItem(KEY)) }; } catch { return { model: 'google/gemini-2.5-flash', key: '' }; }
})();
export function saveReviewSettings() { try { localStorage.setItem(KEY, JSON.stringify(reviewSettings)); } catch { /* blocked */ } }

// Contenders: non-rejected frames within `gap` of the stack's best score (max 4).
export function closeCalls(photos, groups, gap = 0.06) {
  const out = [];
  for (const g of groups) {
    const ok = g.map((id) => photos[id]).filter((p) => p.aiFlag !== 'reject' && p.userFlag === undefined).sort((a, b) => b.score - a.score);
    if (ok.length < 2 || ok[0].score - ok[1].score > gap) continue;
    out.push(ok.filter((p) => ok[0].score - p.score <= gap).slice(0, 4));
  }
  return out;
}

async function previewDataUrl(p) {
  const bmp = await createImageBitmap(p.an.thumb);
  const s = Math.min(1, 512 / Math.max(bmp.width, bmp.height));
  const c = new OffscreenCanvas(Math.round(bmp.width * s), Math.round(bmp.height * s));
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height); bmp.close();
  const blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.82 });
  return new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(blob); });
}

const PROMPT = (n) => `You are a professional wedding and event photographer culling a shoot.
These ${n} photos are near-duplicates of the same moment. Choose the single best frame to deliver to the client.
Judge, in order: critical focus on the subject's eyes, closed or half-closed eyes, flattering expression, body language and gesture, composition and framing, distracting elements.
Reply with JSON only: {"best": <1-based index>, "reason": "<one short sentence>"}`;

export async function reviewStack(stack) {
  if (!reviewSettings.key) throw new Error('Add your OpenRouter API key first.');
  const images = await Promise.all(stack.map(previewDataUrl));
  const content = [{ type: 'text', text: PROMPT(stack.length) }];
  images.forEach((url, i) => { content.push({ type: 'text', text: `Photo ${i + 1}:` }); content.push({ type: 'image_url', image_url: { url } }); });
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${reviewSettings.key}`, 'Content-Type': 'application/json', 'X-Title': 'CullCraft' },
    body: JSON.stringify({ model: reviewSettings.model, messages: [{ role: 'user', content }], temperature: 0, max_tokens: 200 }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(res.status === 401 ? 'OpenRouter rejected the API key.' : `OpenRouter error ${res.status}: ${t.slice(0, 160)}`);
  }
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content ?? '';
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('The model did not return a choice.');
  const j = JSON.parse(m[0]);
  const idx = Math.round(+j.best) - 1;
  if (!(idx >= 0 && idx < stack.length)) throw new Error('The model chose a photo that does not exist.');
  return { best: stack[idx], reason: String(j.reason || '').slice(0, 200) };
}
