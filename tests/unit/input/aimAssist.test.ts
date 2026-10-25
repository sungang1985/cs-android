import { describe, it, expect } from 'vitest';
import { applyAimAssist, autoFireStep, autoReloadStep, createAutoState, AUTO_RELOAD_TICKS, AUTO_RELOAD_RETRY_TICKS } from '@/input/aimAssist';
import { DEG, v3, yawFromDir } from '@/core/math';
import { WEAPON_INDEX, type AimCandidate } from '@/sim/state';
import { makeLocal } from './helpers';

const eye = v3(0, 1.65, 0);
const look = { yaw: 0, pitch: 0 };
/** A target 10 m north whose chest centre is `deg` degrees to the right of the crosshair (body radius ≈ 2.0°). */
function target(deg: number, vel = v3()): AimCandidate { return { id: 9, chest: v3(10 * Math.tan(deg * DEG), 1.65, -10), radius: 0.35, vel }; }
const body = Math.atan(0.35 / 10) / DEG; // ≈ 2.0°
const d = { yaw: 0.01, pitch: 0.004 };

describe('applyAimAssist (§7.5)', () => {
  it('is the identity when Off or without (LOS-checked) candidates', () => {
    expect(applyAimAssist(d, look, eye, [target(1)], 0, 1 / 60, true, false)).toEqual(d);
    expect(applyAimAssist(d, look, eye, [], 3, 1 / 60, true, true)).toEqual(d);
  });
  it('friction multiplies the delta inside the level radius only', () => {
    const near = (lvl: 1 | 2 | 3, edgeDeg: number) => applyAimAssist(d, look, eye, [target(body + edgeDeg)], lvl, 0, true, false).yaw / d.yaw;
    expect(near(1, 1.9)).toBeCloseTo(0.75); expect(near(1, 2.2)).toBeCloseTo(1);
    expect(near(2, 2.4)).toBeCloseTo(0.60); expect(near(2, 2.7)).toBeCloseTo(1);
    expect(near(3, 2.9)).toBeCloseTo(0.50); expect(near(3, 3.2)).toBeCloseTo(1);
    expect(near(2, 0)).toBeCloseTo(0.60); // on the body
  });
  it('preview (dt = 0) applies friction only, no magnetism', () => {
    const r = applyAimAssist({ yaw: 0, pitch: 0 }, look, eye, [target(body + 1)], 3, 0, true, true);
    expect(r).toEqual({ yaw: 0, pitch: 0 });
  });
  it('Medium magnetism ≤ 1.5°/s toward the chest, only while dragging and within 4°', () => {
    const c = [target(body + 3)];
    let l = { ...look };
    for (let i = 0; i < 60; i++) { const r = applyAimAssist({ yaw: 0, pitch: 0 }, l, eye, c, 2, 1 / 60, true, false); l = { yaw: l.yaw + r.yaw, pitch: l.pitch + r.pitch }; }
    expect(l.yaw).toBeLessThan(0); // the target is to the right (negative yaw)
    expect(Math.abs(l.yaw) / DEG).toBeLessThanOrEqual(1.5 + 1e-6);
    expect(Math.abs(l.yaw) / DEG).toBeGreaterThan(1.4);
    expect(applyAimAssist({ yaw: 0, pitch: 0 }, look, eye, c, 2, 1 / 60, false, true)).toEqual({ yaw: 0, pitch: 0 });
    expect(applyAimAssist({ yaw: 0, pitch: 0 }, look, eye, [target(body + 4.5)], 2, 1 / 60, true, false)).toEqual({ yaw: 0, pitch: 0 });
    expect(applyAimAssist({ yaw: 0, pitch: 0 }, look, eye, c, 1, 1 / 60, true, false)).toEqual({ yaw: 0, pitch: 0 }); // Low: none
  });
  it('magnetism never overshoots the chest centre', () => {
    const c = [target(0.01)];
    const r = applyAimAssist({ yaw: 0, pitch: 0 }, look, eye, c, 3, 1, true, false);
    expect(Math.abs(r.yaw) / DEG).toBeLessThanOrEqual(0.0101);
  });
  it('High: ≤ 3°/s while strafing (no drag) within 5°, plus 60 % of the target angular velocity', () => {
    const still = applyAimAssist({ yaw: 0, pitch: 0 }, look, eye, [target(body + 4)], 3, 1 / 60, false, true);
    expect(Math.abs(still.yaw) / DEG).toBeCloseTo(3 / 60, 4);
    const t = target(0); // dead centre, moving east at 5 m/s at 10 m → ≈ 28.6°/s to the right
    t.vel = v3(5, 0, 0);
    const r = applyAimAssist({ yaw: 0, pitch: 0 }, look, eye, [t], 3, 1 / 60, true, false);
    const omega = (yawFromDir(v3(0.5, 0, -10)) - yawFromDir(v3(0, 0, -10))) / 0.1; // rad/s
    expect(r.yaw).toBeCloseTo(0.6 * omega / 60, 5);
    // Medium does not compensate target velocity
    expect(applyAimAssist({ yaw: 0, pitch: 0 }, look, eye, [t], 2, 1 / 60, true, false).yaw).toBeCloseTo(0, 6);
  });
  it('picks the candidate nearest to the crosshair', () => {
    const r = applyAimAssist(d, look, eye, [target(30), target(body + 1)], 1, 0, true, false);
    expect(r.yaw / d.yaw).toBeCloseTo(0.75);
  });
});

describe('auto-fire / auto-reload', () => {
  const idx = (id: string) => WEAPON_INDEX.indexOf(id as never);
  it('fires after 6 consecutive enemy-on-crosshair samples; auto weapons hold FIRE', () => {
    const st = createAutoState(); const l = makeLocal({ weapon: idx('ak47'), crosshairTarget: 1 });
    const out = Array.from({ length: 8 }, () => autoFireStep(st, l, true));
    expect(out).toEqual([false, false, false, false, false, true, true, true]);
    l.crosshairTarget = 2; expect(autoFireStep(st, l, true)).toBe(false);
    l.crosshairTarget = 1; expect(autoFireStep(st, l, true)).toBe(false); // streak restarted
    expect(autoFireStep(createAutoState(), l, false)).toBe(false);
  });
  it('semi-autos are pulsed at 70 % of the max RPM', () => {
    const st = createAutoState(); const l = makeLocal({ weapon: idx('usp'), crosshairTarget: 1 });
    let shots = 0, prev = false, edges = 0;
    for (let i = 0; i < 600 + 5; i++) { const f = autoFireStep(st, l, true); if (f) shots++; if (f && !prev) edges++; prev = f; }
    expect(edges).toBe(shots); // every FIRE tick is a press edge
    expect(shots).toBeGreaterThanOrEqual(40); expect(shots).toBeLessThanOrEqual(42); // 350 rpm · 0.7 = 245/min ≈ 40.8 per 10 s
  });
  it('is disabled for the knife and the unscoped AWP', () => {
    const st = createAutoState();
    const knife = makeLocal({ weapon: idx('knife'), crosshairTarget: 1 });
    for (let i = 0; i < 20; i++) expect(autoFireStep(st, knife, true)).toBe(false);
    const awp = makeLocal({ weapon: idx('awp'), crosshairTarget: 1, scoped: 0 });
    const st2 = createAutoState();
    for (let i = 0; i < 20; i++) expect(autoFireStep(st2, awp, true)).toBe(false);
    awp.scoped = 1;
    let any = false; for (let i = 0; i < 20; i++) any = autoFireStep(st2, awp, true) || any;
    expect(any).toBe(true);
  });
  it('auto-reload: empty mag, reserve left and no candidates for 0.8 s → RELOAD once (retried every 4 s)', () => {
    const st = createAutoState(); const l = makeLocal({ mag: 0, reserve: 24 });
    const fired: number[] = [];
    for (let i = 1; i <= AUTO_RELOAD_TICKS + AUTO_RELOAD_RETRY_TICKS; i++) if (autoReloadStep(st, l, 0, true)) fired.push(i);
    expect(fired).toEqual([AUTO_RELOAD_TICKS, AUTO_RELOAD_TICKS + AUTO_RELOAD_RETRY_TICKS]);
    const st2 = createAutoState();
    for (let i = 0; i < 100; i++) expect(autoReloadStep(st2, l, 1, true)).toBe(false); // enemies in view
    for (let i = 0; i < 100; i++) expect(autoReloadStep(createAutoState(), makeLocal({ mag: 0, reserve: 0 }), 0, true)).toBe(false);
    for (let i = 0; i < 100; i++) expect(autoReloadStep(st2, l, 0, false)).toBe(false);
  });
});
