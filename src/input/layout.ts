/**
 * Touch layout geometry (§7.1, §7.2): percent/vh → CSS px, left-handed mirroring, the scale setting, hit discs
 * with their 3 vh margins and the pointer-ownership order (buttons → joystick zone → look zone). Pure: the
 * viewport is passed in, so it is testable with a fake 851 × 393 screen.
 */
import type { ControlId, TouchLayout } from '../settings/types';

/** The rect the controls are laid out in: the UI root inset by the safe area (CSS px, client coordinates). */
export interface Viewport { left: number; top: number; width: number; height: number }

export interface ControlGeom {
  id: ControlId;
  shape: 'circle' | 'pill';
  /** Centre in client px. */
  cx: number; cy: number;
  /** Half extents in px (circle: hw = hh = radius). */
  hw: number; hh: number;
  /** Hit margin in px (3 vh). */
  margin: number;
  /** Fire-R's hit area extends horizontally to the nearest screen edge: +1 right, −1 left, 0 none. */
  edge: -1 | 0 | 1;
}

export type Zone = 'joystick' | 'look' | 'inert';

/** Buttons the hit test considers (the joystick entry is the floating zone's anchor, not a button). */
export const BUTTON_IDS: readonly ControlId[] = ['fireR', 'fireL', 'jump', 'crouch', 'reload', 'switch', 'scope', 'grenade', 'grenadeSelect', 'use', 'buy', 'pause'];
/** Pill widths in % of the viewport width (§7.2); their `size` is the height in vh. */
export const PILL_WIDTH_PCT: Partial<Record<ControlId, number>> = { use: 16, buy: 18 };
export const HIT_MARGIN_VH = 3;
/** Joystick zone x < 45 %, y > 25 %; the band above it (x < 45 %, y < 25 %) is inert (HUD). */
export const ZONE_SPLIT_X = 45, ZONE_SPLIT_Y = 25;
/** Joystick proportions relative to the ring diameter (ring 24 vh, knob 10 vh, max travel 8 vh). */
export const JOY_KNOB_RATIO = 10 / 24, JOY_TRAVEL_RATIO = 8 / 24;

export function vh(vp: Viewport): number { return vp.height / 100; }

/** Mirrors an x percentage when left-handed. */
export function mirrorX(xPct: number, leftHanded: boolean): number { return leftHanded ? 100 - xPct : xPct; }

export function computeGeometry(layout: TouchLayout, vp: Viewport): Record<ControlId, ControlGeom> {
  const out = {} as Record<ControlId, ControlGeom>;
  const u = vh(vp), s = layout.scale;
  for (const id of Object.keys(layout.controls) as ControlId[]) {
    const c = layout.controls[id];
    const xPct = mirrorX(c.x, layout.leftHanded);
    const cx = vp.left + (xPct / 100) * vp.width, cy = vp.top + (c.y / 100) * vp.height;
    const pillW = PILL_WIDTH_PCT[id];
    const shape = pillW !== undefined ? 'pill' : 'circle';
    const hh = (c.size * u * s) / 2;
    const hw = pillW !== undefined ? ((pillW / 100) * vp.width * s) / 2 : hh;
    const edge: -1 | 0 | 1 = id === 'fireR' ? (xPct >= 50 ? 1 : -1) : 0;
    out[id] = { id, shape, cx, cy, hw, hh, margin: HIT_MARGIN_VH * u, edge };
  }
  return out;
}

/** True when (x, y) is inside the control's hit area (visual + margin, Fire-R extended to the edge). */
export function insideHit(g: ControlGeom, x: number, y: number): boolean {
  const dx = x - g.cx, dy = y - g.cy;
  if (g.shape === 'pill') return Math.abs(dx) <= g.hw + g.margin && Math.abs(dy) <= g.hh + g.margin;
  const r = g.hw + g.margin;
  if (dx * dx + dy * dy <= r * r) return true;
  if (g.edge !== 0 && Math.abs(dy) <= r && Math.sign(dx) === g.edge) return true;
  return false;
}

/** Ownership step 1: the visible button whose hit area contains the point; overlapping margins → nearest centre. */
export function hitTest(geom: Record<ControlId, ControlGeom>, visible: (id: ControlId) => boolean, x: number, y: number): ControlId | null {
  let best: ControlId | null = null, bestD = Infinity;
  for (const id of BUTTON_IDS) {
    const g = geom[id];
    if (!g || !visible(id) || !insideHit(g, x, y)) continue;
    const d = Math.hypot(x - g.cx, y - g.cy);
    if (d < bestD) { bestD = d; best = id; }
  }
  return best;
}

/** Ownership steps 2–3: joystick zone, inert HUD band or look zone (mirrored when left-handed). */
export function zoneAt(layout: TouchLayout, vp: Viewport, x: number, y: number): Zone {
  const xPct = mirrorX(((x - vp.left) / Math.max(1, vp.width)) * 100, layout.leftHanded);
  const yPct = ((y - vp.top) / Math.max(1, vp.height)) * 100;
  if (xPct < ZONE_SPLIT_X) return yPct > ZONE_SPLIT_Y ? 'joystick' : 'inert';
  return 'look';
}

/** Floating joystick sizes in px (scaled by the joystick entry's size and the layout scale). */
export function joystickMetrics(layout: TouchLayout, vp: Viewport): { ringR: number; knobR: number; maxTravel: number } {
  const ring = layout.controls.joystick.size * vh(vp) * layout.scale;
  return { ringR: ring / 2, knobR: (ring * JOY_KNOB_RATIO) / 2, maxTravel: ring * JOY_TRAVEL_RATIO };
}

/** Viewport of an element (falls back to the window when it has no layout box, e.g. in jsdom). */
export function viewportOf(el: Element | null): Viewport {
  const r = el?.getBoundingClientRect();
  if (r && r.width > 0 && r.height > 0) return { left: r.left, top: r.top, width: r.width, height: r.height };
  return { left: 0, top: 0, width: window.innerWidth || 851, height: window.innerHeight || 393 };
}
