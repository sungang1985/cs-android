/**
 * Procedural textures (§10.1). `paintTexture` is a pure recipe over the minimal Ctx2D subset (tests inject a
 * recording fake); `makeTexture` wraps it in a canvas. Authored at 512 px; Low (256) scales every measurement.
 * Callers pass a fresh `new Rng(1337)` per texture so output is deterministic and hashable.
 */
import type { Rng } from '../../core/rng';
import type { MaterialId } from '../../world/types';
import type { Ctx2D } from './ctx';
import { hexToRgb, rgb, rgba, px, fillBase, valueNoise, speckles, cracks, hazardBand, diagonalStripes, radialBlob, roundRectPath, woodGrain, outlinedText, FONT_STACK, type RGB } from './paint';

export const BASE_COLORS: Record<MaterialId, string> = {
  concrete: '#8d8f93', concrete_base: '#7a7c80', floor: '#4a4d52', floor_stripe: '#5a5a3a', crate_wood: '#9a6b3a', sandbag: '#8b8358', metal: '#6b7078',
  door_frame: '#3f4a6b', ceiling: '#2a2c30', lamp: '#ffffff', site_marker: '#ffd54f', skin_t: '#c8a24a', skin_ct: '#3d6fb5', gun_metal: '#2f3136', wood_stock: '#6b4a2a',
};

/** Every MaterialId, in a fixed order (tests iterate it). */
export const MATERIAL_IDS: readonly MaterialId[] = ['concrete', 'concrete_base', 'floor', 'floor_stripe', 'crate_wood', 'sandbag', 'metal', 'door_frame', 'ceiling', 'lamp', 'site_marker', 'skin_t', 'skin_ct', 'gun_metal', 'wood_stock'];

/** Materials whose texture has an alpha channel (painted onto a transparent canvas). */
export const TRANSPARENT_MATERIALS: ReadonlySet<MaterialId> = new Set<MaterialId>(['site_marker']);

const NOISE: [number, number][] = [[32, 12], [16, 8], [8, 4]];

function concrete(ctx: Ctx2D, size: number, rng: Rng, base: RGB): void {
  fillBase(ctx, size, base);
  valueNoise(ctx, size, rng, NOISE);
  speckles(ctx, size, rng, 40);
  ctx.fillStyle = '#000000'; ctx.globalAlpha = 0.15;
  const seam = px(128, size);
  for (let y = seam; y < size; y += seam) ctx.fillRect(0, y - px(1, size), size, px(2, size));
  ctx.globalAlpha = 1;
  cracks(ctx, size, rng, 8, '#3a3b3d', 0.4);
}

function floor(ctx: Ctx2D, size: number, rng: Rng): void {
  fillBase(ctx, size, hexToRgb(BASE_COLORS.floor));
  valueNoise(ctx, size, rng, NOISE);
  const tile = px(64, size), n = Math.round(size / tile), w = size / n;
  ctx.fillStyle = '#000000';
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (rng.chance(0.06)) { ctx.globalAlpha = 0.12; ctx.fillRect(x * w, y * w, w, w); }
  ctx.globalAlpha = 0.25;
  for (let i = 0; i < n; i++) { ctx.fillRect(i * w, 0, px(1, size), size); ctx.fillRect(0, i * w, size, px(1, size)); }
  ctx.globalAlpha = 1;
  for (let i = 0; i < 3; i++) {
    const r = px(rng.range(30, 60), size);
    radialBlob(ctx, rng.range(r, size - r), rng.range(r, size - r), r, 'rgba(8,8,10,0.35)', 'rgba(8,8,10,0)');
  }
  speckles(ctx, size, rng, 30, '#202224', '#6a6d72');
}

function crate(ctx: Ctx2D, size: number, rng: Rng): void {
  const base = hexToRgb(BASE_COLORS.crate_wood);
  fillBase(ctx, size, base);
  const n = Math.max(1, Math.round(size / px(48, size))), h = size / n;
  for (let i = 0; i < n; i++) { ctx.fillStyle = rgb(base, rng.range(-14, 10)); ctx.fillRect(0, i * h, size, h); }
  woodGrain(ctx, size, rng, 4, 0.1);
  ctx.fillStyle = '#3a2410'; ctx.globalAlpha = 0.8;
  for (let i = 0; i < n; i++) ctx.fillRect(0, i * h, size, px(2, size));
  ctx.globalAlpha = 1;
  // frame boards + diagonal brace (X faces)
  const fb = px(36, size), brace = px(10, size) * 3;
  ctx.fillStyle = '#7a5330';
  ctx.beginPath(); ctx.moveTo(fb, size - fb - brace); ctx.lineTo(size - fb - brace, fb); ctx.lineTo(size - fb, fb); ctx.lineTo(size - fb, fb + brace); ctx.lineTo(fb + brace, size - fb); ctx.lineTo(fb, size - fb); ctx.closePath(); ctx.fill();
  ctx.fillRect(0, 0, size, fb); ctx.fillRect(0, size - fb, size, fb); ctx.fillRect(0, 0, fb, size); ctx.fillRect(size - fb, 0, fb, size);
  ctx.strokeStyle = '#3a2410'; ctx.lineWidth = px(2, size);
  ctx.strokeRect(px(1, size), px(1, size), size - px(2, size), size - px(2, size)); ctx.strokeRect(fb, fb, size - 2 * fb, size - 2 * fb);
  ctx.fillStyle = '#2b2b2b';
  const ni = fb / 2;
  for (const [x, y] of [[ni, ni], [size - ni, ni], [ni, size - ni], [size - ni, size - ni]]) { ctx.beginPath(); ctx.arc(x, y, px(4, size), 0, Math.PI * 2); ctx.fill(); }
  ctx.globalAlpha = 0.3; ctx.fillStyle = '#1a1006'; ctx.textAlign = 'center';
  ctx.font = `bold ${px(54, size)}px ${FONT_STACK}`; ctx.fillText('DEPOT 03', size / 2, size * 0.42);
  ctx.font = `bold ${px(64, size)}px ${FONT_STACK}`; ctx.fillText('货运', size / 2, size * 0.66);
  ctx.globalAlpha = 1;
}

function sandbag(ctx: Ctx2D, size: number, rng: Rng): void {
  const base = hexToRgb(BASE_COLORS.sandbag);
  fillBase(ctx, size, [70, 64, 42]);
  const cols = Math.max(1, Math.round(size / px(64, size))), rows = Math.max(1, Math.round(size / px(28, size)));
  const w = size / cols, h = size / rows, r = h * 0.4, gap = px(2, size);
  for (let row = 0; row < rows; row++) {
    const off = row % 2 ? w / 2 : 0;
    for (let c = -1; c < cols; c++) {
      const x = c * w + off, y = row * h;
      ctx.fillStyle = 'rgba(30,26,16,0.6)'; roundRectPath(ctx, x + gap, y + gap * 2, w - gap, h - gap, r); ctx.fill();
      ctx.fillStyle = rgb(base, rng.range(-12, 10)); roundRectPath(ctx, x + gap, y + gap, w - 2 * gap, h - 2 * gap, r); ctx.fill();
      ctx.fillStyle = 'rgba(255,248,220,0.18)'; ctx.fillRect(x + r, y + gap * 2, w - 2 * r, px(3, size));
      ctx.fillStyle = 'rgba(0,0,0,0.18)'; ctx.fillRect(x + r, y + h - gap * 3, w - 2 * r, px(3, size));
    }
  }
  valueNoise(ctx, size, rng, [[8, 6]]);
}

function metal(ctx: Ctx2D, size: number, rng: Rng): void {
  const base = hexToRgb(BASE_COLORS.metal);
  fillBase(ctx, size, base);
  valueNoise(ctx, size, rng, [[16, 5], [8, 3]]);
  const n = Math.max(1, Math.round(size / px(32, size))), p = size / n, d = px(8, size), o = px(1, size);
  const diamond = (cx: number, cy: number) => { ctx.beginPath(); ctx.moveTo(cx, cy - d); ctx.lineTo(cx + d / 2, cy); ctx.lineTo(cx, cy + d); ctx.lineTo(cx - d / 2, cy); ctx.closePath(); ctx.fill(); };
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const cx = x * p + (y % 2 ? p / 2 : 0) + p / 4, cy = y * p + p / 2;
    ctx.fillStyle = 'rgba(20,22,26,0.55)'; diamond(cx + o, cy + o);
    ctx.fillStyle = 'rgba(220,226,235,0.45)'; diamond(cx - o, cy - o);
    ctx.fillStyle = rgb(base, 6); diamond(cx, cy);
  }
  for (let i = 0; i < 3; i++) { const r = px(rng.range(30, 70), size); radialBlob(ctx, rng.range(r, size - r), rng.range(r, size - r), r, 'rgba(120,60,20,0.25)', 'rgba(120,60,20,0)'); }
}

function doorFrame(ctx: Ctx2D, size: number, rng: Rng): void {
  fillBase(ctx, size, hexToRgb(BASE_COLORS.door_frame));
  valueNoise(ctx, size, rng, [[16, 4]]);
  const b = px(2, size);
  ctx.fillStyle = '#7584ad'; ctx.fillRect(0, 0, size, b); ctx.fillRect(0, 0, b, size);
  ctx.fillStyle = '#232a3e'; ctx.fillRect(0, size - b, size, b); ctx.fillRect(size - b, 0, b, size);
}

function ceiling(ctx: Ctx2D, size: number, rng: Rng): void {
  fillBase(ctx, size, hexToRgb(BASE_COLORS.ceiling));
  valueNoise(ctx, size, rng, [[16, 3]]);
}

function lamp(ctx: Ctx2D, size: number): void {
  ctx.fillStyle = '#6a6a66'; ctx.fillRect(0, 0, size, size);
  const b = px(24, size);
  const g = ctx.createLinearGradient(0, b, 0, size - b);
  g.addColorStop(0, '#e8e2d4'); g.addColorStop(0.5, '#fffaf0'); g.addColorStop(1, '#e8e2d4');
  ctx.fillStyle = g; ctx.fillRect(b, b, size - 2 * b, size - 2 * b);
}

/** 2×2 atlas: TL 'A', TR 'B' (site letters, floor decal + wall sign), BL lamp panel, BR transparent. */
function siteMarker(ctx: Ctx2D, size: number): void {
  const h = size / 2;
  ctx.textAlign = 'center'; ctx.font = `bold ${Math.round(h * 0.82)}px ${FONT_STACK}`;
  outlinedText(ctx, 'A', h / 2, h * 0.8, BASE_COLORS.site_marker, '#1a1a1a', px(4, size));
  outlinedText(ctx, 'B', h * 1.5, h * 0.8, BASE_COLORS.site_marker, '#1a1a1a', px(4, size));
  ctx.save(); ctx.translate(0, h); lamp(ctx, h); ctx.restore();
}

/** 2:1 layout inside the square: left half = front/sides, right half = back (the torso box maps its UVs so). */
function skin(ctx: Ctx2D, size: number, rng: Rng, team: 'T' | 'CT'): void {
  const base = hexToRgb(team === 'T' ? BASE_COLORS.skin_t : BASE_COLORS.skin_ct);
  fillBase(ctx, size, base);
  valueNoise(ctx, size, rng, [[16, 10], [8, 6]]);
  const h = size / 2;
  if (team === 'CT') { ctx.fillStyle = rgb(base, 28); ctx.fillRect(h * 0.18, size * 0.2, h * 0.64, size * 0.5); ctx.fillStyle = rgb(base, -30); ctx.fillRect(h * 0.47, size * 0.2, h * 0.06, size * 0.5); }
  else { ctx.fillStyle = rgb(base, -22); ctx.fillRect(h * 0.25, size * 0.12, h * 0.1, size * 0.5); ctx.fillRect(h * 0.65, size * 0.12, h * 0.1, size * 0.5); }
  ctx.fillStyle = rgb(base, -45); ctx.fillRect(0, size * 0.36, size, size * 0.08);
  ctx.fillStyle = rgba([0, 0, 0], 0.25); ctx.fillRect(h - px(2, size), 0, px(4, size), size);
  if (team === 'CT') { ctx.globalAlpha = 0.65; ctx.fillStyle = '#e8eef8'; ctx.textAlign = 'center'; ctx.font = `bold ${Math.round(h * 0.42)}px ${FONT_STACK}`; ctx.fillText('CT', h * 1.5, size * 0.7); ctx.globalAlpha = 1; }
  else { ctx.fillStyle = rgb(base, -30); ctx.fillRect(h * 1.2, size * 0.55, h * 0.6, size * 0.25); }
}

function gunMetal(ctx: Ctx2D, size: number, rng: Rng): void {
  fillBase(ctx, size, hexToRgb(BASE_COLORS.gun_metal));
  const step = px(2, size);
  for (let y = 0; y < size; y += step) { ctx.fillStyle = rng.chance(0.5) ? '#ffffff' : '#000000'; ctx.globalAlpha = rng.range(0.02, 0.08); ctx.fillRect(0, y, size, step); }
  ctx.globalAlpha = 0.35; ctx.fillStyle = '#9aa0aa'; ctx.fillRect(0, 0, size, px(1, size));
  ctx.globalAlpha = 1;
}

function woodStock(ctx: Ctx2D, size: number, rng: Rng): void {
  fillBase(ctx, size, hexToRgb(BASE_COLORS.wood_stock));
  valueNoise(ctx, size, rng, [[16, 6]]);
  woodGrain(ctx, size, rng, 2, 0.14);
}

/** Pure recipe over a minimal Ctx2D (§11.8). Deterministic for a given (id, size, rng state). */
export function paintTexture(id: MaterialId, size: number, rng: Rng, ctx: Ctx2D): void {
  ctx.globalAlpha = 1;
  switch (id) {
    case 'concrete': concrete(ctx, size, rng, hexToRgb(BASE_COLORS.concrete)); break;
    case 'concrete_base': {
      concrete(ctx, size, rng, hexToRgb(BASE_COLORS.concrete_base));
      const g = ctx.createLinearGradient(0, size, 0, size * 0.8);
      g.addColorStop(0, 'rgba(40,32,22,0.55)'); g.addColorStop(1, 'rgba(40,32,22,0)');
      ctx.fillStyle = g; ctx.fillRect(0, size * 0.8, size, size * 0.2);
      hazardBand(ctx, size, 0, px(24, size), 32);
      ctx.fillStyle = 'rgba(0,0,0,0.4)'; ctx.fillRect(0, px(24, size), size, px(2, size));
      break;
    }
    case 'floor': floor(ctx, size, rng); break;
    case 'floor_stripe': floor(ctx, size, rng); diagonalStripes(ctx, size, 48, '#d8b400', 0.85); break;
    case 'crate_wood': crate(ctx, size, rng); break;
    case 'sandbag': sandbag(ctx, size, rng); break;
    case 'metal': metal(ctx, size, rng); break;
    case 'door_frame': doorFrame(ctx, size, rng); break;
    case 'ceiling': ceiling(ctx, size, rng); break;
    case 'lamp': lamp(ctx, size); break;
    case 'site_marker': siteMarker(ctx, size); break;
    case 'skin_t': skin(ctx, size, rng, 'T'); break;
    case 'skin_ct': skin(ctx, size, rng, 'CT'); break;
    case 'gun_metal': gunMetal(ctx, size, rng); break;
    case 'wood_stock': woodStock(ctx, size, rng); break;
  }
  ctx.globalAlpha = 1;
}

export function makeTexture(id: MaterialId, size: number, rng: Rng): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) paintTexture(id, size, rng, ctx);
  return canvas;
}

export { paintSprite, makeSprite, SPRITE_IDS, SPRITE_SIZE, type SpriteId } from './sprites';
export { paintIcon, iconDataUrl, ICON_KINDS, type IconKind } from './icons';
