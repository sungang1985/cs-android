import { describe, it, expect } from 'vitest';
import { compileMap, buildStaticWorld, walkReachable } from '@/world/compile';
import { buildNavGraph } from '@/nav/navgraph';
import { DEPOT } from '@/maps/depot';
import { BOX } from '@/maps/box';
import { v3 } from '@/core/math';

describe('compileMap(DEPOT)', () => {
  const map = compileMap(DEPOT);
  const world = buildStaticWorld(map);
  it('has the expected geometry', () => {
    expect(map.width).toBe(24); expect(map.height).toBe(18);
    const kinds = new Map<string, number>(); for (const s of map.solids) kinds.set(s.kind, (kinds.get(s.kind) ?? 0) + 1);
    expect(kinds.get('platform')).toBe(1); expect(kinds.get('ramp-step')).toBe(8); expect(kinds.get('ceiling')).toBe(1);
    expect(map.solids.length).toBeGreaterThan(60); expect(map.solids.length).toBeLessThan(160);
    expect(map.floorY(40, 5)).toBe(1.5); expect(map.floorY(10, 10)).toBe(0);
    expect(map.spawns.T.length).toBe(5); expect(map.spawns.CT.length).toBe(5);
    for (const s of map.solids) { expect(s.box.min.x).toBeGreaterThanOrEqual(0); expect(s.box.max.x).toBeLessThanOrEqual(48); expect(s.box.max.z).toBeLessThanOrEqual(36); }
  });
  it('walk grid is populated and spawns are walkable and connected to both sites', () => {
    let walkable = 0; for (const w of map.walk.walkable) walkable += w;
    expect(walkable).toBeGreaterThan(900); expect(walkable).toBeLessThan(1400);
    for (const sp of [...map.spawns.T, ...map.spawns.CT]) expect(map.walk.walkable[map.walk.index(sp.pos.x, sp.pos.z)]).toBe(1);
    for (const sp of map.spawns.T) { expect(walkReachable(map, sp.pos, map.plantSpots.a)).toBe(true); expect(walkReachable(map, sp.pos, map.plantSpots.b)).toBe(true); }
    expect(walkReachable(map, map.spawns.CT[0].pos, map.spawns.T[0].pos)).toBe(true);
  });
  it('platform is reached via ramps (floor 1.5 at the plant spot)', () => {
    expect(map.plantSpots.a.y).toBe(1.5);
    expect(world.floorHeightAt(map.plantSpots.a.x, map.plantSpots.a.z, 3)).toBe(1.5);
  });
  it('areas resolve', () => {
    expect(map.areaAt(map.spawns.T[0].pos.x, map.spawns.T[0].pos.z)).toBe('t_spawn');
    expect(map.areaAt(map.plantSpots.a.x, map.plantSpots.a.z)).toBe('site_a');
    expect(map.areaAt(1, 1)).toBeNull();
  });
  it('nav graph paths T spawn → A via the ramp and CT → B', () => {
    const nav = buildNavGraph(map, world);
    expect(nav.nodes.length).toBeGreaterThan(800);
    const ids = nav.findPath(map.spawns.T[0].pos, map.plantSpots.a);
    expect(ids).not.toBeNull();
    const corners = nav.pullString(ids!);
    expect(corners.length).toBeGreaterThan(2); expect(corners.length).toBeLessThan(40);
    expect(corners[corners.length - 1].y).toBeCloseTo(1.5);
    expect(nav.findPath(map.spawns.CT[0].pos, map.plantSpots.b)).not.toBeNull();
    for (const h of map.holdSpots) expect(nav.holdSpot(h.id).node).toBeGreaterThanOrEqual(0);
  });
  it('training variant seals and adds targets', () => {
    const tr = compileMap(DEPOT, 'training');
    expect(tr.training!.targets.length).toBe(8);
    expect(tr.solids.filter((s) => s.kind === 'seal').length).toBe(DEPOT.training!.sealed.length);
  });
});

describe('compileMap(BOX)', () => {
  it('compiles the test map', () => {
    const map = compileMap(BOX); const world = buildStaticWorld(map);
    const nav = buildNavGraph(map, world);
    expect(nav.nodes.length).toBeGreaterThan(40);
    expect(nav.findPath(map.spawns.T[0].pos, map.spawns.CT[0].pos)).not.toBeNull();
  });
});
