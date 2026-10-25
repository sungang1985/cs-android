/** Shared painting helpers for the procedural texture recipes (pure: Ctx2D + Rng only, no DOM/three). */
import type { Rng } from '../../core/rng';
import type { Ctx2D } from './ctx';

export type RGB = [number, number, number];

export function hexToRgb(hex: string): RGB {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const c8 = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
export function rgb(c: RGB, d = 0): string { return `rgb(${c8(c[0] + d)},${c8(c[1] + d)},${c8(c[2] + d)})`; }
export function rgba(c: RGB, a: number): string { return `rgba(${c8(c[0])},${c8(c[1])},${c8(c[2])},${Math.round(a * 1000) / 1000})`; }

/** Feature scale: recipes are authored at 512 px; Low (256) halves every measurement. */
export function px(v: number, size: number): number { return Math.max(1, Math.round((v * size) / 512)); }

export function fillBase(ctx: Ctx2D, size: number, base: RGB): void { ctx.globalAlpha = 1; ctx.fillStyle = rgb(base); ctx.fillRect(0, 0, size, size); }

/**
 * Value noise as translucent black/white overlays: octaves of [cellPx, amplitude(0–255)]. Coarse octaves
 * (≥ 16 px) are soft radial blobs (wrapped across the edges so the texture still tiles); fine ones are blocks
 * (grain). Cell sizes divide the texture.
 */
export function valueNoise(ctx: Ctx2D, size: number, rng: Rng, octaves: [number, number][]): void {
  for (const [cellPx, amp] of octaves) {
    const cell = px(cellPx, size);
    const n = Math.max(1, Math.round(size / cell)); const w = size / n;
    const soft = cellPx >= 16;
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const d = rng.range(-amp, amp);
      const a = Math.min(1, Math.abs(d) / 128);
      if (!soft) { ctx.fillStyle = d > 0 ? '#ffffff' : '#000000'; ctx.globalAlpha = a; ctx.fillRect(x * w, y * w, w, w); continue; }
      const cx = (x + 0.5) * w, cy = (y + 0.5) * w, r = w * 0.95, c = d > 0 ? '255,255,255' : '0,0,0';
      ctx.globalAlpha = 1;
      const xs = [cx], ys = [cy];
      if (cx - r < 0) xs.push(cx + size); else if (cx + r > size) xs.push(cx - size);
      if (cy - r < 0) ys.push(cy + size); else if (cy + r > size) ys.push(cy - size);
      for (const bx of xs) for (const by of ys) radialBlob(ctx, bx, by, r, `rgba(${c},${(a * 1.6).toFixed(3)})`, `rgba(${c},0)`);
    }
  }
  ctx.globalAlpha = 1;
}

export function speckles(ctx: Ctx2D, size: number, rng: Rng, count: number, dark = '#2a2b2d', light = '#c8c8c8'): void {
  for (let i = 0; i < count; i++) {
    const s = px(rng.range(2, 5), size);
    ctx.fillStyle = rng.chance(0.6) ? dark : light;
    ctx.globalAlpha = rng.range(0.25, 0.55);
    ctx.fillRect(rng.range(0, size - s), rng.range(0, size - s), s, s);
  }
  ctx.globalAlpha = 1;
}

/** Random-walk hairline polylines. */
export function cracks(ctx: Ctx2D, size: number, rng: Rng, count: number, color: string, alpha: number): void {
  ctx.strokeStyle = color; ctx.globalAlpha = alpha; ctx.lineWidth = px(1, size);
  for (let i = 0; i < count; i++) {
    let x = rng.range(0.1, 0.9) * size, y = rng.range(0.1, 0.9) * size, a = rng.range(0, Math.PI * 2);
    ctx.beginPath(); ctx.moveTo(x, y);
    const steps = rng.int(5, 10);
    for (let s = 0; s < steps; s++) {
      a += rng.range(-0.8, 0.8); const len = px(rng.range(6, 18), size);
      x += Math.cos(a) * len; y += Math.sin(a) * len; ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

/** 45° stripes over a horizontal band [y0, y0+h); `period` is snapped so the band tiles horizontally. */
export function hazardBand(ctx: Ctx2D, size: number, y0: number, h: number, periodPx: number, a = '#d8b400', b = '#2a2a2a'): void {
  ctx.fillStyle = b; ctx.fillRect(0, y0, size, h);
  const n = Math.max(1, Math.round(size / px(periodPx, size))); const p = size / n;
  ctx.fillStyle = a;
  for (let i = -1; i <= n; i++) {
    const x = i * p;
    ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x + p / 2, y0); ctx.lineTo(x + p / 2 + h, y0 + h); ctx.lineTo(x + h, y0 + h); ctx.closePath(); ctx.fill();
  }
}

/** Full-texture diagonal stripes (period divides the size → tiles both ways). */
export function diagonalStripes(ctx: Ctx2D, size: number, periodPx: number, color: string, alpha: number): void {
  const n = Math.max(1, Math.round(size / px(periodPx, size))); const p = size / n;
  ctx.fillStyle = color; ctx.globalAlpha = alpha;
  for (let i = -n; i <= n; i++) {
    const x = i * p;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x + p / 2, 0); ctx.lineTo(x + p / 2 + size, size); ctx.lineTo(x + size, size); ctx.closePath(); ctx.fill();
  }
  ctx.globalAlpha = 1;
}

/** Soft radial blob (stains, rust, glows). */
export function radialBlob(ctx: Ctx2D, x: number, y: number, r: number, inner: string, outer: string): void {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, inner); g.addColorStop(1, outer);
  ctx.fillStyle = g; ctx.fillRect(x - r, y - r, 2 * r, 2 * r);
}

/** Rounded rectangle path (arcs + lines only, within the Ctx2D subset). */
export function roundRectPath(ctx: Ctx2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y); ctx.arc(x + w - rr, y + rr, rr, -Math.PI / 2, 0);
  ctx.lineTo(x + w, y + h - rr); ctx.arc(x + w - rr, y + h - rr, rr, 0, Math.PI / 2);
  ctx.lineTo(x + rr, y + h); ctx.arc(x + rr, y + h - rr, rr, Math.PI / 2, Math.PI);
  ctx.lineTo(x, y + rr); ctx.arc(x + rr, y + rr, rr, Math.PI, Math.PI * 1.5);
  ctx.closePath();
}

/** Wood grain: horizontal sine-noise polylines. */
export function woodGrain(ctx: Ctx2D, size: number, rng: Rng, stepPx: number, alpha: number): void {
  const step = px(stepPx, size);
  ctx.strokeStyle = '#2a1a0a'; ctx.lineWidth = px(1, size); ctx.globalAlpha = alpha;
  for (let y = 0; y < size; y += step) {
    const f = rng.range(0.01, 0.03) * (512 / size), ph = rng.range(0, 6.28), amp = px(rng.range(0.5, 2), size);
    ctx.beginPath(); ctx.moveTo(0, y);
    for (let x = 0; x <= size; x += px(16, size)) ctx.lineTo(x, y + Math.sin(x * f + ph) * amp);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

/** Text with a dark outline drawn as 8 offset copies (strokeText is not in the Ctx2D subset). */
export function outlinedText(ctx: Ctx2D, text: string, x: number, y: number, fill: string, outline: string, w: number): void {
  ctx.fillStyle = outline;
  for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2; ctx.fillText(text, x + Math.cos(a) * w, y + Math.sin(a) * w); }
  ctx.fillStyle = fill; ctx.fillText(text, x, y);
}

export const FONT_STACK = 'system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", Roboto, sans-serif';
