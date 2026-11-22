// Export: Lightroom XMP sidecars (ratings, color labels, develop settings), picks as a ZIP, CSV report.
import { toCrs, applyEdit } from './edit.js';

const esc = (s) => String(s).replace(/[<&"]/g, (c) => ({ '<': '&lt;', '&': '&amp;', '"': '&quot;' })[c]);
const base = (name) => name.replace(/\.[^.]+$/, '');

export function xmpFor(p) {
  const flag = p.flag;
  const label = flag === 'pick' ? 'Green' : flag === 'reject' ? 'Red' : flag === 'dupe' ? 'Yellow' : '';
  const attrs = {
    'xmp:Rating': flag === 'reject' ? -1 : p.stars,
    ...(label && { 'xmp:Label': label }),
    ...(p.edit && { 'crs:HasSettings': 'True', 'crs:ProcessVersion': '11.0', ...toCrs(p.edit) }),
  };
  if (p.edit && p.raw) { delete attrs['crs:IncrementalTemperature']; delete attrs['crs:IncrementalTint']; }
  const body = Object.entries(attrs).map(([k, v]) => `   ${k}="${esc(v)}"`).join('\n');
  return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="CullCraft">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
   xmlns:xmp="http://ns.adobe.com/xap/1.0/"
   xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
${body}>
   <dc:subject xmlns:dc="http://purl.org/dc/elements/1.1/"><rdf:Bag>${p.highlight && p.flag === 'pick' ? '<rdf:li>Highlight</rdf:li>' : ''}<rdf:li>CullCraft scene ${(p.scene ?? 0) + 1}</rdf:li>${p.issues.map((i) => `<rdf:li>${esc(i.t)}</rdf:li>`).join('')}</rdf:Bag></dc:subject>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
}

export function csvReport(photos) {
  const rows = [['file', 'decision', 'highlight', 'stars', 'score', 'sharpness', 'eyes', 'people', 'exposure', 'expression', 'aesthetic', 'scene', 'stack', 'issues']];
  const f = (v) => (v === null || v === undefined ? '' : (+v).toFixed(2));
  for (const p of photos) rows.push([p.name, p.flag || '', p.highlight && p.flag === 'pick' ? 'yes' : '', p.stars, f(p.score), f(p.parts.sharp), f(p.parts.eyes), f(p.parts.people), f(p.parts.exposure), f(p.parts.expression), f(p.parts.aesthetic), (p.scene ?? 0) + 1, p.group + 1, p.issues.map((i) => i.t).join('; ')]);
  return rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
}

async function rendered(p) {
  const bmp = await createImageBitmap(p.src);
  const c = new OffscreenCanvas(bmp.width, bmp.height), ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0); bmp.close();
  ctx.putImageData(applyEdit(ctx.getImageData(0, 0, c.width, c.height), p.edit), 0, 0);
  return c.convertToBlob({ type: 'image/jpeg', quality: 0.95 });
}

export async function exportZip(photos, { includeFiles, onProgress }) {
  if (!window.JSZip) throw new Error('ZIP library did not load. Check your internet connection and reload.');
  const zip = new JSZip(), picks = photos.filter((p) => p.flag === 'pick');
  zip.file('cullcraft-report.csv', csvReport(photos));
  const side = zip.folder('xmp-sidecars');
  for (const p of photos) side.file(base(p.name) + '.xmp', xmpFor(p));
  if (includeFiles) {
    const out = zip.folder('picks');
    for (let i = 0; i < picks.length; i++) {
      onProgress?.(i, picks.length);
      const p = picks[i];
      out.file(p.name, p.file);
      if (p.edit) out.file(base(p.name) + '_edited.jpg', await rendered(p));
    }
  }
  return zip.generateAsync({ type: 'blob' }, (m) => onProgress?.(m.percent / 100, 1));
}

// Write .xmp files straight into the shoot folder so Lightroom picks them up on "Read Metadata from Files".
export const canWriteFolder = () => 'showDirectoryPicker' in window;
export async function writeSidecars(photos) {
  const dir = await window.showDirectoryPicker({ mode: 'readwrite' });
  let n = 0;
  for (const p of photos) {
    const fh = await dir.getFileHandle(base(p.name) + '.xmp', { create: true });
    const w = await fh.createWritable(); await w.write(xmpFor(p)); await w.close(); n++;
  }
  return n;
}

export function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
