/** §6.4 / §12.1 nav/navgraph on the real Depot: nodes, ramp rule, tags, A*, LRU cache, string pulling, cover, holds. */
import { describe, it, expect } from 'vitest';
import { buildNavGraph, polylineLength, NAV_BODY, type NavGraph, type NavNode } from '@/nav/navgraph';
import { compileMap, buildStaticWorld, walkableCount } from '@/world/compile';
import { DEPOT } from '@/maps/depot';
import { BOX } from '@/maps/box';
import { Rng } from '@/core/rng';
import { v3, aabbContains, type Vec3 } from '@/core/math';
import type { AreaId } from '@/world/types';

const map = compileMap(DEPOT);
const world = buildStaticWorld(map);
const nav = buildNavGraph(map, world);
const w = map.walk;
const nodeAt = (x: number, z: number): NavNode | undefined => nav.nodes.find((n) => n.cx === x && n.cz === z);
/** pulled length from the path's first node through every corner */
function routeLength(g: NavGraph, from: Vec3, to: Vec3): { ids: number[]; corners: Vec3[]; length: number } {
  const ids = g.findPath(from, to)!;
  const corners = g.pullString(ids);
  return { ids, corners, length: polylineLength(corners, g.nodes[ids[0]].pos) };
}

describe('nodes and edges (§6.4.1–2)', () => {
  it('one node per walkable sub-cell (measured 1,132 vs ≈ 1,150 ± 5 %), row-major ids, centred at the floor', () => {
    expect(nav.nodes.length).toBe(walkableCount(w));
    expect(nav.nodes.length).toBe(1132);
    expect(Math.abs(nav.nodes.length - 1150) / 1150).toBeLessThanOrEqual(0.05);
    nav.nodes.forEach((n, i) => {
      expect(n.id).toBe(i);
      if (i > 0) expect(n.cz * w.cols + n.cx).toBeGreaterThan(nav.nodes[i - 1].cz * w.cols + nav.nodes[i - 1].cx);
      expect(n.pos.x).toBe(n.cx + 0.5); expect(n.pos.z).toBe(n.cz + 0.5); expect(n.pos.y).toBeCloseTo(w.floorY[n.cz * w.cols + n.cx], 6);
    });
    expect(nodeAt(34, 4)!.pos.y).toBeCloseTo(0.375); expect(nodeAt(35, 4)!.pos.y).toBeCloseTo(1.125); expect(nodeAt(40, 4)!.pos.y).toBe(1.5);
  });
  it('edges: sorted, symmetric, ≤ 0.6 m Δfloor except along a ramp axis, no corner cutting, no diagonals at ramps', () => {
    for (const n of nav.nodes) {
      expect(n.edges).toEqual([...n.edges].sort((a, b) => a - b));
      for (const m of n.edges) {
        const o = nav.nodes[m];
        expect(o.edges).toContain(n.id);
        const dx = o.cx - n.cx, dz = o.cz - n.cz;
        expect(Math.max(Math.abs(dx), Math.abs(dz))).toBe(1);
        const diagonal = dx !== 0 && dz !== 0;
        if (diagonal) {
          expect(n.ramp || o.ramp).toBe(false);
          expect(nodeAt(n.cx + dx, n.cz)).toBeDefined(); expect(nodeAt(n.cx, n.cz + dz)).toBeDefined();
        }
        if (Math.abs(o.pos.y - n.pos.y) > 0.6) {
          expect(diagonal).toBe(false); expect(n.ramp || o.ramp).toBe(true);
          const axis = dx !== 0 ? 1 : 2;
          expect(w.rampAxis[n.cz * w.cols + n.cx] === axis || w.rampAxis[o.cz * w.cols + o.cx] === axis).toBe(true);
        }
      }
    }
  });
  it('ramp rule: the ascend-axis edges exist (0 → 0.375 → 1.125 → 1.5) on both ramps', () => {
    for (const [a, b] of [[[33, 4], [34, 4]], [[34, 4], [35, 4]], [[35, 4], [36, 4]], [[44, 12], [44, 11]], [[44, 11], [44, 10]], [[44, 10], [44, 9]]]) {
      const n = nodeAt(a[0], a[1])!, m = nodeAt(b[0], b[1])!;
      expect(n.edges, `${a} → ${b}`).toContain(m.id);
    }
    expect(nodeAt(34, 4)!.ramp).toBe(true); expect(nodeAt(33, 4)!.ramp).toBe(false);
  });
  it('edge cost = 3D length × 1.4 when either end is nearWall', () => {
    const a = nodeAt(25, 5)!, b = nodeAt(26, 5)!;                       // open floor in Long
    expect(a.nearWall || b.nearWall).toBe(false); expect(nav.edgeCost(a.id, b.id)).toBeCloseTo(1, 12);
    const c = nodeAt(20, 2)!, d = nodeAt(21, 2)!;                       // along Long's north wall
    expect(c.nearWall && d.nearWall).toBe(true); expect(nav.edgeCost(c.id, d.id)).toBeCloseTo(1.4, 12);
    const e = nodeAt(34, 4)!, f = nodeAt(35, 4)!;                       // up the ramp: √(1 + 0.75²)
    expect(nav.edgeCost(e.id, f.id) / (e.nearWall || f.nearWall ? 1.4 : 1)).toBeCloseTo(1.25, 12);
    const g = nodeAt(20, 4)!, h = nodeAt(21, 5)!;
    expect(g.nearWall || h.nearWall).toBe(false); expect(nav.edgeCost(g.id, h.id)).toBeCloseTo(Math.SQRT2, 12);
    expect(nav.edgeCost(nodeAt(24, 5)!.id, nodeAt(25, 6)?.id ?? -1)).toBe(Infinity);   // (25,6) is a low-crate sub-cell
    expect(nav.edgeCost(a.id, nodeAt(40, 30)!.id)).toBe(Infinity);
  });
  it('is deterministic: two builds are identical', () => {
    const again = buildNavGraph(compileMap(DEPOT), buildStaticWorld(compileMap(DEPOT)));
    expect(JSON.stringify(again.nodes)).toBe(JSON.stringify(nav.nodes));
  });
});

describe('tags (§6.4.3)', () => {
  it('chokepoints include all 10 listed chokes (every node of each choke cell)', () => {
    expect(map.chokes.length).toBe(10);
    for (const c of map.chokes) {
      expect(nav.nodes[nav.nearest(c.pos)].chokepoint, c.id).toBe(true);
      for (let dz = -1; dz <= 0; dz++) for (let dx = -1; dx <= 0; dx++) { const n = nodeAt(Math.floor(c.pos.x) + dx, Math.floor(c.pos.z) + dz); if (n) expect(n.chokepoint, `${c.id} ${n.cx},${n.cz}`).toBe(true); }
    }
  });
  it('distance-transform chokepoints: 2 m corridors yes, rooms and 4 m openings no', () => {
    for (const [x, z] of [[8, 8], [9, 9], [8, 24], [9, 27]]) expect(nodeAt(x, z)!.chokepoint, `${x},${z}`).toBe(true);   // T spawn ↔ North / South passages (not listed)
    for (const [x, z] of [[20, 18], [5, 4], [40, 5], [31, 8], [32, 9], [44, 30]]) expect(nodeAt(x, z)!.chokepoint, `${x},${z}`).toBe(false); // mid, North Room, A site, A connector (4 m), B site
    expect(nodeAt(8, 8)!.clearance).toBe(1); expect(nodeAt(20, 18)!.clearance).toBeGreaterThan(2);
  });
  it('area / site / spawn tags', () => {
    expect(nodeAt(40, 4)!.site).toBe('a'); expect(nodeAt(40, 30)!.site).toBe('b'); expect(nodeAt(20, 18)!.site).toBeNull();
    expect(nodeAt(4, 12)!.spawnT).toBe(true); expect(nodeAt(42, 16)!.spawnCT).toBe(true); expect(nodeAt(20, 18)!.spawnT || nodeAt(20, 18)!.spawnCT).toBe(false);
    expect(nodeAt(34, 4)!.area).toBe('a_ramp'); expect(nodeAt(40, 4)!.area).toBe('site_a'); expect(nodeAt(20, 18)!.area).toBe('mid');
  });
  it('nearWall = within 0.5 m (XZ) of a solid ≥ 1 m tall; not for platform nodes beside the 0.4 m lip', () => {
    expect(nodeAt(20, 2)!.nearWall).toBe(true); expect(nodeAt(20, 4)!.nearWall).toBe(false);
    expect(nodeAt(21, 12)!.nearWall).toBe(false);                     // 1.0 m from the inset low crate
    expect(nodeAt(36, 4)!.nearWall).toBe(false);                      // platform edge next to the lip top (1.9 − 1.5 m)
    expect(nodeAt(29, 14)!.nearWall).toBe(true);                      // beside the sandbags
  });
  it('cover nodes exist behind every ~, c and X (coverScore > 0, coverHeight class ≥ the prop)', () => {
    const props = map.solids.map((s, i) => ({ s, i })).filter(({ s }) => s.kind === 'sandbag' || s.kind === 'lowcrate' || s.kind === 'tallcrate');
    expect(props.length).toBe(21);
    for (const { s, i } of props) {
      const want = s.kind === 'tallcrate' ? 2 : s.kind === 'sandbag' ? 1.2 : 1;
      const f = s.box.min.y;
      const behind = nav.nodes.filter((n) => Math.abs(n.pos.y - f) < 1e-6 && n.coverScore > 0 && n.coverHeight >= want && Math.hypot(Math.max(s.box.min.x - n.pos.x, 0, n.pos.x - s.box.max.x), Math.max(s.box.min.z - n.pos.z, 0, n.pos.z - s.box.max.z)) <= 1.2);
      expect(behind.length, `${s.kind} solid ${i}`).toBeGreaterThan(0);
    }
    expect(nodeAt(29, 14)!.coverHeight).toBe(1.2);                    // sandbags only
    expect(nodeAt(21, 12)!.coverHeight).toBe(1);                      // low crate only
    expect(nodeAt(20, 18)!.coverScore).toBe(0); expect(nodeAt(20, 18)!.coverHeight).toBe(0);
  });
});

describe('hold spots, cover queries, random nodes (§6.4.4)', () => {
  it('hold spots snap to walkable nodes inside their cell, on the right floor', () => {
    for (const h of map.holdSpots) {
      const hs = nav.holdSpot(h.id);
      const n = nav.nodes[hs.node];
      expect(w.walkable[n.cz * w.cols + n.cx]).toBe(1);
      expect(Math.abs(n.pos.x - h.pos.x)).toBeLessThanOrEqual(0.5); expect(Math.abs(n.pos.z - h.pos.z)).toBeLessThanOrEqual(0.5);
      expect(n.pos.y).toBe(h.pos.y); expect(hs.yaw).toBe(h.yaw); expect(hs.crouch).toBe(h.crouch);
    }
    expect(nav.nodes[nav.holdSpot('hold_sandbags_n').node].cx).toBe(32);    // the sub-cell right behind the sandbags
    expect(nav.nodes[nav.holdSpot('hold_a_crate').node].cx).toBe(38);       // right behind the platform crate
    expect(() => nav.holdSpot('nope')).toThrow(/unknown hold spot/);
  });
  it('coverNear returns a node within r whose segment to the threat is blocked', () => {
    const threat = v3(14, 0, 17);                                       // west mid, facing the sandbag line
    const p = map.holdSpots.find((h) => h.id === 'hold_sandbags_n')!.pos;
    const c = nav.coverNear(p, threat, 3)!;
    expect(c).not.toBeNull();
    expect(Math.hypot(c.pos.x - p.x, c.pos.z - p.z)).toBeLessThanOrEqual(3);
    expect(c.coverScore).toBeGreaterThan(0);
    expect(world.lineOfSight(v3(c.pos.x, c.pos.y + 0.9, c.pos.z), v3(threat.x, threat.y + 1.5, threat.z))).toBe(false);
    expect(c.pos.x).toBeGreaterThanOrEqual(32);                          // on the CT side of the bags
    expect(nav.coverNear(v3(20.5, 0, 18.5), v3(24, 0, 18), 0.5)).toBeNull();  // open mid, nothing within 0.5 m
    for (let k = 0; k < 50; k++) {                                       // property: whatever it returns is valid
      const rng = new Rng(100 + k);
      const a = nav.nodes[rng.int(0, nav.nodes.length - 1)].pos, t = nav.nodes[rng.int(0, nav.nodes.length - 1)].pos;
      const r = nav.coverNear(a, t, 4);
      if (r) { expect(Math.hypot(r.pos.x - a.x, r.pos.z - a.z)).toBeLessThanOrEqual(4); expect(world.lineOfSight(v3(r.pos.x, r.pos.y + 0.9, r.pos.z), v3(t.x, t.y + 1.5, t.z))).toBe(false); }
    }
  });
  it('randomNodeInArea returns nodes of that area, deterministically', () => {
    const areas: AreaId[] = ['t_spawn', 't_north', 't_south', 'long', 'mid', 'tunnel', 'ct_spawn', 'site_a', 'site_b', 'a_ramp', 'a_ramp_ct', 'mid_window', 'tunnel_window', 'a_connector', 'b_connector', 'b_door_ct'];
    for (const a of areas) {
      const r1 = new Rng(7), r2 = new Rng(7);
      for (let k = 0; k < 10; k++) { const n = nav.randomNodeInArea(a, r1); expect(n.area).toBe(a); expect(nav.randomNodeInArea(a, r2).id).toBe(n.id); }
    }
  });
});

describe('A* and string pulling (§6.4.5)', () => {
  it('every spawn reaches both sites; paths start at nearest(from), end at nearest(to), follow edges', () => {
    for (const s of [...map.spawns.T, ...map.spawns.CT]) for (const site of [map.plantSpots.a, map.plantSpots.b]) {
      const ids = nav.findPath(s.pos, site)!;
      expect(ids).not.toBeNull();
      expect(ids[0]).toBe(nav.nearest(s.pos)); expect(ids[ids.length - 1]).toBe(nav.nearest(site));
      for (let i = 1; i < ids.length; i++) expect(nav.nodes[ids[i - 1]].edges).toContain(ids[i]);
    }
  });
  it('route lengths over the pulled corners (measured T→A 39.3, CT→A 14.2, A→B 29.1 m)', () => {
    const tA = routeLength(nav, map.spawns.T[0].pos, map.plantSpots.a);
    const ctA = routeLength(nav, map.spawns.CT[0].pos, map.plantSpots.a);
    const aB = routeLength(nav, map.plantSpots.a, map.plantSpots.b);
    expect(tA.length).toBeCloseTo(39.3, 1); expect(Math.abs(tA.length - 44)).toBeLessThanOrEqual(5);
    expect(ctA.length).toBeCloseTo(14.2, 1); expect(Math.abs(ctA.length - 14)).toBeLessThanOrEqual(3);
    expect(aB.length).toBeCloseTo(29.1, 1); expect(Math.abs(aB.length - 31)).toBeLessThanOrEqual(4);
    expect(tA.corners[tA.corners.length - 1].y).toBe(1.5);
  });
  it('string pulling leaves 3–8 corners on the main routes; last corner = goal node; start excluded', () => {
    const routes: [Vec3, Vec3][] = [[map.spawns.T[0].pos, map.plantSpots.a], [map.spawns.T[0].pos, map.plantSpots.b], [map.spawns.CT[0].pos, map.plantSpots.a], [map.spawns.CT[0].pos, map.plantSpots.b], [map.plantSpots.a, map.plantSpots.b], [map.spawns.T[0].pos, map.spawns.CT[0].pos]];
    for (const [a, b] of routes) {
      const { ids, corners } = routeLength(nav, a, b);
      expect(corners.length).toBeGreaterThanOrEqual(3); expect(corners.length).toBeLessThanOrEqual(8);
      expect(corners[corners.length - 1]).toEqual(nav.nodes[ids[ids.length - 1]].pos);
      expect(corners[0]).not.toEqual(nav.nodes[ids[0]].pos);
    }
    expect(nav.pullString([])).toEqual([]);
    expect(nav.pullString([5])).toEqual([nav.nodes[5].pos]);
    const out: Vec3[] = [v3(9, 9, 9)];
    expect(nav.pullString(nav.findPath(map.spawns.T[0].pos, map.plantSpots.a)!, out)).toBe(out);
  });
  it('no pulled-path segment intersects a solid (knee-height samples, body ± 0.3 m), on main and 300 random routes', () => {
    const rng = new Rng(4242);
    const routes: [Vec3, Vec3][] = [[map.spawns.T[0].pos, map.plantSpots.a], [map.spawns.T[0].pos, map.plantSpots.b], [map.spawns.CT[0].pos, map.plantSpots.a], [map.spawns.CT[0].pos, map.plantSpots.b], [map.plantSpots.a, map.plantSpots.b]];
    for (let k = 0; k < 300; k++) routes.push([nav.nodes[rng.int(0, nav.nodes.length - 1)].pos, nav.nodes[rng.int(0, nav.nodes.length - 1)].pos]);
    const bad: string[] = [];
    let checked = 0;
    for (const [a, b] of routes) {
      const ids = nav.findPath(a, b);
      if (!ids) continue;
      const pts = [nav.nodes[ids[0]].pos, ...nav.pullString(ids)];
      for (let i = 1; i < pts.length; i++) {
        const p = pts[i - 1], q = pts[i];
        const d = Math.hypot(q.x - p.x, q.z - p.z);
        const steps = Math.max(1, Math.ceil(d / 0.1));
        const px = d > 0 ? (-(q.z - p.z) / d) * 0.3 : 0, pz = d > 0 ? ((q.x - p.x) / d) * 0.3 : 0;
        for (let s = 0; s <= steps; s++) for (const off of [0, 1, -1]) {
          const t = s / steps;
          const x = p.x + (q.x - p.x) * t + px * off, z = p.z + (q.z - p.z) * t + pz * off;
          const i0 = w.index(x, z);
          const knee = v3(x, w.floorY[i0] + 0.5, z);
          // the centre line stays on walkable sub-cells (closed squares: a point on a shared edge/corner may belong to either)
          const onGrid = [-1e-9, 1e-9].some((ex) => [-1e-9, 1e-9].some((ez) => w.walkable[w.index(x + ex, z + ez)] === 1));
          if (off === 0 && !onGrid) bad.push(`segment ${JSON.stringify(p)} → ${JSON.stringify(q)} leaves the walk grid at ${x.toFixed(2)},${z.toFixed(2)}`);
          if (map.solids.some((so) => so.kind !== 'ceiling' && aabbContains({ min: v3(so.box.min.x + 1e-6, so.box.min.y + 1e-6, so.box.min.z + 1e-6), max: v3(so.box.max.x - 1e-6, so.box.max.y - 1e-6, so.box.max.z - 1e-6) }, knee))) bad.push(`segment ${JSON.stringify(p)} → ${JSON.stringify(q)} hits a solid at ${x.toFixed(2)},${z.toFixed(2)}`);
          checked++;
        }
      }
    }
    expect(bad.slice(0, 5)).toEqual([]);
    expect(checked).toBeGreaterThan(10000);
  });
  it('a blocked node is avoided and the re-plan yields a different path; start/goal blocks are ignored', () => {
    const p1 = nav.findPath(map.spawns.T[0].pos, map.plantSpots.a)!;
    const k = p1[Math.floor(p1.length / 2)];
    const p2 = nav.findPath(map.spawns.T[0].pos, map.plantSpots.a, k)!;
    expect(p2).not.toBeNull(); expect(p2).not.toContain(k); expect(p2).not.toEqual(p1);
    expect(p2[0]).toBe(p1[0]); expect(p2[p2.length - 1]).toBe(p1[p1.length - 1]);
    expect(nav.findPath(map.spawns.T[0].pos, map.plantSpots.a, p1[0])).toEqual(p1);
    const door = nav.nearest(v3(9, 0, 9));                                     // block the (4,4) passage node → still a route via mid
    expect(nav.findPath(map.spawns.T[0].pos, map.plantSpots.a, door)).not.toContain(door);
  });
  it('LRU cache of 512 (from, to) pairs; cached results are copies and equal fresh searches; clearCache empties it', () => {
    const g = buildNavGraph(map, world) as NavGraph & { cacheSize: number };
    const rng = new Rng(9);
    const pairs: [Vec3, Vec3][] = [];
    for (let k = 0; k < 600; k++) pairs.push([g.nodes[rng.int(0, g.nodes.length - 1)].pos, g.nodes[rng.int(0, g.nodes.length - 1)].pos]);
    const first = pairs.map(([a, b]) => g.findPath(a, b));
    expect(g.cacheSize).toBe(512);
    const fresh = buildNavGraph(map, world);
    pairs.forEach(([a, b], i) => expect(g.findPath(a, b)).toEqual(first[i]));
    pairs.slice(0, 50).forEach(([a, b], i) => expect(fresh.findPath(a, b)).toEqual(first[i]));
    const r = g.findPath(pairs[599][0], pairs[599][1])!;
    r.push(-1);
    expect(g.findPath(pairs[599][0], pairs[599][1])).toEqual(first[599]);
    g.clearCache();
    expect(g.cacheSize).toBe(0);
  });
  it('500 random queries average < 1 ms (and pullString stays cheap)', () => {
    const g = buildNavGraph(map, world);
    const rng = new Rng(31337);
    const pairs: [Vec3, Vec3][] = [];
    for (let k = 0; k < 500; k++) pairs.push([g.nodes[rng.int(0, g.nodes.length - 1)].pos, g.nodes[rng.int(0, g.nodes.length - 1)].pos]);
    const paths: number[][] = [];
    const t0 = performance.now();
    for (const [a, b] of pairs) paths.push(g.findPath(a, b) ?? []);
    const t1 = performance.now();
    for (const ids of paths) g.pullString(ids);
    const t2 = performance.now();
    const findMs = (t1 - t0) / pairs.length, pullMs = (t2 - t1) / pairs.length;
    console.log(`[nav] findPath avg ${findMs.toFixed(3)} ms, pullString avg ${pullMs.toFixed(3)} ms over ${pairs.length} random queries`);
    expect(findMs).toBeLessThan(1);
    expect(pullMs).toBeLessThan(1);
  });
  it('nearest() snaps any point (even outside the grid or on a prop) to a close walkable node', () => {
    expect(nav.nearest(v3(40.5, 1.5, 4.5))).toBe(nodeAt(40, 4)!.id);
    const onCrate = nav.nodes[nav.nearest(v3(23, 1, 13))];               // top of the low crate (11,6)
    expect(Math.hypot(onCrate.pos.x - 23, onCrate.pos.z - 13)).toBeLessThan(2);
    expect(nav.nearest(v3(-5, 0, -5))).toBe(nodeAt(2, 2)!.id);
    expect(nav.nearest(v3(35.4, 0.8, 5.3))).toBe(nodeAt(35, 5)!.id);      // on the ramp
    expect(nav.nearest(v3(35, 0.5, 5.3))).toBe(nodeAt(34, 5)!.id);        // equidistant in XZ: the height term decides (0.375 vs 1.125)
    expect(nav.nearest(v3(35, 1.0, 5.3))).toBe(nodeAt(35, 5)!.id);
  });
});

describe('other maps and exports', () => {
  it('builds on the 6 × 6 BOX map', () => {
    const m = compileMap(BOX); const g = buildNavGraph(m, buildStaticWorld(m));
    expect(g.nodes.length).toBe(walkableCount(m.walk));
    expect(g.findPath(m.spawns.T[0].pos, m.spawns.CT[0].pos)).not.toBeNull();
    expect(g.ascii().split('\n').length).toBe(12);
  });
  it('NAV_BODY matches the player body', () => {
    expect(NAV_BODY).toEqual({ halfWidth: 0.3, height: 1.8, stepHeight: 0.5 });
  });
});
