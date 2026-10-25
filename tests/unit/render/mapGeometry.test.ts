/** Static map geometry (§10.1/§10.3): ≤ 8 draw buckets, invisible solids skipped, AO at seams, world-metre UVs. */
import { describe, it, expect } from 'vitest';
import { compileMap } from '../../../src/world/compile';
import { DEPOT } from '../../../src/maps/depot';
import { buildMapGeometry, bucketTriangles, MAP_BUCKETS, lin, AO, isDrawn, bucketFor } from '../../../src/render/mapGeometry';
import { menuDiorama } from '../../../src/render/dressing';

const match = compileMap(DEPOT, 'match');
const training = compileMap(DEPOT, 'training');
const geo = buildMapGeometry(match);

describe('render/mapGeometry', () => {
  it('uses at most 8 buckets (one merged draw call each) and every bucket is non-empty on Depot', () => {
    expect(MAP_BUCKETS.length).toBeLessThanOrEqual(8);
    for (const k of MAP_BUCKETS) expect(geo[k].idx.length, k).toBeGreaterThan(0);
  });
  it('stays well inside the triangle budget', () => {
    const t = Object.values(bucketTriangles(geo)).reduce((a, b) => a + b, 0);
    expect(t).toBeGreaterThan(1000);
    expect(t).toBeLessThan(40_000);
  });
  it('skips invisible solids: the training variant (extra seal solids) produces identical geometry', () => {
    expect(training.solids.some((s) => s.kind === 'seal')).toBe(true);
    expect(training.solids.filter((s) => s.kind === 'seal').every((s) => !isDrawn(s))).toBe(true);
    expect(match.solids.filter((s) => s.kind === 'ramp-step').every((s) => !isDrawn(s))).toBe(true);
    expect(bucketTriangles(buildMapGeometry(training))).toEqual(bucketTriangles(geo));
  });
  it('arrays are consistent (indices in range, unit normals, finite values)', () => {
    for (const k of MAP_BUCKETS) {
      const b = geo[k], n = b.pos.length / 3;
      expect(b.nrm.length).toBe(n * 3); expect(b.uv.length).toBe(n * 2); expect(b.col.length).toBe(n * 3);
      expect(b.idx.every((i) => i >= 0 && i < n), k).toBe(true);
      let badN = 0; for (let i = 0; i < n; i++) if (Math.abs(Math.hypot(b.nrm[i * 3], b.nrm[i * 3 + 1], b.nrm[i * 3 + 2]) - 1) > 1e-5) badN++;
      expect(badN, k).toBe(0);
      expect([...b.pos, ...b.uv, ...b.col].every(Number.isFinite)).toBe(true);
    }
  });
  it('all vertices lie inside the map bounds (+ the 3 cm door-frame lip)', () => {
    const bb = match.bounds;
    for (const k of MAP_BUCKETS) {
      const p = geo[k].pos;
      let out = 0;
      for (let i = 0; i < p.length; i += 3) {
        if (p[i] < bb.min.x - 0.05 || p[i] > bb.max.x + 0.05 || p[i + 2] < bb.min.z - 0.05 || p[i + 2] > bb.max.z + 0.05 || p[i + 1] < -1e-6 || p[i + 1] > bb.max.y + 1e-6) out++;
      }
      expect(out, k).toBe(0);
    }
  });
  it('floor UVs are world metres × 0.5 (1 repeat / 2 m)', () => {
    const f = geo.floor;
    for (let i = 0; i < 200; i++) { expect(f.uv[i * 2]).toBeCloseTo(f.pos[i * 3] * 0.5, 6); expect(f.uv[i * 2 + 1]).toBeCloseTo(-f.pos[i * 3 + 2] * 0.5, 6); }
  });
  it('floor AO: ×0.75 on the wall seam, 1 from 0.5 m away', () => {
    const f = geo.floor, walls = match.solids.filter((s) => s.kind === 'wall');
    let seam = 0, open = 0;
    for (let i = 0; i < f.pos.length / 3; i++) {
      const x = f.pos[i * 3], z = f.pos[i * 3 + 2], c = f.col[i * 3];
      if (f.pos[i * 3 + 1] !== 0) continue;
      let d = Infinity;
      for (const s of match.solids) if (isDrawn(s) && s.kind !== 'ceiling' && s.kind !== 'lintel' && s.box.min.y <= 0.01 && s.box.max.y >= 0.2) d = Math.min(d, Math.hypot(Math.max(s.box.min.x - x, 0, x - s.box.max.x), Math.max(s.box.min.z - z, 0, z - s.box.max.z)));
      if (d === 0 && walls.length) { expect(c).toBeCloseTo(lin(AO.factor), 6); seam++; }
      if (d >= AO.dist) { expect(c).toBeCloseTo(1, 6); open++; }
    }
    expect(seam).toBeGreaterThan(50); expect(open).toBeGreaterThan(50);
  });
  it('wall faces darken toward the floor seam and the lowest band uses concrete_base', () => {
    const b = geo.concrete_base;
    expect(b.idx.length).toBeGreaterThan(0);
    let darkest = 1; for (let i = 0; i < b.col.length; i += 3) darkest = Math.min(darkest, b.col[i]);
    expect(darkest).toBeCloseTo(lin(AO.factor), 6);
    for (let i = 1; i < b.pos.length; i += 3) expect(b.pos[i]).toBeLessThanOrEqual(1.5 + 0.8 + 1e-6);
  });
  it('maps materials to buckets', () => {
    expect(bucketFor(null)).toBe(null); expect(bucketFor('ceiling')).toBe('concrete'); expect(bucketFor('door_frame')).toBe('metal'); expect(bucketFor('lamp')).toBe('site_marker');
  });
  it('greedy / per-cell floor rectangles (world lane layout) cover exactly the same visible floor area', () => {
    const area = (g: ReturnType<typeof buildMapGeometry>) => {
      let a = 0;
      for (const k of ['floor', 'floor_stripe', 'metal'] as const) {
        const b = g[k];
        for (let t = 0; t < b.idx.length; t += 3) {
          const [i, j, l] = [b.idx[t] * 3, b.idx[t + 1] * 3, b.idx[t + 2] * 3];
          if (b.nrm[i + 1] !== 1) continue;
          const ux = b.pos[j] - b.pos[i], uz = b.pos[j + 2] - b.pos[i + 2], vx = b.pos[l] - b.pos[i], vz = b.pos[l + 2] - b.pos[i + 2];
          a += Math.abs(ux * vz - uz * vx) / 2;
        }
      }
      return a;
    };
    const cells = [];
    for (let cz = 0; cz < DEPOT.height; cz++) for (let cx = 0; cx < DEPOT.width; cx++) {
      if (DEPOT.grid[cz][cx] === '#') continue;
      const y = match.floorY(cx * 2 + 1, cz * 2 + 1);
      cells.push({ rect: { x0: cx * 2, z0: cz * 2, x1: cx * 2 + 2, z1: cz * 2 + 2, y }, material: y > 0 ? ('metal' as const) : ('floor' as const) });
    }
    const split = buildMapGeometry({ ...match, renderHints: { ...match.renderHints, floorQuads: cells } });
    expect(area(split)).toBeCloseTo(area(geo), 3);
  });
  it('the menu diorama is a valid input', () => {
    const d = buildMapGeometry(menuDiorama());
    expect(Object.values(bucketTriangles(d)).reduce((a, b) => a + b, 0)).toBeGreaterThan(100);
  });
});
