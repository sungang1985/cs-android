/**
 * Property test (§12.1 world/compile): random small grids (props, doors, a random platform with an optional ramp,
 * random training seals) never produce solids outside the bounds or overlapping (seals exempt, touching allowed),
 * and compileMap never fails with anything but MapCompileError. Seeded, so failures reproduce.
 */
import { describe, it, expect } from 'vitest';
import { compileMap, buildSolids, solidProblems, MapCompileError } from '@/world/compile';
import { BOX } from '@/maps/box';
import { Rng } from '@/core/rng';
import { aabb } from '@/core/math';
import type { MapSource, CellRect } from '@/world/types';

const INTERIOR = '......####XcL~+';
const ON_PLATFORM = '^^^^^cX#';

function randomSource(rng: Rng): MapSource {
  const w = rng.int(4, 11), h = rng.int(4, 9);
  const g: string[][] = [];
  for (let z = 0; z < h; z++) {
    const row: string[] = [];
    for (let x = 0; x < w; x++) row.push(x === 0 || z === 0 || x === w - 1 || z === h - 1 ? '#' : INTERIOR[rng.int(0, INTERIOR.length - 1)]);
    g.push(row);
  }
  g[1][1] = '.'; // site / plant / training cell
  const platforms: MapSource['platforms'] = [];
  const ramps: MapSource['ramps'] = [];
  if (w >= 5 && rng.chance(0.7)) {
    const x0 = rng.int(2, w - 2), x1 = rng.int(x0, w - 2), z0 = rng.int(1, h - 2), z1 = rng.int(z0, h - 2);
    const y = rng.pick([0.5, 1.0, 1.5, 2.0]);
    platforms.push({ rect: [x0, z0, x1, z1], y, material: 'metal', surface: 'metal' });
    for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) g[z][x] = ON_PLATFORM[rng.int(0, ON_PLATFORM.length - 1)];
    if (x0 >= 3 && rng.chance(0.6)) {
      const z = rng.int(z0, z1);
      g[z][x0 - 1] = '='; g[z][x0 - 2] = '.'; g[z][x0] = '^';
      ramps.push({ cell: [x0 - 1, z], ascend: 'e', from: 0, to: y, steps: 4 });
    }
  }
  const sealed: CellRect[] = [];
  for (let i = rng.int(0, 2); i > 0; i--) { const x0 = rng.int(1, w - 2), z0 = rng.int(1, h - 2); sealed.push([x0, z0, rng.int(x0, w - 2), rng.int(z0, h - 2)]); }
  return {
    ...structuredClone(BOX), id: 'random', width: w, height: h, grid: g.map((r) => r.join('')), platforms, ramps,
    areas: [], sites: { a: [1, 1, 1, 1], b: [1, 1, 1, 1] }, plantSpots: { a: [1, 1], b: [1, 1] },
    spawns: { T: [], CT: [] }, holdSpots: [], chokes: [], training: { sealed, targets: [[1, 1]], onboardingCell: [1, 1] },
  };
}

describe('compileMap property: random small grids', () => {
  it('never produce solids outside the bounds or overlapping (600 grids × 2 variants)', () => {
    const rng = new Rng(20261025);
    let compiled = 0, solids = 0;
    const bad: string[] = [];
    for (let n = 0; n < 600; n++) {
      const src = randomSource(rng);
      for (const variant of ['match', 'training'] as const) {
        const bounds = aabb(0, 0, 0, src.width * 2, src.ceilingY + 0.5, src.height * 2);
        const built = buildSolids(src, variant).solids;
        solids += built.length;
        // independent check (not trusting solidProblems); failures are collected so the loop stays fast
        for (let i = 0; i < built.length; i++) {
          const a = built[i].box;
          const inside = a.min.x >= 0 && a.min.y >= 0 && a.min.z >= 0 && a.max.x <= bounds.max.x && a.max.y <= bounds.max.y && a.max.z <= bounds.max.z;
          if (!inside || !(a.min.x < a.max.x && a.min.y < a.max.y && a.min.z < a.max.z)) bad.push(`grid ${n} ${variant}: solid ${i} (${built[i].kind}) out of bounds or empty\n${src.grid.join('\n')}`);
          if (built[i].kind === 'seal') continue;
          for (let j = i + 1; j < built.length; j++) {
            if (built[j].kind === 'seal') continue;
            const b = built[j].box, e = 1e-9;
            if (a.min.x < b.max.x - e && a.max.x > b.min.x + e && a.min.y < b.max.y - e && a.max.y > b.min.y + e && a.min.z < b.max.z - e && a.max.z > b.min.z + e) bad.push(`grid ${n} ${variant}: ${built[i].kind} ${i} overlaps ${built[j].kind} ${j}\n${src.grid.join('\n')}`);
          }
        }
        for (const p of solidProblems(built, bounds)) bad.push(`grid ${n} ${variant}: ${p}`);
        // the full compiler either succeeds or reports a MapCompileError (these sources are valid by construction)
        try {
          const map = compileMap(src, variant);
          compiled++;
          if (map.renderHints.solids.length !== map.solids.length || map.walk.walkable.length !== src.width * src.height * 4) bad.push(`grid ${n} ${variant}: inconsistent CompiledMap`);
        } catch (e) {
          if (!(e instanceof MapCompileError)) throw e;
          bad.push(`grid ${n} ${variant}: ${e.message}\n${src.grid.join('\n')}`);
        }
      }
    }
    expect(bad.slice(0, 3)).toEqual([]);
    expect(compiled).toBe(1200);
    expect(solids).toBeGreaterThan(1200 * 4);
  });
});
