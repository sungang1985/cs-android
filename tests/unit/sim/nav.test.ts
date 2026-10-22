import { describe, it, expect } from 'vitest';
import { StaticWorld, type Solid } from '@/sim/world/collision';
import { NavGrid } from '@/sim/world/nav';
import { aabb, v3 } from '@/core/math';

const BODY = { halfWidth: 0.3, height: 1.8, stepHeight: 0.5 };
const solid = (b: ReturnType<typeof aabb>, surface: Solid['surface'] = 'concrete'): Omit<Solid, 'id'> => ({ box: b, surface, penetrable: false });

/** 20x20 m room with a dividing wall that has a 2 m door, a crate and a staircase up to a 1 m platform. */
function world(): StaticWorld {
  const s: Array<Omit<Solid, 'id'>> = [
    solid(aabb(0, 0, -0.5, 20, 4, 0)), solid(aabb(0, 0, 20, 20, 4, 20.5)), solid(aabb(-0.5, 0, 0, 0, 4, 20)), solid(aabb(20, 0, 0, 20.5, 4, 20)),
    // dividing wall at x=10, door between z=9 and z=11
    solid(aabb(9.75, 0, 0, 10.25, 4, 9)), solid(aabb(9.75, 0, 11, 10.25, 4, 20)),
    // crate (unclimbable, 1 m)
    solid(aabb(3, 0, 3, 5, 1, 5), 'wood'),
    // platform at 1 m with stairs of 0.25 m steps along +z
    solid(aabb(14, 0, 14, 19, 1, 19)),
  ];
  for (let i = 0; i < 4; i++) s.push(solid(aabb(15, 0, 14 - (i + 1) * 0.5, 18, 1 - (i + 1) * 0.25, 14 - i * 0.5)));
  return new StaticWorld(s);
}

describe('NavGrid', () => {
  const w = world();
  const nav = new NavGrid(w, { body: BODY, cell: 1 });

  it('samples walkable cells and excludes walls/crates', () => {
    expect(nav.nodes.length).toBeGreaterThan(300);
    expect(nav.nearest(v3(4, 0, 4))!.y).toBe(0); // the isolated crate-top layer is pruned; nearest is a floor node beside it
    const inWall = nav.nodeAt(10, 5); expect(inWall).toBeNull();
    const asciiMap = nav.ascii();
    expect(asciiMap.split('\n').length).toBe(nav.rows);
  });
  it('finds a path through the door and smooths it', () => {
    const path = nav.findPath(v3(2, 0, 2), v3(18, 0, 2));
    expect(path).not.toBeNull();
    const len = nav.pathLength(v3(2, 0, 2), path!);
    // straight line would be 16 m, through the door at z~10 it is ~ 2*sqrt(8^2+8^2) = 22.6
    expect(len).toBeGreaterThan(20); expect(len).toBeLessThan(26);
    expect(path!.length).toBeLessThan(8); // smoothed, not one point per cell
    expect(path![path!.length - 1].x).toBeCloseTo(18, 0);
  });
  it('climbs stairs to the platform and does not path onto the crate', () => {
    const up = nav.findPath(v3(16, 0, 5), v3(16, 1, 17));
    expect(up).not.toBeNull();
    expect(up![up!.length - 1].y).toBeCloseTo(1);
    expect(nav.nodes.every((n) => n.edges.length > 0)).toBe(true); // crate top pruned: no 1 m steps allowed
    expect(nav.nodes.some((n) => n.y === 1 && n.x > 3 && n.x < 5 && n.z > 3 && n.z < 5)).toBe(false);
  });
  it('returns null for unreachable targets and handles same-cell', () => {
    const closed = new StaticWorld([solid(aabb(-5, 0, -5, 5, 4, 5))]); // solid block only
    const n2 = new NavGrid(closed, { body: BODY, cell: 1, bounds: aabb(-6, 0, -6, 6, 0, 6) });
    expect(n2.findPath(v3(0, 0, 0), v3(2, 0, 2))).toBeNull(); // inside the block; nearest is outside maybe but let it be null or short
    const p = nav.findPath(v3(2, 0, 2), v3(2.3, 0, 2.2));
    expect(p).not.toBeNull(); expect(p!.length).toBeLessThanOrEqual(2);
  });
  it('tags nodes and queries by tag', () => {
    const n = nav.tagNodes(aabb(14, 0, 14, 19, 2, 19), 'siteA');
    expect(n).toBeGreaterThan(10);
    expect(nav.byTag('siteA').every((x) => x.y === 1)).toBe(true);
  });
  it('builds quickly for a 64x64 m map', () => {
    const big: Array<Omit<Solid, 'id'>> = [];
    for (let i = 0; i < 80; i++) big.push(solid(aabb((i * 7) % 60, 0, (i * 13) % 60, (i * 7) % 60 + 2, 2, (i * 13) % 60 + 2)));
    const bw = new StaticWorld(big, { bounds: aabb(0, 0, 0, 64, 4, 64) });
    const t0 = performance.now();
    const ng = new NavGrid(bw, { body: BODY, cell: 1 });
    const ms = performance.now() - t0;
    expect(ng.nodes.length).toBeGreaterThan(3000);
    expect(ms).toBeLessThan(1500);
    const t1 = performance.now();
    for (let i = 0; i < 20; i++) ng.findPath(v3(1, 0, 1), v3(62, 0, 62));
    expect((performance.now() - t1) / 20).toBeLessThan(25);
  });
});
