// Minimal PNG encoder (RGBA, 8-bit) using Node's zlib. No external deps.
import zlib from 'node:zlib';

const CRC_TABLE = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c;
}
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}
/** pixels: Uint8Array of RGBA, length = w*h*4 */
export function encodePNG(w, h, pixels) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    pixels.subarray(y * w * 4, (y + 1) * w * 4).forEach((v, i) => { raw[y * (w * 4 + 1) + 1 + i] = v; });
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Simple software rasterizer helpers for icons. */
export function makeCanvas(w, h) {
  const px = new Uint8Array(w * h * 4);
  const set = (x, y, r, g, b, a = 255) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const i = (y * w + x) * 4;
    const sa = a / 255, da = px[i + 3] / 255, oa = sa + da * (1 - sa);
    if (oa <= 0) return;
    px[i] = Math.round((r * sa + px[i] * da * (1 - sa)) / oa);
    px[i + 1] = Math.round((g * sa + px[i + 1] * da * (1 - sa)) / oa);
    px[i + 2] = Math.round((b * sa + px[i + 2] * da * (1 - sa)) / oa);
    px[i + 3] = Math.round(oa * 255);
  };
  return {
    px, w, h,
    fillRect(x0, y0, x1, y1, c) { for (let y = Math.max(0, y0 | 0); y < Math.min(h, y1); y++) for (let x = Math.max(0, x0 | 0); x < Math.min(w, x1); x++) set(x, y, ...c); },
    fillCircle(cx, cy, rad, c) { for (let y = Math.floor(cy - rad); y <= cy + rad; y++) for (let x = Math.floor(cx - rad); x <= cx + rad; x++) { const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy); if (d <= rad) set(x, y, ...c); else if (d < rad + 1) set(x, y, c[0], c[1], c[2], Math.round((c[3] ?? 255) * (rad + 1 - d))); } },
    ring(cx, cy, rad, thick, c) { for (let y = Math.floor(cy - rad - thick); y <= cy + rad + thick; y++) for (let x = Math.floor(cx - rad - thick); x <= cx + rad + thick; x++) { const d = Math.abs(Math.hypot(x + 0.5 - cx, y + 0.5 - cy) - rad); if (d <= thick / 2) set(x, y, ...c); else if (d < thick / 2 + 1) set(x, y, c[0], c[1], c[2], Math.round((c[3] ?? 255) * (thick / 2 + 1 - d))); } },
    roundRect(x0, y0, x1, y1, r, c) { for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const dx = Math.max(x0 + r - x - 0.5, 0, x + 0.5 - (x1 - r)), dy = Math.max(y0 + r - y - 0.5, 0, y + 0.5 - (y1 - r)); const d = Math.hypot(dx, dy); if (d <= r) set(x, y, ...c); else if (d < r + 1) set(x, y, c[0], c[1], c[2], Math.round((c[3] ?? 255) * (r + 1 - d))); } },
  };
}

/** App icon: dark rounded square, orange/blue crosshair. */
export function drawIcon(size, { maskable = false } = {}) {
  const cv = makeCanvas(size, size);
  const pad = maskable ? 0 : Math.round(size * 0.06);
  cv.roundRect(pad, pad, size - pad, size - pad, maskable ? 0 : Math.round(size * 0.2), [21, 26, 34, 255]);
  const cx = size / 2, cy = size / 2;
  const rr = size * 0.3;
  cv.ring(cx, cy, rr, size * 0.06, [233, 160, 48, 255]);
  const t = size * 0.055, gap = size * 0.1, len = size * 0.17;
  const orange = [233, 160, 48, 255];
  cv.fillRect(cx - t / 2, cy - gap - len, cx + t / 2, cy - gap, orange);
  cv.fillRect(cx - t / 2, cy + gap, cx + t / 2, cy + gap + len, orange);
  cv.fillRect(cx - gap - len, cy - t / 2, cx - gap, cy + t / 2, orange);
  cv.fillRect(cx + gap, cy - t / 2, cx + gap + len, cy + t / 2, orange);
  cv.fillCircle(cx, cy, size * 0.035, [96, 170, 255, 255]);
  return encodePNG(size, size, cv.px);
}
