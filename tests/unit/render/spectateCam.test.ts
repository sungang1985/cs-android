/** Dead-human cameras (§2.2, §15): chase cam behind the spectated teammate; kill-cam killer latch. */
import { describe, it, expect } from 'vitest';
import { chaseCam, KillcamLatch, CHASE } from '../../../src/render/spectateCam';
import { v3 } from '../../../src/core/math';

describe('render/chaseCam', () => {
  it('sits behind and above the followed player and looks along their aim (§0 forward = (−sin yaw, −cos yaw))', () => {
    for (const yaw of [0, 0.8, Math.PI, -2]) {
      const pivot = v3(5, 1.65, 5), eye = v3(), tgt = v3();
      chaseCam(pivot, yaw, 0, [], eye, tgt);
      const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
      // camera is behind (opposite forward), target is ahead
      expect((eye.x - pivot.x) * fx + (eye.z - pivot.z) * fz).toBeCloseTo(-CHASE.back, 6);
      expect(eye.y - pivot.y).toBeCloseTo(CHASE.up, 6);
      expect((tgt.x - pivot.x) * fx + (tgt.z - pivot.z) * fz).toBeGreaterThan(0);
    }
  });
  it('is pulled in front of a wall behind the player', () => {
    const pivot = v3(0, 1.65, 0), eye = v3(), tgt = v3();
    // yaw 0 faces −z, so "behind" is +z; wall face at z = 1
    chaseCam(pivot, 0, 0, [{ min: v3(-5, 0, 1), max: v3(5, 3, 2) }], eye, tgt);
    expect(eye.z).toBeLessThan(1);
    expect(eye.z).toBeGreaterThan(0);
    expect(Math.hypot(eye.x - pivot.x, eye.y - pivot.y, eye.z - pivot.z)).toBeGreaterThanOrEqual(CHASE.minDist - 1e-9);
  });
});

describe('render/KillcamLatch', () => {
  it('keeps the killer after a later kill overwrites the snapshot killerId', () => {
    const k = new KillcamLatch(), me = 1;
    expect(k.resolve(true, 0, me)).toBe(0);
    k.onDeath(me, 7, me);
    expect(k.resolve(false, 7, me)).toBe(7);
    k.onDeath(7, 3, me); // teammate trades the killer: the sim's lastKill (and killerId) move on
    expect(k.resolve(false, 0, me)).toBe(7);
    expect(k.resolve(true, 0, me)).toBe(0); // alive again (next round)
    expect(k.resolve(false, 0, me)).toBe(0);
  });
  it('no kill-cam target for self-kills / world deaths; snapshot fallback when no event was seen', () => {
    const k = new KillcamLatch(), me = 2;
    k.onDeath(me, me, me); expect(k.resolve(false, me, me)).toBe(0);
    k.resolve(true, 0, me);
    k.onDeath(me, 0, me); expect(k.resolve(false, 0, me)).toBe(0);
    const fresh = new KillcamLatch();
    expect(fresh.resolve(false, 9, me)).toBe(9);
    expect(fresh.resolve(false, me, me)).toBe(0);
  });
});
