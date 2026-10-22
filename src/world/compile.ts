/**
 * Map compiler: MapSource (2 m glyph grid) → CompiledMap (solids, floor function, 1 m walk grid, world-space
 * areas/spawns/hold spots, render hints). Deterministic. DESIGN.md §3.5.
 */
import { Aabb, Vec3, v3, aabb, DEG } from '../core/math';
import { StaticWorld, type Solid } from './collision';
import type { MapSource, CompiledMap, SolidDef, WalkGrid, WorldRect, WorldArea, AreaId, RenderHints, CellRect, Cell, MaterialId, Glyph } from './types';
import { BODY } from '../sim/state';

const WALKABLE_GLYPHS = new Set<Glyph>(['.', '^', '+', 'A', 'B', 'T', 'C', '=']);
const PROP_GLYPHS = new Set<Glyph>(['X', 'c', '~', 'L']);

export class MapCompileError extends Error {}

function cellRectToWorld(r: CellRect, cell: number, y: number): WorldRect {
  return { x0: r[0] * cell, z0: r[1] * cell, x1: (r[2] + 1) * cell, z1: (r[3] + 1) * cell, y };
}
function cellCenter(c: Cell, cell: number, y: number): Vec3 { return v3((c[0] + 0.5) * cell, y, (c[1] + 0.5) * cell); }
function inRect(r: CellRect, cx: number, cz: number): boolean { return cx >= r[0] && cx <= r[2] && cz >= r[1] && cz <= r[3]; }

export function compileMap(src: MapSource, variant: 'match' | 'training' = 'match'): CompiledMap {
  const cell = src.cellSize;
  if (src.grid.length !== src.height) throw new MapCompileError(`grid has ${src.grid.length} rows, expected ${src.height}`);
  src.grid.forEach((row, i) => { if (row.length !== src.width) throw new MapCompileError(`row ${i} has ${row.length} glyphs, expected ${src.width}`); });
  const glyph = (cx: number, cz: number): Glyph => (cx < 0 || cz < 0 || cx >= src.width || cz >= src.height ? '#' : (src.grid[cz][cx] as Glyph));
  const platformAt = (cx: number, cz: number) => src.platforms.find((p) => inRect(p.rect, cx, cz)) ?? null;
  const floorOfCell = (cx: number, cz: number): number => platformAt(cx, cz)?.y ?? 0;
  const tCount = src.grid.join('').split('T').length - 1, cCount = src.grid.join('').split('C').length - 1;
  if (tCount !== src.spawns.T.length || cCount !== src.spawns.CT.length) throw new MapCompileError(`spawn glyph count T=${tCount} C=${cCount} does not match spawn lists`);

  const solids: SolidDef[] = [];
  const push = (box: Aabb, kind: SolidDef['kind'], material: MaterialId | null, surface: SolidDef['surface'], penetrable = false, penetrationFactor = 0, tag?: string) => {
    solids.push({ box, kind, material, surface, penetrable, penetrationFactor, tag });
  };

  // 1. Walls: greedy merge of horizontal runs, then vertical merge of identical runs.
  const runs: { x0: number; x1: number; z0: number; z1: number }[] = [];
  for (let cz = 0; cz < src.height; cz++) {
    let cx = 0;
    while (cx < src.width) {
      if (glyph(cx, cz) !== '#') { cx++; continue; }
      let x1 = cx; while (x1 + 1 < src.width && glyph(x1 + 1, cz) === '#') x1++;
      const prev = runs.find((r) => r.x0 === cx && r.x1 === x1 && r.z1 === cz - 1);
      if (prev) prev.z1 = cz; else runs.push({ x0: cx, x1, z0: cz, z1: cz });
      cx = x1 + 1;
    }
  }
  for (const r of runs) push(aabb(r.x0 * cell, 0, r.z0 * cell, (r.x1 + 1) * cell, src.wallHeight, (r.z1 + 1) * cell), 'wall', src.materials.wall, 'concrete', false, 0, 'wall');

  // 2. Platform slabs
  for (const p of src.platforms) {
    const r = cellRectToWorld(p.rect, cell, p.y);
    push(aabb(r.x0, 0, r.z0, r.x1, p.y, r.z1), 'platform', p.material, p.surface, false, 0, 'platform');
  }

  // 3. Props, lintels, ramps
  const doorCells: { cx: number; cz: number; axis: 'x' | 'z' }[] = [];
  for (let cz = 0; cz < src.height; cz++) for (let cx = 0; cx < src.width; cx++) {
    const g = glyph(cx, cz);
    const f = floorOfCell(cx, cz);
    const x0 = cx * cell, z0 = cz * cell;
    if (PROP_GLYPHS.has(g)) {
      const def = src.props[g as 'X' | 'c' | '~' | 'L'];
      const kind: SolidDef['kind'] = g === 'X' ? 'tallcrate' : g === 'c' ? 'lowcrate' : g === '~' ? 'sandbag' : 'lip';
      push(aabb(x0 + def.inset, f, z0 + def.inset, x0 + cell - def.inset, f + def.height, z0 + cell - def.inset), kind, def.material, def.surface, def.penetrable, def.penetrationFactor, g);
    } else if (g === '+') {
      const axis: 'x' | 'z' = glyph(cx - 1, cz) === '#' && glyph(cx + 1, cz) === '#' ? 'z' : 'x';
      doorCells.push({ cx, cz, axis });
      push(aabb(x0, f + src.lintelY, z0, x0 + cell, src.wallHeight, z0 + cell), 'lintel', src.materials.door, 'concrete', false, 0, 'lintel');
    }
  }
  for (const r of src.ramps) {
    const [cx, cz] = r.cell;
    const x0 = cx * cell, z0 = cz * cell;
    const depth = cell / r.steps;
    for (let i = 0; i < r.steps; i++) {
      const top = r.from + ((i + 1) * (r.to - r.from)) / r.steps;
      let box: Aabb;
      switch (r.ascend) {
        case 'e': box = aabb(x0 + i * depth, r.from, z0, x0 + (i + 1) * depth, top, z0 + cell); break;
        case 'w': box = aabb(x0 + cell - (i + 1) * depth, r.from, z0, x0 + cell - i * depth, top, z0 + cell); break;
        case 's': box = aabb(x0, r.from, z0 + i * depth, x0 + cell, top, z0 + (i + 1) * depth); break;
        case 'n': box = aabb(x0, r.from, z0 + cell - (i + 1) * depth, x0 + cell, top, z0 + cell - i * depth); break;
      }
      push(box, 'ramp-step', null, 'metal', false, 0, 'ramp');
    }
  }

  // 4. Ceiling
  push(aabb(0, src.ceilingY, 0, src.width * cell, src.ceilingY + 0.5, src.height * cell), 'ceiling', src.materials.ceiling, 'concrete', false, 0, 'ceiling');

  // 5. Training seals (invisible)
  let training: CompiledMap['training'] | undefined;
  if (variant === 'training' && src.training) {
    for (const r of src.training.sealed) {
      const w = cellRectToWorld(r, cell, 0);
      push(aabb(w.x0, 0, w.z0, w.x1, src.wallHeight, w.z1), 'seal', null, 'concrete', false, 0, 'seal');
    }
    training = {
      sealed: src.training.sealed.map((r) => { const w = cellRectToWorld(r, cell, 0); return aabb(w.x0, 0, w.z0, w.x1, src.wallHeight, w.z1); }),
      targets: src.training.targets.map((c) => cellCenter(c, cell, floorOfCell(c[0], c[1]))),
      onboardingPos: cellCenter(src.training.onboardingCell, cell, floorOfCell(src.training.onboardingCell[0], src.training.onboardingCell[1])),
    };
  }

  const bounds = aabb(0, 0, 0, src.width * cell, src.ceilingY + 0.5, src.height * cell);
  const floorY = (x: number, z: number): number => floorOfCell(Math.floor(x / cell), Math.floor(z / cell));

  // 6. Walk grid (1 m), sampled against a temporary StaticWorld (ramp steps are climbable, so they never block)
  const world = new StaticWorld(solids.map((s) => ({ box: s.box, surface: s.surface, penetrable: s.penetrable, penetrationFactor: s.penetrationFactor, kind: s.kind, tag: s.tag })), { groundY: 0, bounds });
  const cols = src.width * cell, rows = src.height * cell;
  const walkable = new Uint8Array(cols * rows), ramp = new Uint8Array(cols * rows), fy = new Float32Array(cols * rows);
  const hw = BODY.halfWidth, h = BODY.standHeight;
  const tmp: Solid[] = [];
  for (let sz = 0; sz < rows; sz++) for (let sx = 0; sx < cols; sx++) {
    const i = sz * cols + sx;
    const x = sx + 0.5, z = sz + 0.5;
    const cx = Math.floor(x / cell), cz = Math.floor(z / cell);
    const g = glyph(cx, cz);
    const onRamp = src.ramps.some((r) => r.cell[0] === cx && r.cell[1] === cz);
    ramp[i] = onRamp ? 1 : 0;
    if (!WALKABLE_GLYPHS.has(g) && g !== 'c') { fy[i] = floorOfCell(cx, cz); continue; }
    const floor = world.floorHeightAt(x, z, src.wallHeight - 0.01, 0.15);
    fy[i] = floor;
    const box: Aabb = { min: v3(x - hw, floor + 1e-3, z - hw), max: v3(x + hw, floor + h, z + hw) };
    world.query(box, tmp);
    const blocked = tmp.some((s) => s.kind !== 'ramp-step') || (variant === 'training' && training !== undefined && false);
    walkable[i] = blocked ? 0 : 1;
  }
  const walk: WalkGrid = {
    cell: 1, cols, rows, walkable, ramp, floorY: fy, originX: 0, originZ: 0,
    index(x: number, z: number): number {
      const sx = Math.min(cols - 1, Math.max(0, Math.floor(x))), sz = Math.min(rows - 1, Math.max(0, Math.floor(z)));
      return sz * cols + sx;
    },
  };

  // 7. World-space data
  const areas: WorldArea[] = src.areas.map((a) => ({ id: a.id, rect: cellRectToWorld(a.rect, cell, floorOfCell(a.rect[0], a.rect[1])) }));
  const areasBySize = [...src.areas].map((a, i) => ({ a, i, size: (a.rect[2] - a.rect[0] + 1) * (a.rect[3] - a.rect[1] + 1) })).sort((p, q) => p.size - q.size);
  const areaAt = (x: number, z: number): AreaId | null => {
    const cx = Math.floor(x / cell), cz = Math.floor(z / cell);
    for (const e of areasBySize) if (inRect(e.a.rect, cx, cz)) return e.a.id;
    return null;
  };
  const sites = { a: cellRectToWorld(src.sites.a, cell, floorOfCell(src.sites.a[0], src.sites.a[1])), b: cellRectToWorld(src.sites.b, cell, floorOfCell(src.sites.b[0], src.sites.b[1])) };
  const plantSpots = { a: cellCenter(src.plantSpots.a, cell, floorOfCell(...src.plantSpots.a)), b: cellCenter(src.plantSpots.b, cell, floorOfCell(...src.plantSpots.b)) };
  const spawns = {
    T: src.spawns.T.map((s) => ({ pos: cellCenter(s.cell, cell, floorOfCell(...s.cell)), yaw: s.yawDeg * DEG })),
    CT: src.spawns.CT.map((s) => ({ pos: cellCenter(s.cell, cell, floorOfCell(...s.cell)), yaw: s.yawDeg * DEG })),
  };
  const holdSpots = src.holdSpots.map((hs) => ({ id: hs.id, pos: cellCenter(hs.cell, cell, floorOfCell(...hs.cell)), yaw: hs.yawDeg * DEG, team: hs.team, crouch: hs.crouch }));
  const chokes = src.chokes.map((c) => ({ id: c.id, pos: cellCenter(c.cell, cell, floorOfCell(...c.cell)) }));

  // 8. Render hints
  const floorQuads: RenderHints['floorQuads'] = [{ rect: { x0: 0, z0: 0, x1: src.width * cell, z1: src.height * cell, y: 0 }, material: src.materials.floor }];
  for (const p of src.platforms) floorQuads.push({ rect: cellRectToWorld(p.rect, cell, p.y), material: p.material });
  const lamps: Vec3[] = [];
  for (let z = 2; z < src.height * cell; z += 4) for (let x = 2; x < src.width * cell; x += 4) {
    const g = glyph(Math.floor(x / cell), Math.floor(z / cell));
    if (g !== '#') lamps.push(v3(x, src.ceilingY - 0.1, z));
  }
  const radarWalls: RenderHints['radarWalls'] = [];
  for (const s of solids) {
    if (s.kind !== 'wall' && s.kind !== 'lip' && s.kind !== 'tallcrate') continue;
    const b = s.box;
    radarWalls.push({ x0: b.min.x, z0: b.min.z, x1: b.max.x, z1: b.min.z }, { x0: b.max.x, z0: b.min.z, x1: b.max.x, z1: b.max.z }, { x0: b.max.x, z0: b.max.z, x1: b.min.x, z1: b.max.z }, { x0: b.min.x, z0: b.max.z, x1: b.min.x, z1: b.min.z });
  }
  const wallSigns: RenderHints['wallSigns'] = [];
  for (const site of ['a', 'b'] as const) {
    const r = src.sites[site];
    // find a wall cell adjacent to the site rect (scan east side first, then north/south)
    const cands: { cx: number; cz: number; yaw: number }[] = [];
    for (let cz = r[1]; cz <= r[3]; cz++) { cands.push({ cx: r[2] + 1, cz, yaw: 90 * DEG }); cands.push({ cx: r[0] - 1, cz, yaw: -90 * DEG }); }
    for (let cx = r[0]; cx <= r[2]; cx++) { cands.push({ cx, cz: r[1] - 1, yaw: 180 * DEG }); cands.push({ cx, cz: r[3] + 1, yaw: 0 }); }
    const w = cands.find((c) => glyph(c.cx, c.cz) === '#');
    if (w) {
      const f = floorOfCell(r[0], r[1]);
      const px = w.yaw === 90 * DEG ? w.cx * cell : w.yaw === -90 * DEG ? (w.cx + 1) * cell : (w.cx + 0.5) * cell;
      const pz = w.yaw === 180 * DEG ? (w.cz + 1) * cell : w.yaw === 0 ? w.cz * cell : (w.cz + 0.5) * cell;
      wallSigns.push({ site, pos: v3(px, f + 2.2, pz), yaw: w.yaw });
    }
  }
  const renderHints: RenderHints = {
    solids: solids.map((s) => ({ material: s.material, kind: s.kind, uvScale: 0.5 })),
    floorQuads,
    ramps: src.ramps.map((r) => {
      const [cx, cz] = r.cell; const x0 = cx * cell, z0 = cz * cell;
      const origin = r.ascend === 'e' ? v3(x0, r.from, z0 + cell / 2) : r.ascend === 'w' ? v3(x0 + cell, r.from, z0 + cell / 2) : r.ascend === 's' ? v3(x0 + cell / 2, r.from, z0) : v3(x0 + cell / 2, r.from, z0 + cell);
      return { origin, ascend: r.ascend, from: r.from, to: r.to, width: 2 as const, length: 2 as const, material: 'metal' as MaterialId };
    }),
    doorFrames: doorCells.map((d) => ({ pos: v3((d.cx + 0.5) * cell, floorOfCell(d.cx, d.cz), (d.cz + 0.5) * cell), axis: d.axis, width: 2 as const, height: 2.6 as const, material: src.materials.door })),
    lamps,
    siteDecals: [{ site: 'a', rect: sites.a }, { site: 'b', rect: sites.b }],
    wallSigns,
    radarWalls,
    bounds, ceilingY: src.ceilingY,
  };

  return { id: src.id, cellSize: cell, width: src.width, height: src.height, bounds, solids, floorY, walk, areas, areaAt, sites, plantSpots, spawns, holdSpots, chokes, renderHints, training };
}

/** Builds the collision world for a compiled map (solid ids == map.solids indices). */
export function buildStaticWorld(map: CompiledMap): StaticWorld {
  return new StaticWorld(map.solids.map((s) => ({ box: s.box, surface: s.surface, penetrable: s.penetrable, penetrationFactor: s.penetrationFactor, kind: s.kind, tag: s.tag })), { groundY: 0, bounds: map.bounds });
}

/** BFS reachability over the walk grid (tests, nav-dump). */
export function walkReachable(map: CompiledMap, from: Vec3, to: Vec3): boolean {
  const w = map.walk;
  const start = w.index(from.x, from.z), goal = w.index(to.x, to.z);
  if (!w.walkable[start] || !w.walkable[goal]) return false;
  const seen = new Uint8Array(w.cols * w.rows); const q = [start]; seen[start] = 1;
  while (q.length) {
    const i = q.shift()!;
    if (i === goal) return true;
    const x = i % w.cols, z = Math.floor(i / w.cols);
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, nz = z + dz;
      if (nx < 0 || nz < 0 || nx >= w.cols || nz >= w.rows) continue;
      const j = nz * w.cols + nx;
      if (seen[j] || !w.walkable[j]) continue;
      if (!w.ramp[i] && !w.ramp[j] && Math.abs(w.floorY[j] - w.floorY[i]) > 0.6) continue;
      seen[j] = 1; q.push(j);
    }
  }
  return false;
}
