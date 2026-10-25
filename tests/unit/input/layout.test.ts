import { describe, it, expect } from 'vitest';
import { computeGeometry, hitTest, zoneAt, insideHit, joystickMetrics, BUTTON_IDS, type Viewport } from '@/input/layout';
import { joystickVector, FloatingJoystick, JOY_WALK_MAG } from '@/input/joystick';
import { cloneLayout } from '@/settings/types';

const VP: Viewport = { left: 0, top: 0, width: 851, height: 393 };
const all = () => true;

describe('layout geometry (percent/vh → px)', () => {
  it('places Fire-R at (90 %, 72 %) with ⌀ 18 vh and a 3 vh margin', () => {
    const g = computeGeometry(cloneLayout(), VP).fireR;
    expect(g.cx).toBeCloseTo(765.9, 1); expect(g.cy).toBeCloseTo(282.96, 1);
    expect(g.hw).toBeCloseTo(9 * 3.93, 2); expect(g.margin).toBeCloseTo(3 * 3.93, 2);
    expect(g.edge).toBe(1);
  });
  it('honours the safe-area inset viewport origin', () => {
    const g = computeGeometry(cloneLayout(), { left: 30, top: 0, width: 800, height: 393 }).jump;
    expect(g.cx).toBeCloseTo(30 + 0.78 * 800, 5);
  });
  it('pills are 16 % / 18 % wide and 8 vh tall', () => {
    const g = computeGeometry(cloneLayout(), VP);
    expect(g.use.shape).toBe('pill'); expect(g.use.hw * 2).toBeCloseTo(0.16 * 851, 5); expect(g.use.hh * 2).toBeCloseTo(8 * 3.93, 5);
    expect(g.buy.hw * 2).toBeCloseTo(0.18 * 851, 5);
  });
  it('scale multiplies sizes but not positions; left-handed mirrors every x', () => {
    const l = cloneLayout(); l.scale = 1.2; l.leftHanded = true;
    const g = computeGeometry(l, VP);
    expect(g.jump.hw).toBeCloseTo(5 * 3.93 * 1.2, 5);
    expect(g.jump.cx).toBeCloseTo(0.22 * 851, 5);
    expect(g.fireR.edge).toBe(-1);
  });
  it('no two hit discs overlap beyond their margins at 851 × 393 (§7.2 check)', () => {
    const g = computeGeometry(cloneLayout(), VP);
    const ids = BUTTON_IDS.filter((id) => g[id].shape === 'circle');
    for (const a of ids) for (const b of ids) {
      if (a >= b) continue;
      const d = Math.hypot(g[a].cx - g[b].cx, g[a].cy - g[b].cy);
      expect(d, `${a} vs ${b}`).toBeGreaterThan(g[a].hw + g[b].hw);
    }
  });
});

describe('pointer ownership', () => {
  const l = cloneLayout();
  const g = computeGeometry(l, VP);
  it('buttons win, including their margin; the nearest centre resolves overlapping margins', () => {
    expect(hitTest(g, all, g.jump.cx, g.jump.cy)).toBe('jump');
    expect(hitTest(g, all, g.jump.cx + g.jump.hw + g.jump.margin * 0.9, g.jump.cy)).toBe('jump');
    // between Switch (69, 56) and Reload (69, 72): margins overlap in y → nearest centre
    const yMid = (g.switch.cy + g.reload.cy) / 2;
    expect(hitTest(g, all, g.switch.cx, yMid - 2)).toBe('switch');
    expect(hitTest(g, all, g.switch.cx, yMid + 2)).toBe('reload');
  });
  it('hidden controls are not hit-testable', () => {
    expect(hitTest(g, (id) => id !== 'scope', g.scope.cx, g.scope.cy)).toBeNull();
  });
  it('Fire-R hit area extends to the screen edge', () => {
    const r = g.fireR.hw + g.fireR.margin;
    expect(insideHit(g.fireR, 850, g.fireR.cy + r * 0.9)).toBe(true);
    expect(insideHit(g.fireL, 0, g.fireL.cy + (g.fireL.hw + g.fireL.margin) * 0.9)).toBe(false);
  });
  it('zones: joystick x < 45 %, y > 25 %; inert top-left band; look elsewhere; mirrored when left-handed', () => {
    expect(zoneAt(l, VP, 0.15 * 851, 0.7 * 393)).toBe('joystick');
    expect(zoneAt(l, VP, 0.15 * 851, 0.1 * 393)).toBe('inert');
    expect(zoneAt(l, VP, 0.7 * 851, 0.4 * 393)).toBe('look');
    expect(zoneAt(l, VP, 0.7 * 851, 0.1 * 393)).toBe('look');
    const lh = cloneLayout(); lh.leftHanded = true;
    expect(zoneAt(lh, VP, 0.85 * 851, 0.7 * 393)).toBe('joystick');
    expect(zoneAt(lh, VP, 0.15 * 851, 0.7 * 393)).toBe('look');
  });
  it('joystick metrics: ring ⌀ 24 vh, knob ⌀ 10 vh, travel 8 vh', () => {
    const m = joystickMetrics(l, VP);
    expect(m.ringR * 2).toBeCloseTo(24 * 3.93, 5); expect(m.knobR * 2).toBeCloseTo(10 * 3.93, 5); expect(m.maxTravel).toBeCloseTo(8 * 3.93, 5);
  });
});

describe('floating joystick', () => {
  const T = 40;
  it('dead zone 12 % → no movement', () => {
    expect(joystickVector(0.1 * T, 0, T)).toMatchObject({ moveX: 0, moveZ: 0 });
  });
  it('walk band 12–75 % → |move| = 0.6; beyond → 1; direction is a unit vector', () => {
    const w = joystickVector(0, -0.5 * T, T);
    expect(w.moveZ).toBeCloseTo(JOY_WALK_MAG); expect(w.moveX).toBeCloseTo(0);
    const r = joystickVector(0.9 * T * Math.SQRT1_2, 0.9 * T * Math.SQRT1_2, T);
    expect(Math.hypot(r.moveX, r.moveZ)).toBeCloseTo(1); expect(r.moveX).toBeGreaterThan(0); expect(r.moveZ).toBeLessThan(0);
    expect(Math.hypot(joystickVector(0.76 * T, 0, T).moveX, 0)).toBeCloseTo(1);
  });
  it('knob is clamped to the max travel', () => {
    const o = joystickVector(3 * T, 0, T);
    expect(o.knobX).toBeCloseTo(T); expect(o.travel).toBe(1);
  });
  it('floats: the origin is where the thumb lands', () => {
    const j = new FloatingJoystick();
    j.start(5, 100, 300); j.move(100, 300 - T);
    expect(j.output(T).moveZ).toBeCloseTo(1);
    j.end(); expect(j.output(T).moveZ).toBe(0);
  });
});
