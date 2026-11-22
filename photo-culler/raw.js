// RAW support: pulls the largest embedded JPEG preview out of TIFF-based RAW files
// (Sony ARW/SR2/SRF, Nikon NEF, Canon CR2, Adobe DNG, Pentax PEF, Olympus ORF*, Panasonic RW2*).
// Modern Sony bodies embed a full-resolution or near-full JPEG, which is what culling needs.
export const RAW_EXT = /\.(arw|sr2|srf|nef|nrw|cr2|dng|pef|orf|rw2|raf)$/i;
export const isRaw = (f) => RAW_EXT.test(f.name);

export async function rawToJpeg(file) {
  const buf = await file.arrayBuffer();
  const dv = new DataView(buf);
  const found = [];  // {off,len}
  let orientation = 1, time = null;

  const bo = dv.getUint16(0);
  if (bo === 0x4949 || bo === 0x4d4d) {
    const le = bo === 0x4949;
    const u16 = (p) => dv.getUint16(p, le), u32 = (p) => dv.getUint32(p, le);
    const seen = new Set();
    const walk = (p, depth) => {
      if (!p || p + 2 > buf.byteLength || seen.has(p) || depth > 6) return;
      seen.add(p);
      const n = u16(p);
      if (n > 1000) return;
      let jOff = 0, jLen = 0, sOff = 0, sLen = 0, compression = 0;
      for (let i = 0; i < n; i++) {
        const e = p + 2 + i * 12;
        if (e + 12 > buf.byteLength) return;
        const tag = u16(e), type = u16(e + 2), cnt = u32(e + 4);
        const val = type === 3 && cnt === 1 ? u16(e + 8) : u32(e + 8);
        switch (tag) {
          case 0x0201: jOff = val; break;
          case 0x0202: jLen = val; break;
          case 0x0111: if (cnt === 1) sOff = val; break;    // StripOffsets
          case 0x0117: if (cnt === 1) sLen = val; break;    // StripByteCounts
          case 0x0103: compression = val; break;
          case 0x0112: if (depth === 0) orientation = val; break;
          case 0x9003: case 0x0132: if (!time) time = readDate(dv, val); break;
          case 0x8769: walk(val, depth + 1); break;          // EXIF IFD
          case 0x014a: {                                      // SubIFDs
            if (cnt === 1) walk(val, depth + 1);
            else for (let k = 0; k < cnt; k++) walk(u32(val + k * 4), depth + 1);
          }
        }
      }
      if (jOff && jLen) found.push({ off: jOff, len: jLen });
      if ((compression === 6 || compression === 7) && sOff && sLen) found.push({ off: sOff, len: sLen });
      walk(u32(p + 2 + n * 12), depth);                       // next IFD in chain
    };
    walk(u32(4), 0);
  }
  // Fallback for non-TIFF RAWs (e.g. Fuji RAF): scan for JPEG start markers.
  const valid = found.filter((j) => j.off + j.len <= buf.byteLength && dv.getUint16(j.off) === 0xffd8);
  if (!valid.length) scanForJpegs(dv, valid);
  if (!valid.length) throw new Error('No embedded preview found in ' + file.name);
  valid.sort((a, b) => b.len - a.len);
  let blob = new Blob([buf.slice(valid[0].off, valid[0].off + valid[0].len)], { type: 'image/jpeg' });
  if (orientation !== 1) blob = await rotate(blob, orientation);
  return { blob, time };
}

function readDate(dv, off) {
  try {
    let s = '';
    for (let i = 0; i < 19; i++) s += String.fromCharCode(dv.getUint8(off + i));
    const [d, t] = s.split(' ');
    const ms = Date.parse(d.replace(/:/g, '-') + 'T' + t);
    return isNaN(ms) ? null : ms;
  } catch { return null; }
}

function scanForJpegs(dv, out) {
  const n = dv.byteLength;
  for (let i = 0; i < n - 4; i++) {
    if (dv.getUint8(i) === 0xff && dv.getUint8(i + 1) === 0xd8 && dv.getUint8(i + 2) === 0xff) {
      for (let j = i + 2; j < n - 1; j++) {
        if (dv.getUint8(j) === 0xff && dv.getUint8(j + 1) === 0xd9) { out.push({ off: i, len: j + 2 - i }); i = j; break; }
      }
    }
  }
}

async function rotate(blob, o) {
  const bmp = await createImageBitmap(blob, { imageOrientation: 'none' });
  const swap = o >= 5;
  const c = new OffscreenCanvas(swap ? bmp.height : bmp.width, swap ? bmp.width : bmp.height);
  const ctx = c.getContext('2d');
  if (o === 3) { ctx.translate(c.width, c.height); ctx.rotate(Math.PI); }
  else if (o === 6) { ctx.translate(c.width, 0); ctx.rotate(Math.PI / 2); }
  else if (o === 8) { ctx.translate(0, c.height); ctx.rotate(-Math.PI / 2); }
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  return c.convertToBlob({ type: 'image/jpeg', quality: 0.95 });
}
