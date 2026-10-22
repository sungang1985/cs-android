import { describe, it, expect } from 'vitest';
import { StaticWorld, type Solid } from '@/sim/world/collision';
import { aabb, v3, v3norm } from '@/core/math';

const PLAYER = { halfWidth: 0.3, height: 1.8, stepHeight: 0.5 };
const solid = (b: ReturnType<typeof aabb>, surface: Solid['surface'] = 'concrete', penetrable = false): Omit<Solid, 'id'> => ({ box: b, surface, penetrable });

function room(): StaticWorld {
  return new StaticWorld([
    solid(aabb(-10, 0, -10.5, 10, 4, -10)),   // north wall
    solid(aabb(-10, 0, 10, 10, 4, 10.5)),     // south wall
    solid(aabb(-10.5, 0, -10, -10, 4, 10)),   // west wall
    solid(aabb(10, 0, -10, 10.5, 4, 10)),     // east wall
    solid(aabb(2, 0, 2, 4, 1, 4), 'wood'),     // 1 m crate
    solid(aabb(-4, 0, -4, -2, 0.4, -2), 'metal'), // low step
    solid(aabb(6, 0, -6, 7, 2, -5), 'plaster', true), // thin penetrable pillar
  ]);
}

describe('StaticWorld raycast', () => {
  it('hits the nearest solid with correct normal and distance', () => {
    const w = room();
    const hit = w.raycast(v3(0, 1, 0), v3(0, 0, -1));
    expect(hit).not.toBeNull();
    expect(hit!.t).toBeCloseTo(10);
    expect(hit!.normal).toEqual({ x: 0, y: 0, z: 1 });
    expect(hit!.surface).toBe('concrete');
  });
  it('hits the ground plane', () => {
    const w = room();
    const hit = w.raycast(v3(0, 1, 0), v3norm(v3(0, -1, 1)));
    expect(hit!.solid).toBeNull(); expect(hit!.surface).toBe('ground'); expect(hit!.point.y).toBeCloseTo(0);
  });
  it('respects maxDist and filters', () => {
    const w = room();
    expect(w.raycast(v3(0, 1, 0), v3(0, 0, -1), 5)).toBeNull();
    expect(w.raycast(v3(0, 1, 0), v3(0, 0, -1), 20, (s) => s.surface !== 'concrete')).toBeNull();
  });
  it('raycastAll returns ordered hits with exit distances (penetration)', () => {
    const w = room();
    const hits = w.raycastAll(v3(6.5, 1, 0), v3(0, 0, -1));
    expect(hits.length).toBe(2);
    expect(hits[0].solid!.penetrable).toBe(true);
    expect(hits[0].t).toBeCloseTo(5); expect(hits[0].tExit).toBeCloseTo(6);
    expect(hits[1].t).toBeCloseTo(10);
  });
  it('line of sight', () => {
    const w = room();
    expect(w.lineOfSight(v3(0, 1.6, 0), v3(5, 1.6, 5))).toBe(true);
    expect(w.lineOfSight(v3(3, 0.5, 0), v3(3, 0.5, 6))).toBe(false); // through the crate
    expect(w.lineOfSight(v3(3, 1.5, 0), v3(3, 1.5, 6))).toBe(true);  // over the crate
  });
  it('long diagonal rays walk every cell (no misses)', () => {
    const w = room();
    const hit = w.raycast(v3(-9, 1, -9), v3norm(v3(1, 0, 1)));
    expect(hit).not.toBeNull(); // must hit the east or south wall, not escape
    expect(hit!.t).toBeLessThan(28);
  });
});

describe('StaticWorld movement', () => {
  it('walks freely on the ground and stays grounded', () => {
    const w = room();
    const r = w.moveBody(v3(0, 0, 0), v3(3, 0, 0), 1 / 60, PLAYER, { wasGrounded: true });
    expect(r.pos.x).toBeCloseTo(3 / 60); expect(r.grounded).toBe(true); expect(r.hitWall).toBe(false);
  });
  it('is stopped by walls and slides along them', () => {
    const w = room();
    const r = w.moveBody(v3(9.5, 0, 0), v3(10, 0, 5), 1 / 10, PLAYER, { wasGrounded: true });
    expect(r.pos.x).toBeCloseTo(10 - 0.3, 3);
    expect(r.pos.z).toBeCloseTo(0.5, 3);
    expect(r.hitWall).toBe(true); expect(r.vel.x).toBe(0);
  });
  it('steps up a low step but not a 1 m crate', () => {
    const w = room();
    const a = w.moveBody(v3(-3, 0, -5), v3(0, 0, 4), 1 / 4, PLAYER, { wasGrounded: true }); // toward low step at z -4..-2
    expect(a.steppedUp).toBe(true); expect(a.pos.y).toBeCloseTo(0.4); expect(a.pos.z).toBeCloseTo(-4);
    const b = w.moveBody(v3(3, 0, 0), v3(0, 0, 8), 1 / 4, PLAYER, { wasGrounded: true }); // toward crate at z 2..4 (wants +2)
    expect(b.steppedUp).toBe(false); expect(b.pos.z).toBeCloseTo(2 - 0.3, 3); expect(b.hitWall).toBe(true);
  });
  it('falls with gravity, lands on crate top and the ground', () => {
    const w = room();
    let pos = v3(3, 3, 3), vel = v3(0, 0, 0), grounded = false;
    for (let i = 0; i < 120; i++) {
      vel.y -= 20 / 60;
      const r = w.moveBody(pos, vel, 1 / 60, PLAYER, { wasGrounded: grounded });
      pos = r.pos; vel = r.vel; grounded = r.grounded;
      if (grounded) break;
    }
    expect(grounded).toBe(true); expect(pos.y).toBeCloseTo(1); expect(vel.y).toBe(0);
    let p2 = v3(0, 2, 0), v2 = v3(0, 0, 0), g2 = false;
    for (let i = 0; i < 120 && !g2; i++) { v2.y -= 20 / 60; const r = w.moveBody(p2, v2, 1 / 60, PLAYER, { wasGrounded: g2 }); p2 = r.pos; v2 = r.vel; g2 = r.grounded; }
    expect(g2).toBe(true); expect(p2.y).toBeCloseTo(0);
  });
  it('snaps down when walking off a step and detects ceilings', () => {
    const w = room();
    const r = w.moveBody(v3(-3, 0.4, -2.2), v3(0, 0, 6), 1 / 10, PLAYER, { wasGrounded: true });
    expect(r.grounded).toBe(true); expect(r.pos.y).toBeCloseTo(0);
    const low = new StaticWorld([solid(aabb(-5, 2, -5, 5, 3, 5))]);
    const c = low.moveBody(v3(0, 0, 0), v3(0, 10, 0), 1 / 4, PLAYER, { wasGrounded: false });
    expect(c.hitCeiling).toBe(true); expect(c.pos.y).toBeCloseTo(0.2, 3); expect(c.vel.y).toBe(0);
  });
  it('floorHeightAt and surfaceAt', () => {
    const w = room();
    expect(w.floorHeightAt(3, 3, 5)).toBe(1);
    expect(w.floorHeightAt(3, 3, 0.5)).toBe(0);
    expect(w.floorHeightAt(0, 0, 5)).toBe(0);
    expect(w.surfaceAt(3, 3, 1)).toBe('wood');
  });
  it('is deterministic and does not tunnel at high speed', () => {
    const w = room();
    const r = w.moveBody(v3(0, 0, 0), v3(0, 0, -5000), 1 / 60, PLAYER, { wasGrounded: true });
    expect(r.pos.z).toBeCloseTo(-10 + 0.3, 3);
  });
});
