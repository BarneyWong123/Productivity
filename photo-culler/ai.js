// Scene understanding with CLIP (runs locally via transformers.js / ONNX Runtime Web).
// Gives each photo: an aesthetic score (zero-shot against quality prompts) and an
// embedding used to group shots of the same moment even when framing changes.
const TJS = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.0.2';
const MODEL = 'Xenova/clip-vit-base-patch32';

const GOOD = [
  'a stunning professional photograph with beautiful light',
  'a well composed, sharp, in-focus photo',
  'a candid photo capturing a genuine emotional moment',
  'an award winning wedding or portrait photograph',
];
const BAD = [
  'a blurry, out of focus photo',
  'a badly exposed amateur snapshot',
  'an accidental photo of the floor or a wall',
  'a photo with motion blur and camera shake',
  'a photo where the subject is cut off awkwardly',
];

let state = 'off', vision, processor, textEmb;   // off | loading | ready | failed
export const clipStatus = () => state;

export async function initClip(onProgress) {
  if (state === 'ready' || state === 'failed') return state === 'ready';
  state = 'loading';
  try {
    const T = await import(`${TJS}/dist/transformers.min.js`);
    T.env.allowLocalModels = false;
    const opts = { dtype: 'q8', progress_callback: (p) => p.status === 'progress' && onProgress?.(p.progress / 100, p.file) };
    const [tok, textModel] = await Promise.all([
      T.AutoTokenizer.from_pretrained(MODEL),
      T.CLIPTextModelWithProjection.from_pretrained(MODEL, opts),
    ]);
    [processor, vision] = await Promise.all([
      T.AutoProcessor.from_pretrained(MODEL),
      T.CLIPVisionModelWithProjection.from_pretrained(MODEL, opts),
    ]);
    const inputs = tok([...GOOD, ...BAD], { padding: true, truncation: true });
    const { text_embeds } = await textModel(inputs);
    textEmb = normRows(text_embeds.data, text_embeds.dims[1]);
    clipState.RawImage = T.RawImage;
    state = 'ready';
  } catch (e) {
    console.warn('CLIP unavailable', e);
    state = 'failed';
  }
  return state === 'ready';
}
const clipState = {};

function normRows(data, dim) {
  const rows = [];
  for (let i = 0; i < data.length; i += dim) {
    const r = Float32Array.from(data.subarray(i, i + dim));
    const m = Math.hypot(...r) || 1;
    for (let k = 0; k < dim; k++) r[k] /= m;
    rows.push(r);
  }
  return rows;
}
export const cosine = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

export async function clipAnalyse(src) {
  if (state !== 'ready') return null;
  // Small JPEG is plenty for CLIP's 224px input and keeps decoding cheap.
  const bmp = await createImageBitmap(src);
  const s = Math.min(1, 336 / Math.min(bmp.width, bmp.height));
  const c = new OffscreenCanvas(Math.round(bmp.width * s), Math.round(bmp.height * s));
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  const img = await clipState.RawImage.fromBlob(await c.convertToBlob({ type: 'image/jpeg', quality: 0.9 }));
  const { image_embeds } = await vision(await processor(img));
  const emb = normRows(image_embeds.data, image_embeds.dims[1])[0];
  const logits = textEmb.map((t) => 100 * cosine(emb, t));
  const mx = Math.max(...logits), ex = logits.map((l) => Math.exp(l - mx)), sum = ex.reduce((a, b) => a + b, 0);
  const aesthetic = ex.slice(0, GOOD.length).reduce((a, b) => a + b, 0) / sum;
  return { emb, aesthetic };
}
