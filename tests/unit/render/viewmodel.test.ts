/** Viewmodel / camera motion math (§10.4): springs converge, bob amplitude bounds, phase timings. */
import { describe, it, expect } from 'vitest';
import { DEG } from '../../../src/core/math';
import { ViewmodelMotion, stepSpring, bobOffset, reloadPose, kickFromPattern, Shake, approachFov, bombBlinkInterval, explosionShake, VM, type VmInput, type VmPose } from '../../../src/render/viewmodelMath';

const pose = (): VmPose => ({ x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, magY: 0, slideZ: 0, swapNow: false });
const idle = (dt = 1 / 60, extra: Partial<VmInput> = {}): VmInput => ({ dt, speed: 0, maxSpeed: 4.3, crouch: false, grounded: true, dYaw: 0, dPitch: 0, reloadT: -1, ...extra });

describe('viewmodelMath', () => {
  it('recoil spring (k 160, c 14) converges after a kick', () => {
    const s = { x: 0.03, v: 0 };
    let peak = 0;
    for (let i = 0; i < 120; i++) { stepSpring(s, VM.kick.k, VM.kick.c, 1 / 60); peak = Math.max(peak, Math.abs(s.x)); }
    expect(peak).toBeLessThanOrEqual(0.03 + 1e-9);
    expect(Math.abs(s.x)).toBeLessThan(1e-4);
    expect(Math.abs(s.v)).toBeLessThan(1e-3);
  });
  it('spring result is frame-rate independent (sub-stepped)', () => {
    const a = { x: 1, v: 0 }, b = { x: 1, v: 0 };
    for (let i = 0; i < 30; i++) stepSpring(a, 160, 14, 1 / 30);
    for (let i = 0; i < 120; i++) stepSpring(b, 160, 14, 1 / 120);
    expect(Math.abs(a.x - b.x)).toBeLessThan(1e-3);
  });
  it('kick per shot returns the gun to its rest pose', () => {
    const m = new ViewmodelMotion(); const p = pose();
    const rest = m.update(idle(), pose()); const z0 = rest.z;
    m.onShot(kickFromPattern(0.4)); m.update(idle(), p);
    expect(p.z - z0).toBeGreaterThan(0.02);
    for (let i = 0; i < 180; i++) m.update(idle(), p);
    expect(Math.abs(m.kickZ.x)).toBeLessThan(1e-4);
    expect(Math.abs(m.kickRx.x)).toBeLessThan(1e-4);
  });
  it('kick = P[0].pitch / 0.4, clamped for heavy weapons', () => {
    expect(kickFromPattern(0.4)).toBeCloseTo(1);   // AK
    expect(kickFromPattern(1.2)).toBeCloseTo(3);   // pistols
    expect(kickFromPattern(6)).toBe(VM.kick.maxKick); // AWP
  });
  it('walk bob amplitude stays within 0.012 / 0.008 m', () => {
    let mx = 0, my = 0, minY = Infinity;
    for (let s = 0; s <= 1.0001; s += 0.25) for (let ph = 0; ph < Math.PI * 4; ph += 0.01) {
      const b = bobOffset(ph, s); mx = Math.max(mx, Math.abs(b.x)); my = Math.max(my, b.y); minY = Math.min(minY, b.y);
    }
    expect(mx).toBeLessThanOrEqual(VM.bob.ax + 1e-12); expect(mx).toBeGreaterThan(VM.bob.ax * 0.99);
    expect(my).toBeLessThanOrEqual(VM.bob.ay + 1e-12); expect(minY).toBeGreaterThanOrEqual(0);
  });
  it('running moves the gun by the bob amplitude; crouching halves it; airborne stops it', () => {
    const range = (extra: Partial<VmInput>) => {
      const m = new ViewmodelMotion(), still = new ViewmodelMotion(), p = pose(), q = pose();
      let mx = 0;
      for (let i = 0; i < 600; i++) { m.update(idle(1 / 60, { speed: 4.3, ...extra }), p); still.update(idle(), q); mx = Math.max(mx, Math.abs(p.x - q.x)); }
      return mx;
    };
    const run = range({}), crouch = range({ crouch: true }), air = range({ grounded: false });
    expect(run).toBeLessThanOrEqual(VM.bob.ax + 1e-9); expect(run).toBeGreaterThan(VM.bob.ax * 0.9);
    expect(crouch).toBeLessThanOrEqual(VM.bob.ax / 2 + 1e-9);
    expect(air).toBeLessThan(1e-9);
  });
  it('look sway is clamped to 4° / 3° and decays when the look stops', () => {
    const m = new ViewmodelMotion(), p = pose();
    for (let i = 0; i < 60; i++) m.update(idle(1 / 60, { dYaw: 0.5, dPitch: -0.5 }), p);
    expect(Math.abs(m.swayYaw)).toBeLessThanOrEqual(4 * DEG + 1e-9); expect(Math.abs(m.swayYaw)).toBeGreaterThan(3.9 * DEG);
    expect(Math.abs(m.swayPitch)).toBeLessThanOrEqual(3 * DEG + 1e-9);
    expect(m.swayYaw).toBeLessThan(0); // lags behind a left turn
    for (let i = 0; i < 120; i++) m.update(idle(), p);
    expect(Math.abs(m.swayYaw)).toBeLessThan(1e-4);
  });
  it('land dip recovers (τ 0.12 s)', () => {
    const m = new ViewmodelMotion(), p = pose();
    m.onLand(8); expect(m.land).toBeCloseTo(-0.05);
    for (let i = 0; i < 60; i++) m.update(idle(), p);
    expect(Math.abs(m.land)).toBeLessThan(0.05 * Math.exp(-1 / 0.12) + 1e-6);
  });
  it('reload phases: tilt in, mag drop and return, slide pull, tilt out', () => {
    expect(reloadPose(-1)).toEqual({ tilt: 0, lower: 0, magY: 0, slideZ: 0 });
    expect(reloadPose(0.25).tilt).toBeCloseTo(25 * DEG);
    expect(reloadPose(0.475).magY).toBeCloseTo(-0.15);
    expect(reloadPose(0.7).magY).toBeCloseTo(0);
    expect(reloadPose(0.85).slideZ).toBeCloseTo(0.04);
    expect(reloadPose(1).tilt).toBeCloseTo(0);
    expect(reloadPose(0.1).magY).toBe(0);
  });
  it('weapon switch: swap exactly once at the bottom (0.15 s), done after 0.35 s', () => {
    const m = new ViewmodelMotion(), p = pose();
    m.startSwitch();
    let swaps = 0, swapAt = -1, t = 0;
    for (let i = 0; i < 40; i++) { t += 1 / 60; m.update(idle(), p); if (p.swapNow) { swaps++; swapAt = t; } }
    expect(swaps).toBe(1);
    expect(swapAt).toBeGreaterThanOrEqual(0.15 - 1e-9); expect(swapAt).toBeLessThan(0.15 + 2 / 60);
    expect(m.switching).toBe(false);
  });
  it('knife swing / stab and throw animations finish', () => {
    const m = new ViewmodelMotion(), p = pose();
    m.onKnife(false); for (let i = 0; i < 30; i++) m.update(idle(), p); expect(m.knifeT).toBe(-1);
    m.onKnife(true); let minZ = 0; const base = m.update(idle(), p).z;
    for (let i = 0; i < 40; i++) { m.update(idle(), p); minZ = Math.min(minZ, p.z - base); }
    expect(minZ).toBeLessThan(-0.1); expect(m.knifeT).toBe(-1);
    m.onThrow(); for (let i = 0; i < 60; i++) m.update(idle(), p); expect(m.throwT).toBe(-1);
  });
  it('shake decays to zero after its duration', () => {
    const s = new Shake(), o = { yaw: 0, pitch: 0 };
    s.add(0.4 * DEG, 0.1);
    let mx = 0; for (let i = 0; i < 5; i++) { s.sample(1 / 60, o); mx = Math.max(mx, Math.abs(o.yaw), Math.abs(o.pitch)); }
    expect(mx).toBeGreaterThan(0); expect(mx).toBeLessThanOrEqual(0.4 * DEG);
    for (let i = 0; i < 10; i++) s.sample(1 / 60, o);
    expect(o.yaw).toBe(0); expect(o.pitch).toBe(0); expect(s.active).toBe(false);
  });
  it('explosion shake falls off to 0 at 30 m', () => {
    expect(explosionShake(0)).toBeCloseTo(0.4 * DEG); expect(explosionShake(15)).toBeCloseTo(0.2 * DEG); expect(explosionShake(40)).toBe(0);
  });
  it('AWP zoom 75° → 20° takes 0.15 s', () => {
    let f = 75, t = 0;
    while (f !== 20 && t < 1) { f = approachFov(f, 20, 1 / 60); t += 1 / 60; }
    expect(f).toBe(20); expect(t).toBeLessThanOrEqual(0.15 + 1 / 60 + 1e-9);
  });
  it('bomb LED interval: 1.05 s at 35 s, 0.05 s at 0, monotone', () => {
    expect(bombBlinkInterval(35)).toBeCloseTo(1.05); expect(bombBlinkInterval(0)).toBeCloseTo(0.05);
    let prev = 0; for (let r = 0; r <= 35; r += 1) { const i = bombBlinkInterval(r); expect(i).toBeGreaterThanOrEqual(prev); prev = i; }
  });
});
