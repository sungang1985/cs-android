/**
 * Weapon/item icons (§8.4): silhouettes drawn with Canvas 2D paths (Path2D from path data in a 120 × 48 box,
 * muzzle to the right), exported as PNG data URLs and cached per (id, colour). Where no 2D canvas exists
 * (jsdom unit tests) the same paths are returned as an SVG data URL so <img src> is never empty.
 */
import type { WeaponId } from '../sim/state';

export type IconId = WeaponId | 'bomb' | 'kit' | 'helmet' | 'kevlar' | 'skull' | 'headshot';

interface Shape { fill: string[]; stroke?: string[]; evenodd?: boolean }
const W = 120, H = 48;

const SHAPES: Record<IconId, Shape> = {
  knife: { fill: ['M6 20 Q3 24 6 28 L38 29 L38 19 Z', 'M38 13 H44 V35 H38 Z', 'M44 19 L100 18 Q112 19 117 23 Q106 29 44 30 Z'] },
  glock: { fill: ['M12 10 H102 V24 H12 Z', 'M12 24 H90 V28 H52 Q48 36 40 32 L36 28 H34 L30 46 H12 L16 28 Z'] },
  usp: { fill: ['M10 11 H84 V24 H10 Z', 'M84 12 H118 V23 H84 Z', 'M10 24 H72 V28 H46 Q42 36 36 32 L32 28 L28 46 H10 L14 28 Z'] },
  deagle: { fill: ['M8 8 H108 V24 H8 Z', 'M8 24 H86 V29 H50 Q46 38 38 33 L34 29 L30 46 H8 L12 29 Z'] },
  mp5: { fill: ['M2 13 H22 V22 L8 26 H2 Z', 'M20 14 H96 V24 H20 Z', 'M96 15 H118 V22 H96 Z', 'M62 24 Q64 36 70 44 L78 42 Q72 34 72 24 Z', 'M36 24 H44 L40 40 H32 Z'] },
  ak47: { fill: ['M2 16 L28 14 L30 24 L4 30 Z', 'M28 13 H78 V23 H28 Z', 'M78 14 H98 V22 H78 Z', 'M98 16 H118 V19 H98 Z', 'M110 12 H113 V16 H110 Z', 'M56 23 Q58 36 66 44 L74 40 Q67 32 66 23 Z', 'M36 23 H44 L40 37 H32 Z'] },
  m4a4: { fill: ['M2 14 H26 V24 L6 28 H2 Z', 'M26 13 H76 V23 H26 Z', 'M40 8 H66 V13 H40 Z', 'M76 13 H100 V22 H76 Z', 'M100 16 H118 V19 H100 Z', 'M54 23 H64 L66 42 H56 Z', 'M34 23 H42 L38 37 H30 Z'] },
  awp: { fill: ['M2 14 L30 13 L32 26 L22 26 Q14 22 8 30 H2 Z', 'M30 15 H74 V24 H30 Z', 'M74 17 H118 V20 H74 Z', 'M36 6 H72 V12 H36 Z', 'M44 12 H48 V15 H44 Z', 'M60 12 H64 V15 H60 Z', 'M52 24 H60 V32 H52 Z', 'M36 24 H42 L40 34 H34 Z'] },
  he: { fill: ['M46 29 A14 14 0 1 0 74 29 A14 14 0 1 0 46 29 Z', 'M54 10 H66 V16 H54 Z', 'M66 10 L76 14 V30 H72 V16 Z'] },
  flash: { fill: ['M48 15 H72 V45 H48 Z', 'M52 9 H68 V15 H52 Z', 'M68 9 L78 13 V33 H74 V15 Z'] },
  bomb: { fill: ['M18 18 H102 V42 H18 Z M28 22 V31 H64 V22 Z'], stroke: ['M72 18 Q80 4 94 18', 'M80 18 Q88 8 98 18'], evenodd: true },
  kit: { fill: ['M28 16 H92 V42 H28 Z M56 21 V26 H51 V32 H56 V37 H64 V32 H69 V26 H64 V21 Z', 'M50 10 H70 V16 H66 V13 H54 V16 H50 Z'], evenodd: true },
  helmet: { fill: ['M28 38 Q28 9 60 9 Q92 9 94 33 L102 38 Z'] },
  kevlar: { fill: ['M38 6 L50 6 Q60 15 70 6 L82 6 L84 21 L92 25 L90 44 L30 44 L28 25 L36 21 Z'] },
  skull: { fill: ['M44 7 Q60 1 76 7 Q87 15 82 30 L76 32 V41 H44 V32 L38 30 Q33 15 44 7 Z M48 21 A5 5 0 1 0 58 21 A5 5 0 1 0 48 21 Z M62 21 A5 5 0 1 0 72 21 A5 5 0 1 0 62 21 Z'], evenodd: true },
  headshot: { fill: ['M52 22 A8 8 0 1 0 68 22 A8 8 0 1 0 52 22 Z'], stroke: ['M60 2 V12', 'M60 32 V42', 'M38 22 H48', 'M72 22 H82', 'M44 22 A16 16 0 1 0 76 22 A16 16 0 1 0 44 22'] },
};

const cache = new Map<string, string>();
let canvasOk: boolean | null = null;

function canDraw(): boolean {
  if (canvasOk !== null) return canvasOk;
  canvasOk = false;
  if (typeof document === 'undefined' || typeof Path2D === 'undefined') return false;
  if (typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent)) return false;
  try { canvasOk = !!document.createElement('canvas').getContext('2d'); } catch { canvasOk = false; }
  return canvasOk;
}

function svgUrl(s: Shape, color: string): string {
  const rule = s.evenodd ? ' fill-rule="evenodd"' : '';
  const fills = s.fill.map((d) => `<path d="${d}" fill="${color}"${rule}/>`).join('');
  const strokes = (s.stroke ?? []).map((d) => `<path d="${d}" fill="none" stroke="${color}" stroke-width="3" stroke-linecap="round"/>`).join('');
  return 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}">${fills}${strokes}</svg>`);
}

/** PNG data URL of the icon silhouette (cached). `scale` = backing-store pixels per box unit. */
export function iconUrl(id: IconId, color = '#F5F5F5', scale = 2): string {
  const key = `${id}|${color}|${scale}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const s = SHAPES[id];
  let url: string;
  if (canDraw()) {
    const c = document.createElement('canvas');
    c.width = W * scale; c.height = H * scale;
    const g = c.getContext('2d')!;
    g.scale(scale, scale);
    g.fillStyle = color; g.strokeStyle = color; g.lineWidth = 3; g.lineCap = 'round';
    // dark outline so silhouettes read on bright scenes (≤ 2 colours per HUD element, §1)
    g.shadowColor = 'rgba(0,0,0,0.85)'; g.shadowBlur = 2;
    for (const d of s.fill) g.fill(new Path2D(d), s.evenodd ? 'evenodd' : 'nonzero');
    for (const d of s.stroke ?? []) g.stroke(new Path2D(d));
    url = c.toDataURL('image/png');
  } else url = svgUrl(s, color);
  cache.set(key, url);
  return url;
}

/** `<img>` for an icon. */
export function iconImg(id: IconId, cls = 'icon', color?: string): HTMLImageElement {
  const img = document.createElement('img');
  img.className = cls; img.alt = ''; img.draggable = false; img.src = iconUrl(id, color);
  img.dataset.icon = id;
  return img;
}

export const ICON_IDS = Object.keys(SHAPES) as IconId[];
