/**
 * HUD / buy-menu icons (§10.1 `icons`): Canvas-path silhouettes in a 64-unit box (side view, muzzle → right).
 * `paintIcon` is pure (Ctx2D); `iconDataUrl(kind)` renders a cached PNG data URL — the UI lane may reuse it:
 *   import { iconDataUrl } from '../render/textures/icons';  img.src = iconDataUrl('ak47');
 */
import type { WeaponId } from '../../sim/state';
import type { Ctx2D } from './ctx';

export type IconKind = WeaponId | 'c4' | 'kit' | 'helmet' | 'kevlar' | 'skull';
export const ICON_KINDS: readonly IconKind[] = ['knife', 'glock', 'usp', 'deagle', 'mp5', 'ak47', 'm4a4', 'awp', 'he', 'flash', 'c4', 'kit', 'helmet', 'kevlar', 'skull'];

type Shape = { p: number[] } | { c: [number, number, number] } | { hole: [number, number, number] };
const R = (x: number, y: number, w: number, h: number): Shape => ({ p: [x, y, x + w, y, x + w, y + h, x, y + h] });

const SHAPES: Record<IconKind, Shape[]> = {
  knife: [{ p: [6, 34, 22, 30, 24, 38, 6, 40] }, { p: [24, 31, 54, 31, 60, 33, 52, 37, 24, 37] }, R(22, 28, 3, 13)],
  glock: [R(14, 22, 36, 7), R(16, 29, 32, 5), { p: [18, 33, 28, 33, 26, 50, 16, 50] }, { p: [28, 33, 34, 33, 34, 38, 28, 40] }],
  usp: [R(8, 23, 30, 7), R(10, 30, 26, 4), R(38, 23.5, 20, 6), { p: [11, 33, 20, 33, 18, 50, 9, 50] }, { p: [20, 33, 26, 33, 26, 38, 20, 40] }],
  deagle: [R(10, 20, 44, 9), R(12, 29, 38, 5), { p: [14, 33, 25, 33, 22, 52, 11, 52] }, { p: [25, 33, 32, 33, 32, 39, 25, 41] }],
  mp5: [R(14, 24, 30, 8), R(44, 25, 16, 5), { p: [30, 32, 35, 32, 37, 46, 32, 47] }, { p: [20, 32, 26, 32, 24, 42, 18, 42] }, { p: [2, 24, 14, 25, 14, 30, 4, 34] }],
  ak47: [R(16, 25, 26, 6), R(42, 26, 18, 3), R(40, 22, 14, 3), { p: [30, 31, 35, 31, 39, 44, 34, 46] }, { p: [22, 31, 27, 31, 25, 40, 20, 40] }, { p: [2, 26, 16, 25, 16, 31, 4, 37] }],
  m4a4: [R(14, 24, 28, 7), R(42, 25.5, 20, 3), R(20, 19, 16, 3), R(24, 21, 3, 3), R(32, 21, 3, 3), { p: [30, 31, 35, 31, 35, 44, 30, 44] }, { p: [20, 31, 25, 31, 23, 40, 18, 40] }, { p: [2, 25, 14, 25, 14, 30, 3, 33] }],
  awp: [R(16, 26, 22, 7), R(38, 27.5, 24, 3), R(20, 19, 18, 5), R(22, 24, 3, 2), R(33, 24, 3, 2), { p: [28, 33, 32, 33, 32, 40, 28, 40] }, { p: [1, 26, 16, 26, 16, 33, 12, 33, 8, 38, 2, 38] }],
  he: [{ c: [30, 38, 13] }, R(26, 17, 8, 9), { p: [34, 18, 44, 24, 42, 27, 34, 24] }],
  flash: [R(22, 22, 20, 30), R(25, 15, 14, 7), { p: [39, 16, 48, 22, 46, 25, 39, 21] }],
  c4: [R(8, 22, 48, 22), { hole: [20, 33, 4] }, R(30, 26, 20, 3), R(30, 32, 20, 3), R(30, 38, 20, 3)],
  kit: [R(10, 28, 44, 18), R(24, 20, 16, 4), R(24, 20, 4, 9), R(36, 20, 4, 9)],
  helmet: [{ p: [10, 42, 12, 30, 20, 20, 32, 17, 44, 20, 52, 30, 54, 42, 58, 44, 6, 44] }],
  kevlar: [{ p: [16, 12, 24, 12, 28, 20, 36, 20, 40, 12, 48, 12, 52, 26, 50, 54, 14, 54, 12, 26] }],
  skull: [{ c: [32, 28, 17] }, R(22, 38, 20, 12), { hole: [25, 28, 5] }, { hole: [39, 28, 5] }, R(26, 46, 2, 4), R(31, 46, 2, 4), R(36, 46, 2, 4)],
};

/** Pure: draws the silhouette of `kind` into a size × size box. Holes are painted in `holeColor`. */
export function paintIcon(kind: IconKind, size: number, ctx: Ctx2D, color = '#ffffff', holeColor = 'rgba(0,0,0,0.85)'): void {
  const k = size / 64;
  ctx.save();
  for (const s of SHAPES[kind]) {
    ctx.beginPath();
    if ('p' in s) { ctx.moveTo(s.p[0] * k, s.p[1] * k); for (let i = 2; i < s.p.length; i += 2) ctx.lineTo(s.p[i] * k, s.p[i + 1] * k); ctx.closePath(); ctx.fillStyle = color; }
    else if ('c' in s) { ctx.arc(s.c[0] * k, s.c[1] * k, s.c[2] * k, 0, Math.PI * 2); ctx.fillStyle = color; }
    else { ctx.arc(s.hole[0] * k, s.hole[1] * k, s.hole[2] * k, 0, Math.PI * 2); ctx.fillStyle = holeColor; }
    ctx.fill();
  }
  ctx.restore();
}

const iconCache = new Map<string, string>();
/** PNG data URL of an icon (cached per kind/size/colour). Browser only. */
export function iconDataUrl(kind: IconKind, size = 64, color = '#ffffff'): string {
  const key = `${kind}|${size}|${color}`;
  const hit = iconCache.get(key); if (hit) return hit;
  const canvas = document.createElement('canvas'); canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) paintIcon(kind, size, ctx, color);
  const url = canvas.toDataURL('image/png');
  iconCache.set(key, url);
  return url;
}
