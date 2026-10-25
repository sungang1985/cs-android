/** §3.5 / §12.1 world/compile: every compiler assertion, the real Depot numbers, render hints, the training variant. */
import { describe, it, expect } from 'vitest';
import { compileMap, buildSolids, solidProblems, validateSource, walkReach, walkableCount, MapCompileError } from '@/world/compile';
import { DEPOT } from '@/maps/depot';
import { BOX } from '@/maps/box';
import { aabb } from '@/core/math';
import type { MapSource, SolidKind } from '@/world/types';

const clone = (patch: (s: MapSource) => void, base: MapSource = DEPOT): MapSource => { const s = structuredClone(base); patch(s); return s; };
const setGlyph = (s: MapSource, x: number, z: number, g: string) => { s.grid[z] = s.grid[z].slice(0, x) + g + s.grid[z].slice(x + 1); };
const glyphCount = (s: MapSource, g: string) => s.grid.join('').split(g).length - 1;
const expectCompileError = (src: MapSource, re: RegExp, variant: 'match' | 'training' = 'match') => {
  let err: unknown = null;
  try { compileMap(src, variant); } catch (e) { err = e; }
  expect(err, `expected MapCompileError ${re}`).toBeInstanceOf(MapCompileError);
  expect((err as Error).message).toMatch(re);
};

describe('compileMap(DEPOT) solids (§3.5 step 1)', () => {
  const map = compileMap(DEPOT);
  const byKind = (k: SolidKind) => map.solids.filter((s) => s.kind === k);
  it('solid inventory matches the grid (measured: 66 solids, 27 merged wall boxes)', () => {
    const kinds: Record<string, number> = {};
    for (const s of map.solids) kinds[s.kind] = (kinds[s.kind] ?? 0) + 1;
    expect(kinds).toEqual({ wall: 27, platform: 1, tallcrate: 10, lowcrate: 7, sandbag: 4, lip: 2, lintel: 6, 'ramp-step': 8, ceiling: 1 });
    expect(byKind('tallcrate').length).toBe(glyphCount(DEPOT, 'X'));
    expect(byKind('lowcrate').length).toBe(glyphCount(DEPOT, 'c'));
    expect(byKind('sandbag').length).toBe(glyphCount(DEPOT, '~'));
    expect(byKind('lip').length).toBe(glyphCount(DEPOT, 'L'));
    expect(byKind('lintel').length).toBe(glyphCount(DEPOT, '+'));
    expect(map.solids.length).toBe(66);
  });
  it('wall boxes are merged and cover exactly the # cells; no overlaps, nothing outside the bounds', () => {
    const walls = byKind('wall');
    const area = walls.reduce((a, s) => a + (s.box.max.x - s.box.min.x) * (s.box.max.z - s.box.min.z), 0);
    expect(area).toBe(glyphCount(DEPOT, '#') * 4);
    for (const s of walls) { expect(s.box.min.y).toBe(0); expect(s.box.max.y).toBe(3); expect(s.material).toBe('concrete'); }
    for (let z = 0; z < 18; z++) for (let x = 0; x < 24; x++) {
      const covered = walls.some((s) => s.box.min.x <= 2 * x && s.box.max.x >= 2 * x + 2 && s.box.min.z <= 2 * z && s.box.max.z >= 2 * z + 2);
      expect(covered, `cell (${x}, ${z})`).toBe(DEPOT.grid[z][x] === '#');
    }
    expect(glyphCount(DEPOT, '#')).toBe(126); // 126 wall cells → 27 boxes (§3.5 estimated ≈ 190 → ≈ 70)
    expect(solidProblems(map.solids, map.bounds)).toEqual([]);
  });
  it('props sit on the local floor with their insets; platform slab; ceiling', () => {
    const at = (x: number, z: number) => map.solids.find((s) => s.box.min.x < 2 * x + 1 && s.box.max.x > 2 * x + 1 && s.box.min.z < 2 * z + 1 && s.box.max.z > 2 * z + 1 && s.kind !== 'ceiling' && s.kind !== 'platform')!;
    expect(at(11, 6).box).toEqual(aabb(22.5, 0, 12.5, 23.5, 1, 13.5));             // c: 1 m cube, 0.5 m inset
    expect(at(18, 3).box).toEqual(aabb(36.5, 1.5, 6.5, 37.5, 2.5, 7.5));           // c on the platform: y 1.5..2.5 (§3.3)
    expect(at(14, 4).box).toEqual(aabb(28, 0, 8, 30, 2, 10));                      // X: full cell, 2 m
    expect(at(15, 7).box).toEqual(aabb(30, 0, 14, 32, 1.2, 16));                   // ~: full cell, 1.2 m
    expect(at(17, 1).box).toEqual(aabb(34, 0, 2, 36, 1.9, 4));                     // L: 0 … 1.9 on the floor-0 side
    expect(at(14, 4).penetrationFactor).toBe(0.4); expect(at(11, 6).penetrationFactor).toBe(0.6); expect(at(17, 1).penetrable).toBe(false);
    expect(byKind('platform')[0].box).toEqual(aabb(36, 0, 2, 46, 1.5, 10));
    expect(byKind('ceiling')[0].box).toEqual(aabb(0, 4.5, 0, 48, 5, 36));
  });
  it('door lintels (2.6–3.0) and door frames with walk-through axes', () => {
    const doors = map.renderHints.doorFrames.map((d) => `${(d.pos.x - 1) / 2},${(d.pos.z - 1) / 2},${d.axis}`);
    expect(doors).toEqual(['7,2,x', '4,8,x', '4,9,x', '22,12,z', '7,15,x', '17,15,x']);
    for (const l of byKind('lintel')) { expect(l.box.min.y).toBe(2.6); expect(l.box.max.y).toBe(3); expect(l.box.max.x - l.box.min.x).toBe(2); }
  });
  it('ramp stairs: 4 boxes of 0.5 m rising 0.375 m toward the platform; wedge hints', () => {
    const steps = byKind('ramp-step');
    const west = steps.slice(0, 4), back = steps.slice(4);
    west.forEach((s, i) => expect(s.box).toEqual(aabb(34 + 0.5 * i, 0, 4, 34.5 + 0.5 * i, 0.375 * (i + 1), 6)));
    back.forEach((s, i) => expect(s.box).toEqual(aabb(44, 0, 11.5 - 0.5 * i, 46, 0.375 * (i + 1), 12 - 0.5 * i)));
    for (const s of steps) { expect(s.material).toBeNull(); expect(s.surface).toBe('metal'); }
    expect(map.renderHints.ramps).toEqual([
      { origin: { x: 34, y: 0, z: 5 }, ascend: 'e', from: 0, to: 1.5, width: 2, length: 2, material: 'metal' },
      { origin: { x: 45, y: 0, z: 12 }, ascend: 'n', from: 0, to: 1.5, width: 2, length: 2, material: 'metal' },
    ]);
  });
});

describe('compileMap(DEPOT) floor function and walk grid (§3.5 steps 2–3)', () => {
  const map = compileMap(DEPOT);
  const w = map.walk;
  const sub = (x: number, z: number) => z * w.cols + x;
  it('floorY: 1.5 on the platform, 0 elsewhere (ramps included)', () => {
    expect(map.floorY(37, 3)).toBe(1.5); expect(map.floorY(45.9, 9.9)).toBe(1.5);
    expect(map.floorY(35, 5)).toBe(0); expect(map.floorY(45, 11)).toBe(0); expect(map.floorY(20, 20)).toBe(0);
  });
  it('walkable sub-cell count (measured 1,132; spec ≈ 1,150)', () => {
    const n = walkableCount(w);
    expect(n).toBe(1132);
    expect(Math.abs(n - 1150) / 1150).toBeLessThan(0.05);
    expect(w.cols).toBe(48); expect(w.rows).toBe(36);
  });
  it('ramp sub-cells are flagged with wedge heights and their ascend axis', () => {
    for (const [x, z, y, axis] of [[34, 4, 0.375, 1], [35, 4, 1.125, 1], [34, 5, 0.375, 1], [35, 5, 1.125, 1], [44, 11, 0.375, 2], [45, 11, 0.375, 2], [44, 10, 1.125, 2], [45, 10, 1.125, 2]]) {
      const i = sub(x, z);
      expect(w.ramp[i], `${x},${z}`).toBe(1); expect(w.rampAxis[i]).toBe(axis); expect(w.walkable[i]).toBe(1); expect(w.floorY[i]).toBeCloseTo(y, 6);
    }
    let ramps = 0; for (const r of w.ramp) ramps += r;
    expect(ramps).toBe(8);
  });
  it('props block their sub-cells; platform sub-cells stand at 1.5', () => {
    for (const [x, z] of [[22, 12], [23, 13], [36, 6], [37, 7], [30, 14], [34, 2]]) expect(w.walkable[sub(x, z)], `${x},${z}`).toBe(0);
    expect(w.walkable[sub(40, 4)]).toBe(1); expect(w.floorY[sub(40, 4)]).toBe(1.5);
    expect(w.walkable[sub(21, 12)]).toBe(1); // next to the inset low crate: still walkable
  });
  it('every spawn sub-cell is walkable; every spawn reaches both sites and every enemy spawn', () => {
    for (const s of [...DEPOT.spawns.T, ...DEPOT.spawns.CT]) for (let dz = 0; dz < 2; dz++) for (let dx = 0; dx < 2; dx++) expect(w.walkable[sub(2 * s.cell[0] + dx, 2 * s.cell[1] + dz)]).toBe(1);
    for (const team of ['T', 'CT'] as const) for (const s of map.spawns[team]) {
      const reach = walkReach(w, w.index(s.pos.x, s.pos.z));
      expect(reach[w.index(map.plantSpots.a.x, map.plantSpots.a.z)]).toBe(1);
      expect(reach[w.index(map.plantSpots.b.x, map.plantSpots.b.z)]).toBe(1);
      for (const e of map.spawns[team === 'T' ? 'CT' : 'T']) expect(reach[w.index(e.pos.x, e.pos.z)]).toBe(1);
    }
  });
});

describe('compileMap(DEPOT) world-space data and render hints (§3.5 steps 4–5)', () => {
  const map = compileMap(DEPOT);
  it('spawns, plant spots, hold spots and chokes in metres', () => {
    expect(map.spawns.T[0]).toEqual({ pos: { x: 5, y: 0, z: 13 }, yaw: -Math.PI / 2 });
    expect(map.spawns.CT[0].pos).toEqual({ x: 43, y: 0, z: 17 }); expect(map.spawns.CT[0].yaw).toBeCloseTo(Math.PI / 2);
    expect(map.plantSpots).toEqual({ a: { x: 41, y: 1.5, z: 5 }, b: { x: 41, y: 0, z: 31 } });
    expect(map.sites.a).toEqual({ x0: 38, z0: 2, x1: 44, z1: 8, y: 1.5 });
    expect(map.holdSpots.find((h) => h.id === 'hold_a_lip')!.pos).toEqual({ x: 37, y: 1.5, z: 3 });
    expect(map.chokes.length).toBe(10);
  });
  it('areaAt picks the smallest containing area', () => {
    expect(map.areaAt(35, 5)).toBe('a_ramp'); expect(map.areaAt(23, 9)).toBe('mid_window'); expect(map.areaAt(45, 11)).toBe('a_ramp_ct');
    expect(map.areaAt(41, 31)).toBe('site_b'); expect(map.areaAt(20, 20)).toBe('mid'); expect(map.areaAt(9, 9)).toBeNull();
  });
  it('renderHints.solids lines up with solids; only ramp steps and seals are invisible', () => {
    expect(map.renderHints.solids.length).toBe(map.solids.length);
    map.solids.forEach((s, i) => { expect(map.renderHints.solids[i]).toEqual({ material: s.material, kind: s.kind, uvScale: 0.5 }); });
    expect(map.solids.filter((s) => s.material === null).every((s) => s.kind === 'ramp-step' || s.kind === 'seal')).toBe(true);
  });
  it('floor quads tile every non-wall floor-0 cell exactly once, plus the platform top', () => {
    const quads = map.renderHints.floorQuads;
    for (let z = 0; z < 18; z++) for (let x = 0; x < 24; x++) {
      const cx = 2 * x + 1, cz = 2 * z + 1;
      const n = quads.filter((q) => q.rect.y === 0 && cx > q.rect.x0 && cx < q.rect.x1 && cz > q.rect.z0 && cz < q.rect.z1).length;
      const onPlatform = x >= 18 && x <= 22 && z >= 1 && z <= 4;
      expect(n, `cell ${x},${z}`).toBe(DEPOT.grid[z][x] === '#' || onPlatform ? 0 : 1);
    }
    expect(quads.filter((q) => q.rect.y === 1.5)).toEqual([{ rect: { x0: 36, z0: 2, x1: 46, z1: 10, y: 1.5 }, material: 'metal' }]);
  });
  it('lamps: one per 4 × 4 m block with floor, just under the ceiling, over open cells', () => {
    expect(map.renderHints.lamps.length).toBe(108);
    for (const l of map.renderHints.lamps) {
      expect(l.y).toBeCloseTo(4.4);
      const bx = Math.floor(l.x / 4), bz = Math.floor(l.z / 4);
      const open = [0, 1].some((dz) => [0, 1].some((dx) => DEPOT.grid[2 * bz + dz]?.[2 * bx + dx] !== '#'));
      expect(open).toBe(true);
    }
  });
  it('site decals and wall signs face into the sites', () => {
    expect(map.renderHints.siteDecals).toEqual([{ site: 'a', rect: map.sites.a }, { site: 'b', rect: map.sites.b }]);
    const [a, b] = map.renderHints.wallSigns;
    expect(a.site).toBe('a'); expect(a.pos).toEqual({ x: 39, y: 2.5, z: 2 }); expect(a.yaw).toBeCloseTo(Math.PI);   // north wall, facing south; kept below the 3 m wall top
    expect(b.site).toBe('b'); expect(b.pos).toEqual({ x: 39, y: 2.2, z: 34 }); expect(b.yaw).toBe(0);               // south wall, facing north
  });
  it('radar walls are merged outline segments on wall/lip/X boundaries', () => {
    const segs = map.renderHints.radarWalls;
    expect(segs.length).toBe(90);
    const solid = (x: number, z: number) => x >= 0 && z >= 0 && x < 24 && z < 18 && '#LX'.includes(DEPOT.grid[z][x]);
    for (const s of segs) {
      expect(s.x0 === s.x1 || s.z0 === s.z1).toBe(true);
      const horizontal = s.z0 === s.z1;
      const len = horizontal ? Math.abs(s.x1 - s.x0) : Math.abs(s.z1 - s.z0);
      for (let k = 0; k < len; k += 2) {   // every 2 m piece separates a radar-solid cell from a non-solid cell
        if (horizontal) { const x = (Math.min(s.x0, s.x1) + k) / 2, z = s.z0 / 2; expect(solid(x, z - 1) !== solid(x, z)).toBe(true); }
        else { const z = (Math.min(s.z0, s.z1) + k) / 2, x = s.x0 / 2; expect(solid(x - 1, z) !== solid(x, z)).toBe(true); }
      }
    }
  });
});

describe("compileMap(DEPOT, 'training') (§2.4)", () => {
  const tr = compileMap(DEPOT, 'training');
  const w = tr.walk;
  it('adds one invisible seal per sealed rect and fills training', () => {
    const seals = tr.solids.filter((s) => s.kind === 'seal');
    expect(seals.length).toBe(DEPOT.training!.sealed.length);
    for (const s of seals) { expect(s.material).toBeNull(); expect(s.box.max.y).toBe(3); }
    expect(tr.training!.sealed.length).toBe(seals.length);
    expect(tr.training!.targets.length).toBe(8);
    expect(tr.training!.onboardingPos).toEqual({ x: 11, y: 0, z: 5 });
    expect(tr.renderHints.solids.length).toBe(tr.solids.length);
    expect(tr.renderHints.radarWalls).toEqual(compileMap(DEPOT).renderHints.radarWalls); // seals never reach the radar
    expect(solidProblems(tr.solids, tr.bounds)).toEqual([]);
  });
  it('the open region is exactly T spawn + North Room + Long (+ the two passages); all targets reachable', () => {
    const reach = walkReach(w, w.index(tr.spawns.T[0].pos.x, tr.spawns.T[0].pos.z));
    const rect = (id: string) => DEPOT.areas.find((a) => a.id === id)!.rect;
    const inside = (r: number[], cx: number, cz: number) => cx >= r[0] && cx <= r[2] && cz >= r[1] && cz <= r[3];
    const allowed = (cx: number, cz: number) => ['t_spawn', 't_north', 'long'].some((id) => inside(rect(id), cx, cz)) || (cx === 4 && cz === 4) || (cx === 7 && cz === 2);
    let n = 0;
    for (let i = 0; i < reach.length; i++) {
      const x = i % w.cols, z = Math.floor(i / w.cols);
      const ok = allowed(Math.floor(x / 2), Math.floor(z / 2));
      if (reach[i]) { n++; expect(ok, `sub-cell ${x},${z} must not be reachable`).toBe(true); }
      else if (ok && w.walkable[i]) expect.fail(`sub-cell ${x},${z} inside the training region is not connected`);
    }
    expect(n).toBe(288);
    for (const s of tr.spawns.T) {
      const r = walkReach(w, w.index(s.pos.x, s.pos.z));
      for (const t of [...tr.training!.targets, tr.training!.onboardingPos]) expect(r[w.index(t.x, t.z)]).toBe(1);
    }
    expect(reach[w.index(tr.plantSpots.a.x, tr.plantSpots.a.z)]).toBe(0);
    expect(reach[w.index(tr.plantSpots.b.x, tr.plantSpots.b.z)]).toBe(0);
  });
});

describe('compiler assertions throw MapCompileError with helpful messages', () => {
  it('accepts the shipped maps', () => {
    expect(() => validateSource(DEPOT)).not.toThrow(); expect(() => compileMap(DEPOT, 'training')).not.toThrow(); expect(() => compileMap(BOX)).not.toThrow();
  });
  it('rows must have exactly `width` glyphs; glyphs must be known', () => {
    expectCompileError(clone((s) => { s.grid[3] = s.grid[3].slice(1); }), /row 3 has 23 glyphs, expected exactly 24/);
    expectCompileError(clone((s) => { s.grid.pop(); }), /grid has 17 rows, expected exactly 18/);
    expectCompileError(clone((s) => setGlyph(s, 5, 5, '?')), /unknown glyph '\?' at cell \(5, 5\)/);
  });
  it('T/C glyph counts must match the spawn lists and spawns sit on their glyph', () => {
    expectCompileError(clone((s) => setGlyph(s, 3, 7, 'T')), /6 'T' glyphs but 5 T spawns/);
    expectCompileError(clone((s) => { s.spawns.CT.pop(); }), /5 'C' glyphs but 4 CT spawns/);
    expectCompileError(clone((s) => { s.spawns.T[0].cell = [3, 6]; }), /T spawn 0 at \(3, 6\) is on '\.', expected 'T'/);
  });
  it('platform cells must be platform-compatible; ^ only on platforms', () => {
    expectCompileError(clone((s) => setGlyph(s, 20, 4, '.')), /platform 0 cell \(20, 4\) is '\.'/);
    expectCompileError(clone((s) => setGlyph(s, 6, 6, '^')), /'\^' at \(6, 6\) lies outside every platform rect/);
  });
  it("ramps: '=' needs an entry, from/to neighbour floors must match", () => {
    expectCompileError(clone((s) => { s.ramps.pop(); }), /'=' at \(22, 5\) has no entry in ramps/);
    expectCompileError(clone((s) => { s.ramps[0].ascend = 'w'; }), /ramp 0 at \(17, 2\): 'from' neighbour \(18, 2\) has floor 1.5, expected from = 0/);
    expectCompileError(clone((s) => { s.ramps[1].to = 1.2; }), /ramp 1 at \(22, 5\): 'to' neighbour \(22, 4\) has floor 1.5, expected to = 1.2/);
    expectCompileError(clone((s) => { s.ramps[0].steps = 2 as 4; }), /rises 0.750 m per step/);
  });
  it('every spawn sub-cell must be walkable', () => {
    expectCompileError(clone((s) => { s.ceilingY = 1.7; s.wallHeight = 1.6; s.lintelY = 1.5; }, BOX), /T spawn 0 at cell \(1, 1\): sub-cell \(2, 2\) is not walkable/);
  });
  it('BFS: every spawn must reach both sites and the enemy spawns', () => {
    expectCompileError(clone((s) => { setGlyph(s, 18, 15, '#'); setGlyph(s, 22, 13, '#'); }), /T spawn 0 \(2, 6\) cannot reach plant spot b/);
    expectCompileError(clone((s) => { for (const [x, z] of [[4, 4], [5, 8], [5, 9], [4, 13]]) setGlyph(s, x, z, '#'); }), /T spawn 0 \(2, 6\) cannot reach plant spot a/);
  });
  it('named cells must be in the grid and on floor; plant spots inside their site', () => {
    expectCompileError(clone((s) => { s.plantSpots.a = [20, 15]; }), /plant spot a \(20, 15\) lies outside site a/);
    expectCompileError(clone((s) => { s.holdSpots[0].cell = [0, 0]; }), /hold spot 'hold_a_lip' cell \(0, 0\) is '#'/);
    expectCompileError(clone((s) => { s.chokes[0].cell = [30, 2]; }), /choke 'long_door' cell \(30, 2\) is outside/);
  });
  it('training: seals must not leak and targets must be reachable', () => {
    expectCompileError(clone((s) => { s.training!.sealed = s.training!.sealed.filter((r) => r[0] !== 4 || r[1] !== 13); }), /training seals leak: T spawn 0 \(2, 6\) reaches plant spot a/, 'training');
    expectCompileError(clone((s) => { s.training!.targets[0] = [12, 15]; }), /cannot reach training target 0 \(12, 15\)/, 'training');
  });
  it('solidProblems reports overlaps and out-of-bounds boxes (touching is fine, seals exempt)', () => {
    const bounds = aabb(0, 0, 0, 10, 5, 10);
    const def = (box: ReturnType<typeof aabb>, kind: SolidKind = 'wall') => ({ box, kind, material: null, surface: 'concrete' as const, penetrable: false, penetrationFactor: 0 });
    expect(solidProblems([def(aabb(0, 0, 0, 2, 3, 2)), def(aabb(2, 0, 0, 4, 3, 2))], bounds)).toEqual([]);
    expect(solidProblems([def(aabb(0, 0, 0, 2, 3, 2)), def(aabb(1.9, 0, 0, 4, 3, 2))], bounds)).toEqual(['solid 0 (wall) and solid 1 (wall) overlap']);
    expect(solidProblems([def(aabb(9, 0, 0, 11, 3, 2))], bounds)).toEqual(['solid 0 (wall) leaves the map bounds']);
    expect(solidProblems([def(aabb(0, 0, 0, 2, 3, 2)), def(aabb(1, 0, 0, 3, 3, 1), 'seal')], bounds)).toEqual([]);
  });
  it('buildSolids is deterministic', () => {
    expect(JSON.stringify(buildSolids(DEPOT, 'training'))).toBe(JSON.stringify(buildSolids(DEPOT, 'training')));
  });
});
