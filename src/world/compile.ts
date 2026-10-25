/**
 * Map compiler: MapSource (2 m glyph grid) → CompiledMap (solids, floor function, 1 m walk grid, world-space
 * areas/spawns/hold spots, render hints). Deterministic (row-major scans, no Map/Set iteration). DESIGN.md §3.5.
 *
 * Stages (each exported for tests and tools):
 *   validateSource  structural assertions on the source (row lengths, glyphs, spawns, platforms, ramps, cells)
 *   buildSolids     geometry: merged walls, props, platform slabs, lintels, ramp stairs, ceiling, training seals
 *   solidProblems   every solid inside bounds, no two solids overlap (touching faces are fine)
 *   buildWalkGrid   1 m walk grid with ramp wedge heights
 *   compileMap      all of the above + BFS reachability assertions + world-space data + render hints
 *
 * Overlap rule: solids may touch but never overlap. Ramp steps only touch the platform slab (they end exactly at
 * the slab's edge), lintels only touch the neighbouring wall runs, props sit on (touch) the slab. The one exemption
 * is `kind: 'seal'` (training only): a seal closes a whole opening and may cover lintels, ramp steps or props there;
 * seals are invisible and collision-only, so overlapping is harmless.
 */
import { type Aabb, type Vec3, v3, aabb, DEG } from '../core/math';
import { StaticWorld, type Solid } from './collision';
import type { MapSource, CompiledMap, SolidDef, SolidKind, WalkGrid, WorldRect, WorldArea, AreaId, RenderHints, CellRect, Cell, MaterialId, Glyph } from './types';
import { BODY } from '../sim/state';

const GLYPHS = '#.^+XcL~=ABTC';
/** Glyphs a body can stand in (the compiler treats ^ A B T C + = as floor). */
const OPEN = '.^+ABTC=';
/** Glyphs allowed inside a platform rect (§3.5). */
const PLATFORM_OK = '^AcX#=';
const PROP_GLYPHS = 'XcL~';
const DEFAULT_PROP_KIND: Record<'X' | 'c' | '~' | 'L', SolidKind> = { X: 'tallcrate', c: 'lowcrate', '~': 'sandbag', L: 'lip' };
/** Δfloor limit between walk-grid neighbours (§6.4); ramp-axis steps are exempt. */
export const WALK_MAX_STEP = 0.6;
const EPS = 1e-6;

export class MapCompileError extends Error {
  constructor(message: string) { super(message); this.name = 'MapCompileError'; }
}

export interface DoorCell { cx: number; cz: number; axis: 'x' | 'z' }

const isOpen = (g: string): boolean => OPEN.includes(g);
const cellStr = (cx: number, cz: number): string => `(${cx}, ${cz})`;
function cellRectToWorld(r: CellRect, cell: number, y: number): WorldRect {
  return { x0: r[0] * cell, z0: r[1] * cell, x1: (r[2] + 1) * cell, z1: (r[3] + 1) * cell, y };
}
function cellCenter(c: Cell, cell: number, y: number): Vec3 { return v3((c[0] + 0.5) * cell, y, (c[1] + 0.5) * cell); }
function inRect(r: CellRect, cx: number, cz: number): boolean { return cx >= r[0] && cx <= r[2] && cz >= r[1] && cz <= r[3]; }
const ASCEND_DELTA: Record<'n' | 's' | 'e' | 'w', Cell> = { n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0] };

/** Cell-level lookups shared by every stage. */
export interface MapContext {
  src: MapSource; cell: number;
  inGrid(cx: number, cz: number): boolean;
  /** '#' outside the grid */
  glyph(cx: number, cz: number): Glyph;
  /** index into src.platforms or −1 */
  platformAt(cx: number, cz: number): number;
  /** platform y inside a platform rect, else 0 (§3.5 step 2: glyphs never encode height) */
  floorOfCell(cx: number, cz: number): number;
  /** index into src.ramps or −1 */
  rampAt(cx: number, cz: number): number;
}

export function mapContext(src: MapSource): MapContext {
  const inGrid = (cx: number, cz: number) => cx >= 0 && cz >= 0 && cx < src.width && cz < src.height;
  const platformAt = (cx: number, cz: number): number => { for (let i = 0; i < src.platforms.length; i++) if (inRect(src.platforms[i].rect, cx, cz)) return i; return -1; };
  return {
    src, cell: src.cellSize, inGrid, platformAt,
    glyph: (cx, cz) => (inGrid(cx, cz) ? ((src.grid[cz] ?? '')[cx] ?? '#') as Glyph : '#'),
    floorOfCell: (cx, cz) => { const p = platformAt(cx, cz); return p >= 0 ? src.platforms[p].y : 0; },
    rampAt: (cx, cz) => { for (let i = 0; i < src.ramps.length; i++) if (src.ramps[i].cell[0] === cx && src.ramps[i].cell[1] === cz) return i; return -1; },
  };
}

// ───────────────────────────── 0. source validation ─────────────────────────────

/** Structural assertions (§3.5 "Compiler assertions", the source-level half). Throws MapCompileError. */
export function validateSource(src: MapSource, variant: 'match' | 'training' = 'match'): void {
  const fail = (m: string): never => { throw new MapCompileError(`map '${src.id}': ${m}`); };
  if (src.cellSize !== 2) fail(`cellSize must be 2, got ${String(src.cellSize)}`);
  if (!Number.isInteger(src.width) || !Number.isInteger(src.height) || src.width < 3 || src.height < 3) fail(`bad grid size ${src.width} × ${src.height}`);
  if (src.grid.length !== src.height) fail(`grid has ${src.grid.length} rows, expected exactly ${src.height}`);
  src.grid.forEach((row, z) => {
    if (row.length !== src.width) fail(`row ${z} has ${row.length} glyphs, expected exactly ${src.width}: "${row}"`);
    for (let x = 0; x < row.length; x++) if (!GLYPHS.includes(row[x])) fail(`unknown glyph '${row[x]}' at cell ${cellStr(x, z)}`);
  });
  if (!(src.lintelY > 0 && src.lintelY < src.wallHeight && src.wallHeight <= src.ceilingY)) fail(`need 0 < lintelY (${src.lintelY}) < wallHeight (${src.wallHeight}) ≤ ceilingY (${src.ceilingY})`);
  const ctx = mapContext(src);
  const checkCell = (c: Cell, what: string, open: boolean) => {
    if (!ctx.inGrid(c[0], c[1])) fail(`${what} cell ${cellStr(c[0], c[1])} is outside the ${src.width} × ${src.height} grid`);
    if (open && !isOpen(ctx.glyph(c[0], c[1]))) fail(`${what} cell ${cellStr(c[0], c[1])} is '${ctx.glyph(c[0], c[1])}', expected a floor glyph (${OPEN})`);
  };
  const checkRect = (r: CellRect, what: string) => {
    if (!(r[0] <= r[2] && r[1] <= r[3])) fail(`${what} rect [${r.join(', ')}] is inverted`);
    if (!ctx.inGrid(r[0], r[1]) || !ctx.inGrid(r[2], r[3])) fail(`${what} rect [${r.join(', ')}] leaves the grid`);
  };

  // props
  for (const g of PROP_GLYPHS) {
    const p = src.props[g as 'X' | 'c' | '~' | 'L'];
    if (!p) fail(`props['${g}'] is missing`);
    if (!(p.height > 0) || !(p.inset >= 0 && p.inset < src.cellSize / 2)) fail(`props['${g}'] needs height > 0 and 0 ≤ inset < ${src.cellSize / 2}`);
  }

  // spawns: glyph counts match the lists, each spawn on its own team glyph, no duplicates
  let tCount = 0, cCount = 0;
  for (const row of src.grid) for (const g of row) { if (g === 'T') tCount++; else if (g === 'C') cCount++; }
  if (tCount !== src.spawns.T.length) fail(`${tCount} 'T' glyphs but ${src.spawns.T.length} T spawns listed`);
  if (cCount !== src.spawns.CT.length) fail(`${cCount} 'C' glyphs but ${src.spawns.CT.length} CT spawns listed`);
  for (const [team, glyph] of [['T', 'T'], ['CT', 'C']] as const) {
    src.spawns[team].forEach((s, i) => {
      checkCell(s.cell, `${team} spawn ${i}`, true);
      if (ctx.glyph(s.cell[0], s.cell[1]) !== glyph) fail(`${team} spawn ${i} at ${cellStr(s.cell[0], s.cell[1])} is on '${ctx.glyph(s.cell[0], s.cell[1])}', expected '${glyph}'`);
      for (let j = 0; j < i; j++) if (src.spawns[team][j].cell[0] === s.cell[0] && src.spawns[team][j].cell[1] === s.cell[1]) fail(`${team} spawns ${j} and ${i} share cell ${cellStr(s.cell[0], s.cell[1])}`);
    });
  }

  // platforms: in-grid, disjoint, compatible glyphs; '^' only inside a platform
  src.platforms.forEach((p, i) => {
    checkRect(p.rect, `platform ${i}`);
    if (!(p.y > 0 && p.y < src.wallHeight && p.y + BODY.standHeight < src.ceilingY)) fail(`platform ${i} y = ${p.y} must be > 0, below wallHeight and leave standing headroom below the ceiling`);
    for (let j = 0; j < i; j++) {
      const q = src.platforms[j].rect;
      if (p.rect[0] <= q[2] && q[0] <= p.rect[2] && p.rect[1] <= q[3] && q[1] <= p.rect[3]) fail(`platforms ${j} and ${i} overlap`);
    }
    for (let cz = p.rect[1]; cz <= p.rect[3]; cz++) for (let cx = p.rect[0]; cx <= p.rect[2]; cx++) {
      const g = ctx.glyph(cx, cz);
      if (!PLATFORM_OK.includes(g)) fail(`platform ${i} cell ${cellStr(cx, cz)} is '${g}'; cells inside a platform rect must be one of ${PLATFORM_OK.split('').join(' ')}`);
    }
  });
  for (let cz = 0; cz < src.height; cz++) for (let cx = 0; cx < src.width; cx++) {
    const g = ctx.glyph(cx, cz);
    if (g === '^' && ctx.platformAt(cx, cz) < 0) fail(`'^' at ${cellStr(cx, cz)} lies outside every platform rect`);
    if (g === '=' && ctx.rampAt(cx, cz) < 0) fail(`'=' at ${cellStr(cx, cz)} has no entry in ramps[]`);
  }

  // ramps: on '=', climbable, cell floor = from, `from` neighbour floor = from, `to` neighbour floor = to
  src.ramps.forEach((r, i) => {
    const [cx, cz] = r.cell, at = `ramp ${i} at ${cellStr(cx, cz)}`;
    checkCell(r.cell, `ramp ${i}`, false);
    if (ctx.glyph(cx, cz) !== '=') fail(`${at} is on '${ctx.glyph(cx, cz)}', expected '='`);
    for (let j = 0; j < i; j++) if (src.ramps[j].cell[0] === cx && src.ramps[j].cell[1] === cz) fail(`ramps ${j} and ${i} share cell ${cellStr(cx, cz)}`);
    if (!ASCEND_DELTA[r.ascend]) fail(`${at} has bad ascend '${String(r.ascend)}'`);
    if (!(Number.isInteger(r.steps) && r.steps >= 1)) fail(`${at} needs an integer step count ≥ 1`);
    if (!(r.to > r.from)) fail(`${at} must rise: to (${r.to}) > from (${r.from})`);
    const rise = (r.to - r.from) / r.steps;
    if (rise > BODY.stepHeight + EPS) fail(`${at} rises ${rise.toFixed(3)} m per step, more than the ${BODY.stepHeight} m step-up`);
    if (Math.abs(ctx.floorOfCell(cx, cz) - r.from) > EPS) fail(`${at}: cell floor ${ctx.floorOfCell(cx, cz)} ≠ from ${r.from}`);
    const [dx, dz] = ASCEND_DELTA[r.ascend];
    const lo: Cell = [cx - dx, cz - dz], hi: Cell = [cx + dx, cz + dz];
    for (const [c, want, end] of [[lo, r.from, 'from'], [hi, r.to, 'to']] as const) {
      if (!ctx.inGrid(c[0], c[1]) || !isOpen(ctx.glyph(c[0], c[1])) || ctx.glyph(c[0], c[1]) === '=') fail(`${at}: '${end}' neighbour ${cellStr(c[0], c[1])} must be a floor cell, is '${ctx.glyph(c[0], c[1])}'`);
      const f = ctx.floorOfCell(c[0], c[1]);
      if (Math.abs(f - want) > EPS) fail(`${at}: '${end}' neighbour ${cellStr(c[0], c[1])} has floor ${f}, expected ${end} = ${want}`);
    }
  });

  // named cells and rects
  src.areas.forEach((a, i) => checkRect(a.rect, `area ${i} '${a.id}'`));
  checkRect(src.sites.a, 'site a'); checkRect(src.sites.b, 'site b');
  for (const s of ['a', 'b'] as const) {
    const c = src.plantSpots[s];
    checkCell(c, `plant spot ${s}`, true);
    if (!inRect(src.sites[s], c[0], c[1])) fail(`plant spot ${s} ${cellStr(c[0], c[1])} lies outside site ${s}`);
  }
  for (const h of src.holdSpots) checkCell(h.cell, `hold spot '${h.id}'`, true);
  src.holdSpots.forEach((h, i) => { for (let j = 0; j < i; j++) if (src.holdSpots[j].id === h.id) fail(`duplicate hold spot id '${h.id}'`); });
  for (const c of src.chokes) checkCell(c.cell, `choke '${c.id}'`, true);
  if (variant === 'training') {
    if (!src.training) fail(`variant 'training' requested but the source has no training block`);
    const tr = src.training!;
    tr.sealed.forEach((r, i) => checkRect(r, `training seal ${i}`));
    tr.targets.forEach((c, i) => checkCell(c, `training target ${i}`, true));
    checkCell(tr.onboardingCell, 'training onboarding', true);
  }
}

// ───────────────────────────── 1. solids ─────────────────────────────

/** Geometry stage: solids in id order (walls, platform slabs, props + lintels row-major, ramp steps, ceiling, seals). */
export function buildSolids(src: MapSource, variant: 'match' | 'training' = 'match'): { solids: SolidDef[]; doors: DoorCell[] } {
  const ctx = mapContext(src), cell = ctx.cell;
  const solids: SolidDef[] = [];
  const push = (box: Aabb, kind: SolidKind, material: MaterialId | null, surface: SolidDef['surface'], penetrable = false, penetrationFactor = 0, tag?: string) => {
    solids.push({ box, kind, material, surface, penetrable, penetrationFactor, tag });
  };

  // 1a. Walls: greedy horizontal runs of '#' with the same local floor, then vertical merge of identical runs.
  const runs: { x0: number; x1: number; z0: number; z1: number; f: number }[] = [];
  let prevRow: number[] = [], curRow: number[] = [];
  for (let cz = 0; cz < src.height; cz++) {
    curRow = [];
    let cx = 0;
    while (cx < src.width) {
      if (ctx.glyph(cx, cz) !== '#') { cx++; continue; }
      const f = ctx.floorOfCell(cx, cz);
      let x1 = cx;
      while (x1 + 1 < src.width && ctx.glyph(x1 + 1, cz) === '#' && ctx.floorOfCell(x1 + 1, cz) === f) x1++;
      const prev = prevRow.find((ri) => runs[ri].x0 === cx && runs[ri].x1 === x1 && runs[ri].f === f);
      if (prev !== undefined) { runs[prev].z1 = cz; curRow.push(prev); } else { curRow.push(runs.length); runs.push({ x0: cx, x1, z0: cz, z1: cz, f }); }
      cx = x1 + 1;
    }
    prevRow = curRow;
  }
  for (const r of runs) push(aabb(r.x0 * cell, r.f, r.z0 * cell, (r.x1 + 1) * cell, src.wallHeight, (r.z1 + 1) * cell), 'wall', src.materials.wall, 'concrete', false, 0, 'wall');

  // 1b. Platform slabs (floor 0 is the StaticWorld ground plane; platform tops are slabs)
  for (const p of src.platforms) {
    const r = cellRectToWorld(p.rect, cell, p.y);
    push(aabb(r.x0, 0, r.z0, r.x1, p.y, r.z1), 'platform', p.material, p.surface, false, 0, 'platform');
  }

  // 1c. Props (one box per cell, on the local floor) and door lintels
  const doors: DoorCell[] = [];
  const blocked = (cx: number, cz: number) => !isOpen(ctx.glyph(cx, cz));
  for (let cz = 0; cz < src.height; cz++) for (let cx = 0; cx < src.width; cx++) {
    const g = ctx.glyph(cx, cz);
    const f = ctx.floorOfCell(cx, cz);
    const x0 = cx * cell, z0 = cz * cell;
    if (PROP_GLYPHS.includes(g)) {
      const k = g as 'X' | 'c' | '~' | 'L';
      const def = src.props[k];
      push(aabb(x0 + def.inset, f, z0 + def.inset, x0 + cell - def.inset, f + def.height, z0 + cell - def.inset), def.kind ?? DEFAULT_PROP_KIND[k], def.material, def.surface, def.penetrable, def.penetrationFactor, g);
    } else if (g === '+') {
      // passage axis: through a wall that runs along x (blocked west and east) one walks along z
      const axis: 'x' | 'z' = blocked(cx - 1, cz) && blocked(cx + 1, cz) ? 'z' : 'x';
      doors.push({ cx, cz, axis });
      push(aabb(x0, f + src.lintelY, z0, x0 + cell, Math.max(src.wallHeight, f + src.lintelY + 0.1), z0 + cell), 'lintel', src.materials.door, 'concrete', false, 0, 'lintel');
    }
  }

  // 1d. Ramps: `steps` stair boxes of cell/steps depth, tops rising evenly from `from` to `to` toward the ascend side
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
      // invisible: the renderer draws renderHints.ramps (a wedge over the stairs); raycasts/LOS still see the boxes
      push(box, 'ramp-step', null, 'metal', false, 0, 'ramp');
    }
  }

  // 1e. Ceiling slab
  push(aabb(0, src.ceilingY, 0, src.width * cell, src.ceilingY + 0.5, src.height * cell), 'ceiling', src.materials.ceiling, 'concrete', false, 0, 'ceiling');

  // 1f. Training seals: one invisible box (f … wallHeight) per sealed rect
  if (variant === 'training' && src.training) {
    for (const r of src.training.sealed) {
      const w = cellRectToWorld(r, cell, ctx.floorOfCell(r[0], r[1]));
      push(aabb(w.x0, w.y, w.z0, w.x1, src.wallHeight, w.z1), 'seal', null, 'concrete', false, 0, 'seal');
    }
  }
  return { solids, doors };
}

/** Bounds and overlap problems (empty = OK). Touching faces are not overlaps; pairs involving a seal are exempt. */
export function solidProblems(solids: readonly SolidDef[], bounds: Aabb): string[] {
  const out: string[] = [];
  const name = (i: number) => `solid ${i} (${solids[i].kind})`;
  for (let i = 0; i < solids.length; i++) {
    const b = solids[i].box;
    if (!(b.min.x < b.max.x && b.min.y < b.max.y && b.min.z < b.max.z)) out.push(`${name(i)} has an empty box`);
    if (b.min.x < bounds.min.x - EPS || b.min.y < bounds.min.y - EPS || b.min.z < bounds.min.z - EPS || b.max.x > bounds.max.x + EPS || b.max.y > bounds.max.y + EPS || b.max.z > bounds.max.z + EPS) out.push(`${name(i)} leaves the map bounds`);
  }
  for (let i = 0; i < solids.length; i++) {
    if (solids[i].kind === 'seal') continue;
    const a = solids[i].box;
    for (let j = i + 1; j < solids.length; j++) {
      if (solids[j].kind === 'seal') continue;
      const b = solids[j].box;
      if (a.min.x < b.max.x - EPS && a.max.x > b.min.x + EPS && a.min.y < b.max.y - EPS && a.max.y > b.min.y + EPS && a.min.z < b.max.z - EPS && a.max.z > b.min.z + EPS) out.push(`${name(i)} and ${name(j)} overlap`);
    }
  }
  return out;
}

// ───────────────────────────── 2. walk grid ─────────────────────────────

/** Wedge height of a ramp at (x, z): linear from `from` at the low edge to `to` at the high edge. */
function wedgeHeight(r: MapSource['ramps'][number], cell: number, x: number, z: number): number {
  const x0 = r.cell[0] * cell, z0 = r.cell[1] * cell;
  const t = r.ascend === 'e' ? (x - x0) / cell : r.ascend === 'w' ? (x0 + cell - x) / cell : r.ascend === 's' ? (z - z0) / cell : (z0 + cell - z) / cell;
  return r.from + Math.min(1, Math.max(0, t)) * (r.to - r.from);
}

/** 1 m walk grid sampled against `world` (which must contain `solids` of this source). */
export function buildWalkGrid(src: MapSource, world: StaticWorld): WalkGrid {
  const ctx = mapContext(src), cell = ctx.cell;
  const cols = src.width * cell, rows = src.height * cell;
  const walkable = new Uint8Array(cols * rows), ramp = new Uint8Array(cols * rows), rampAxis = new Uint8Array(cols * rows), fy = new Float32Array(cols * rows);
  const hw = BODY.halfWidth, h = BODY.standHeight;
  const tmp: Solid[] = [];
  const box: Aabb = { min: v3(), max: v3() };
  for (let sz = 0; sz < rows; sz++) for (let sx = 0; sx < cols; sx++) {
    const i = sz * cols + sx;
    const x = sx + 0.5, z = sz + 0.5;
    const cx = Math.floor(x / cell), cz = Math.floor(z / cell);
    const ri = ctx.rampAt(cx, cz);
    let floor = ctx.floorOfCell(cx, cz);
    if (ri >= 0) {
      const r = src.ramps[ri];
      floor = wedgeHeight(r, cell, x, z);
      ramp[i] = 1; rampAxis[i] = r.ascend === 'e' || r.ascend === 'w' ? 1 : 2;
    }
    fy[i] = floor;
    box.min.x = x - hw; box.min.y = floor + 1e-3; box.min.z = z - hw; box.max.x = x + hw; box.max.y = floor + h; box.max.z = z + hw;
    world.query(box, tmp);
    let free = true;
    for (const s of tmp) if (s.kind !== 'ramp-step') { free = false; break; }
    walkable[i] = free ? 1 : 0;
  }
  return {
    cell: 1, cols, rows, walkable, ramp, rampAxis, floorY: fy, originX: 0, originZ: 0,
    index(x: number, z: number): number {
      const sx = Math.min(cols - 1, Math.max(0, Math.floor(x))), sz = Math.min(rows - 1, Math.max(0, Math.floor(z)));
      return sz * cols + sx;
    },
  };
}

/** Can a body step between orthogonal walk-grid neighbours i → j (axis 1 = x, 2 = z)? Same rule as the nav edges. */
export function walkStepAllowed(w: WalkGrid, i: number, j: number, axis: 1 | 2): boolean {
  if (!w.walkable[i] || !w.walkable[j]) return false;
  if ((w.ramp[i] && w.rampAxis[i] === axis) || (w.ramp[j] && w.rampAxis[j] === axis)) return true;
  return Math.abs(w.floorY[i] - w.floorY[j]) <= WALK_MAX_STEP + EPS;
}

/** BFS over the walk grid from sub-cell `start`; returns a 0/1 reach mask (empty mask if start is not walkable). */
export function walkReach(w: WalkGrid, start: number): Uint8Array {
  const seen = new Uint8Array(w.cols * w.rows);
  if (!w.walkable[start]) return seen;
  const q = new Int32Array(w.cols * w.rows);
  let head = 0, tail = 0;
  q[tail++] = start; seen[start] = 1;
  while (head < tail) {
    const i = q[head++];
    const x = i % w.cols, z = (i - x) / w.cols;
    if (x + 1 < w.cols && !seen[i + 1] && walkStepAllowed(w, i, i + 1, 1)) { seen[i + 1] = 1; q[tail++] = i + 1; }
    if (x > 0 && !seen[i - 1] && walkStepAllowed(w, i, i - 1, 1)) { seen[i - 1] = 1; q[tail++] = i - 1; }
    if (z + 1 < w.rows && !seen[i + w.cols] && walkStepAllowed(w, i, i + w.cols, 2)) { seen[i + w.cols] = 1; q[tail++] = i + w.cols; }
    if (z > 0 && !seen[i - w.cols] && walkStepAllowed(w, i, i - w.cols, 2)) { seen[i - w.cols] = 1; q[tail++] = i - w.cols; }
  }
  return seen;
}

/** BFS reachability over the walk grid between two world points (tests, nav-dump). */
export function walkReachable(map: CompiledMap, from: Vec3, to: Vec3): boolean {
  const w = map.walk;
  const goal = w.index(to.x, to.z);
  if (!w.walkable[goal]) return false;
  return walkReach(w, w.index(from.x, from.z))[goal] === 1;
}

/** Number of walkable sub-cells. */
export function walkableCount(w: WalkGrid): number { let n = 0; for (let i = 0; i < w.walkable.length; i++) n += w.walkable[i]; return n; }

// ───────────────────────────── 3. render hints ─────────────────────────────

function radarOutline(src: MapSource, ctx: MapContext, solids: readonly SolidDef[]): RenderHints['radarWalls'] {
  const cell = ctx.cell;
  // Full-cell blockers drawn as one merged outline; inset props (none on Depot) emit their own box edges.
  const full = (cx: number, cz: number): boolean => {
    if (!ctx.inGrid(cx, cz)) return false;
    const g = ctx.glyph(cx, cz);
    return g === '#' || ((g === 'X' || g === 'L') && src.props[g].inset === 0);
  };
  // edges keyed by line: horizontal edges at z = k·cell (h[k] holds cell-x indices), vertical at x = k·cell
  const hEdges: number[][] = Array.from({ length: src.height + 1 }, () => []);
  const vEdges: number[][] = Array.from({ length: src.width + 1 }, () => []);
  for (let cz = 0; cz < src.height; cz++) for (let cx = 0; cx < src.width; cx++) {
    if (!full(cx, cz)) continue;
    // only faces that border open space inside the grid (the outer faces of border walls are never visible)
    if (ctx.inGrid(cx, cz - 1) && !full(cx, cz - 1)) hEdges[cz].push(cx);
    if (ctx.inGrid(cx, cz + 1) && !full(cx, cz + 1)) hEdges[cz + 1].push(cx);
    if (ctx.inGrid(cx - 1, cz) && !full(cx - 1, cz)) vEdges[cx].push(cz);
    if (ctx.inGrid(cx + 1, cz) && !full(cx + 1, cz)) vEdges[cx + 1].push(cz);
  }
  const out: RenderHints['radarWalls'] = [];
  const merge = (list: number[], emit: (a: number, b: number) => void) => {
    const s = list.slice().sort((a, b) => a - b); // no duplicates: each face is pushed by exactly one blocked cell
    let i = 0;
    while (i < s.length) { let j = i; while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++; emit(s[i], s[j] + 1); i = j + 1; }
  };
  hEdges.forEach((list, k) => merge(list, (a, b) => out.push({ x0: a * cell, z0: k * cell, x1: b * cell, z1: k * cell })));
  vEdges.forEach((list, k) => merge(list, (a, b) => out.push({ x0: k * cell, z0: a * cell, x1: k * cell, z1: b * cell })));
  for (const s of solids) {
    if (s.kind !== 'tallcrate' && s.kind !== 'lip') continue;
    const g = s.tag as 'X' | 'L' | undefined;
    if (g && (g === 'X' || g === 'L') && src.props[g].inset === 0) continue;
    const b = s.box;
    out.push({ x0: b.min.x, z0: b.min.z, x1: b.max.x, z1: b.min.z }, { x0: b.max.x, z0: b.min.z, x1: b.max.x, z1: b.max.z }, { x0: b.max.x, z0: b.max.z, x1: b.min.x, z1: b.max.z }, { x0: b.min.x, z0: b.max.z, x1: b.min.x, z1: b.min.z });
  }
  return out;
}

/** Greedy rectangles over the cells accepted by `ok` (row-major, deterministic, no overlaps). */
function greedyRects(w: number, h: number, ok: (cx: number, cz: number) => boolean): CellRect[] {
  const used = new Uint8Array(w * h);
  const out: CellRect[] = [];
  for (let cz = 0; cz < h; cz++) for (let cx = 0; cx < w; cx++) {
    if (used[cz * w + cx] || !ok(cx, cz)) continue;
    let x1 = cx;
    while (x1 + 1 < w && !used[cz * w + x1 + 1] && ok(x1 + 1, cz)) x1++;
    let z1 = cz;
    for (;;) {
      const nz = z1 + 1;
      if (nz >= h) break;
      let row = true;
      for (let x = cx; x <= x1; x++) if (used[nz * w + x] || !ok(x, nz)) { row = false; break; }
      if (!row) break;
      z1 = nz;
    }
    for (let z = cz; z <= z1; z++) for (let x = cx; x <= x1; x++) used[z * w + x] = 1;
    out.push([cx, cz, x1, z1]);
  }
  return out;
}

function buildRenderHints(src: MapSource, ctx: MapContext, solids: readonly SolidDef[], doors: readonly DoorCell[], sites: CompiledMap['sites'], bounds: Aabb): RenderHints {
  const cell = ctx.cell;
  const floorQuads: RenderHints['floorQuads'] = greedyRects(src.width, src.height, (cx, cz) => ctx.glyph(cx, cz) !== '#' && ctx.platformAt(cx, cz) < 0)
    .map((r) => ({ rect: cellRectToWorld(r, cell, 0), material: src.materials.floor }));
  for (const p of src.platforms) floorQuads.push({ rect: cellRectToWorld(p.rect, cell, p.y), material: p.material });

  // lamps: one per 4 × 4 m block (2 × 2 cells) that has floor, at the centroid of its non-wall cells
  const lamps: Vec3[] = [];
  for (let bz = 0; bz < src.height; bz += 2) for (let bx = 0; bx < src.width; bx += 2) {
    let n = 0, sx = 0, sz = 0;
    for (let cz = bz; cz < Math.min(bz + 2, src.height); cz++) for (let cx = bx; cx < Math.min(bx + 2, src.width); cx++) {
      if (ctx.glyph(cx, cz) === '#') continue;
      n++; sx += (cx + 0.5) * cell; sz += (cz + 0.5) * cell;
    }
    if (n > 0) lamps.push(v3(sx / n, src.ceilingY - 0.1, sz / n));
  }

  // wall signs: the first wall cell adjacent to the site rect (east, west, then north, south), on the face toward the site
  const wallSigns: RenderHints['wallSigns'] = [];
  for (const site of ['a', 'b'] as const) {
    const r = src.sites[site];
    const cands: { cx: number; cz: number; side: 'e' | 'w' | 'n' | 's' }[] = [];
    for (let cz = r[1]; cz <= r[3]; cz++) { cands.push({ cx: r[2] + 1, cz, side: 'e' }); cands.push({ cx: r[0] - 1, cz, side: 'w' }); }
    for (let cx = r[0]; cx <= r[2]; cx++) { cands.push({ cx, cz: r[1] - 1, side: 'n' }); cands.push({ cx, cz: r[3] + 1, side: 's' }); }
    const w = cands.find((c) => ctx.glyph(c.cx, c.cz) === '#');
    if (!w) continue;
    const f = ctx.floorOfCell(r[0], r[1]);
    // the sign faces into the site: east wall → faces west (+90°), west wall → east (−90°), north wall → south (180°), south wall → north (0°)
    const yaw = w.side === 'e' ? 90 * DEG : w.side === 'w' ? -90 * DEG : w.side === 'n' ? 180 * DEG : 0;
    const px = w.side === 'e' ? w.cx * cell : w.side === 'w' ? (w.cx + 1) * cell : (w.cx + 0.5) * cell;
    const pz = w.side === 'n' ? (w.cz + 1) * cell : w.side === 's' ? w.cz * cell : (w.cz + 0.5) * cell;
    wallSigns.push({ site, pos: v3(px, Math.min(f + 2.2, src.wallHeight - 0.5), pz), yaw }); // 2.2 m above the site floor, but on the wall
  }

  return {
    solids: solids.map((s) => ({ material: s.material, kind: s.kind, uvScale: 0.5 as const })),
    floorQuads,
    ramps: src.ramps.map((r) => {
      const [cx, cz] = r.cell; const x0 = cx * cell, z0 = cz * cell;
      const origin = r.ascend === 'e' ? v3(x0, r.from, z0 + cell / 2) : r.ascend === 'w' ? v3(x0 + cell, r.from, z0 + cell / 2) : r.ascend === 's' ? v3(x0 + cell / 2, r.from, z0) : v3(x0 + cell / 2, r.from, z0 + cell);
      return { origin, ascend: r.ascend, from: r.from, to: r.to, width: 2 as const, length: 2 as const, material: 'metal' as MaterialId };
    }),
    doorFrames: doors.map((d) => ({ pos: v3((d.cx + 0.5) * cell, ctx.floorOfCell(d.cx, d.cz), (d.cz + 0.5) * cell), axis: d.axis, width: 2 as const, height: 2.6 as const, material: src.materials.door })),
    lamps,
    siteDecals: [{ site: 'a', rect: sites.a }, { site: 'b', rect: sites.b }],
    wallSigns,
    radarWalls: radarOutline(src, ctx, solids),
    bounds, ceilingY: src.ceilingY,
  };
}

// ───────────────────────────── compileMap ─────────────────────────────

/** Builds a collision world from solid definitions (solid ids == indices). */
export function worldFromSolids(solids: readonly SolidDef[], bounds: Aabb): StaticWorld {
  return new StaticWorld(solids.map((s) => ({ box: s.box, surface: s.surface, penetrable: s.penetrable, penetrationFactor: s.penetrationFactor, kind: s.kind, tag: s.tag })), { groundY: 0, bounds });
}

export function compileMap(src: MapSource, variant: 'match' | 'training' = 'match'): CompiledMap {
  validateSource(src, variant);
  const fail = (m: string): never => { throw new MapCompileError(`map '${src.id}'${variant === 'training' ? ' (training)' : ''}: ${m}`); };
  const ctx = mapContext(src), cell = ctx.cell;
  const bounds = aabb(0, 0, 0, src.width * cell, src.ceilingY + 0.5, src.height * cell);

  // 1. solids
  const { solids, doors } = buildSolids(src, variant);
  const problems = solidProblems(solids, bounds);
  if (problems.length) fail(`${problems.length} solid problem(s): ${problems.slice(0, 5).join('; ')}`);

  // 2. floor function
  const floorY = (x: number, z: number): number => ctx.floorOfCell(Math.floor(x / cell), Math.floor(z / cell));

  // 3. walk grid
  const world = worldFromSolids(solids, bounds);
  const walk = buildWalkGrid(src, world);
  const subOf = (p: Vec3) => walk.index(p.x, p.z);

  // 4. world-space data
  const areas: WorldArea[] = src.areas.map((a) => ({ id: a.id, rect: cellRectToWorld(a.rect, cell, ctx.floorOfCell(a.rect[0], a.rect[1])) }));
  const areasBySize = src.areas.map((a, i) => ({ a, i, size: (a.rect[2] - a.rect[0] + 1) * (a.rect[3] - a.rect[1] + 1) })).sort((p, q) => p.size - q.size || p.i - q.i);
  const areaAt = (x: number, z: number): AreaId | null => {
    const cx = Math.floor(x / cell), cz = Math.floor(z / cell);
    for (const e of areasBySize) if (inRect(e.a.rect, cx, cz)) return e.a.id;
    return null;
  };
  const at = (c: Cell) => cellCenter(c, cell, ctx.floorOfCell(c[0], c[1]));
  const sites = { a: cellRectToWorld(src.sites.a, cell, ctx.floorOfCell(src.sites.a[0], src.sites.a[1])), b: cellRectToWorld(src.sites.b, cell, ctx.floorOfCell(src.sites.b[0], src.sites.b[1])) };
  const plantSpots = { a: at(src.plantSpots.a), b: at(src.plantSpots.b) };
  const spawns = {
    T: src.spawns.T.map((s) => ({ pos: at(s.cell), yaw: s.yawDeg * DEG })),
    CT: src.spawns.CT.map((s) => ({ pos: at(s.cell), yaw: s.yawDeg * DEG })),
  };
  const holdSpots = src.holdSpots.map((hs) => ({ id: hs.id, pos: at(hs.cell), yaw: hs.yawDeg * DEG, team: hs.team, crouch: hs.crouch }));
  const chokes = src.chokes.map((c) => ({ id: c.id, pos: at(c.cell) }));
  let training: CompiledMap['training'] | undefined;
  if (variant === 'training' && src.training) {
    training = {
      sealed: src.training.sealed.map((r) => { const w = cellRectToWorld(r, cell, ctx.floorOfCell(r[0], r[1])); return aabb(w.x0, w.y, w.z0, w.x1, src.wallHeight, w.z1); }),
      targets: src.training.targets.map(at),
      onboardingPos: at(src.training.onboardingCell),
    };
  }

  // 5. walk-grid assertions: every spawn sub-cell walkable; reachability
  for (const team of ['T', 'CT'] as const) {
    src.spawns[team].forEach((s, i) => {
      for (let dz = 0; dz < cell; dz++) for (let dx = 0; dx < cell; dx++) {
        const sx = s.cell[0] * cell + dx, sz = s.cell[1] * cell + dz;
        if (!walk.walkable[sz * walk.cols + sx]) fail(`${team} spawn ${i} at cell ${cellStr(s.cell[0], s.cell[1])}: sub-cell (${sx}, ${sz}) is not walkable`);
      }
    });
  }
  const label = (team: 'T' | 'CT', i: number) => `${team} spawn ${i} ${cellStr(src.spawns[team][i].cell[0], src.spawns[team][i].cell[1])}`;
  if (variant === 'match') {
    for (const team of ['T', 'CT'] as const) {
      const enemy = team === 'T' ? 'CT' : 'T';
      spawns[team].forEach((s, i) => {
        const reach = walkReach(walk, subOf(s.pos));
        for (const site of ['a', 'b'] as const) if (!reach[subOf(plantSpots[site])]) fail(`${label(team, i)} cannot reach plant spot ${site} ${cellStr(src.plantSpots[site][0], src.plantSpots[site][1])} over the walk grid`);
        spawns[enemy].forEach((e, j) => { if (!reach[subOf(e.pos)]) fail(`${label(team, i)} cannot reach ${label(enemy, j)} over the walk grid`); });
      });
    }
  } else if (training && src.training) {
    spawns.T.forEach((s, i) => {
      const reach = walkReach(walk, subOf(s.pos));
      training!.targets.forEach((t, j) => { if (!reach[subOf(t)]) fail(`${label('T', i)} cannot reach training target ${j} ${cellStr(src.training!.targets[j][0], src.training!.targets[j][1])}`); });
      if (!reach[subOf(training!.onboardingPos)]) fail(`${label('T', i)} cannot reach the onboarding cell`);
      if (src.training!.sealed.length > 0) {
        for (const site of ['a', 'b'] as const) if (reach[subOf(plantSpots[site])]) fail(`training seals leak: ${label('T', i)} reaches plant spot ${site}`);
        spawns.CT.forEach((e, j) => { if (reach[subOf(e.pos)]) fail(`training seals leak: ${label('T', i)} reaches ${label('CT', j)}`); });
      }
    });
  }

  // 6. render hints
  const renderHints = buildRenderHints(src, ctx, solids, doors, sites, bounds);

  return { id: src.id, cellSize: cell, width: src.width, height: src.height, bounds, solids, floorY, walk, areas, areaAt, sites, plantSpots, spawns, holdSpots, chokes, renderHints, training };
}

/** Builds the collision world for a compiled map (solid ids == map.solids indices). */
export function buildStaticWorld(map: CompiledMap): StaticWorld { return worldFromSolids(map.solids, map.bounds); }
