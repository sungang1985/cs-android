/**
 * Navigation graph derived from CompiledMap.walk (1 m sub-grid), DESIGN.md §6.4:
 *  - nodes = walkable sub-cells (row-major ids), position = sub-cell centre at its floor (ramp: wedge height);
 *  - 8-connected edges (no corner cutting, |Δfloor| ≤ 0.6 m); ramp rule: orthogonal edges along a ramp's ascend
 *    axis are always created, diagonals into/out of ramp sub-cells never; cost = 3D length × 1.4 near walls;
 *  - tags: area, site, spawnT/CT, chokepoint (distance-transform corridor width ≤ 2 m + the map's listed chokes),
 *    coverScore/coverHeight, nearWall;
 *  - A* (binary heap, octile heuristic, preallocated buffers) over node ids with an LRU cache of 512 (from, to)
 *    pairs, string pulling, cover queries, authored hold spots snapped to nodes.
 * Pure TypeScript, deterministic: ids ascend row-major, edges are sorted arrays, ties break by id; the cache only
 * memoises a deterministic search, so results never depend on its state or on Map iteration order.
 */
import { type Aabb, type Vec3, v3 } from '../core/math';
import type { Rng } from '../core/rng';
import type { StaticWorld, Solid } from '../world/collision';
import type { CompiledMap, AreaId, WalkGrid } from '../world/types';
import { rectContains } from '../world/types';
import { WALK_MAX_STEP } from '../world/compile';
import { BODY } from '../sim/state';

export interface NavNode {
  id: number; pos: Vec3; area: AreaId | null;
  /** corridor width ≤ 2 m (distance transform) or inside one of the map's listed choke cells */
  chokepoint: boolean;
  /** how many of 8 directions hit a solid ≥ 1.0 m tall (relative to this floor) within 1.2 m */
  coverScore: number;
  /** tallest such solid as a class: 0 none, 1.0 low (1.0–1.2 m), 1.2 half (1.2–1.8 m), 2 full (≥ 1.8 m: hides a standing body) */
  coverHeight: number;
  /** within 0.5 m (XZ) of a solid ≥ 1 m tall: edges touching this node cost ×1.4 */
  nearWall: boolean;
  ramp: boolean;
  /** neighbour ids, ascending */
  edges: number[];
  /** sub-grid coordinates */
  cx: number; cz: number;
  /** extra §6.4 tags: plant zone, inside the t_spawn / ct_spawn area */
  site: 'a' | 'b' | null; spawnT: boolean; spawnCT: boolean;
  /** distance-transform value: chessboard distance (m) to the nearest unwalkable sub-cell (1 = touching a wall) */
  clearance: number;
}

export interface NavGraph {
  nodes: NavNode[];
  /** nearest node to a world point (XZ distance + 2 × |Δy|; ties → lower id); −1 only for an empty graph */
  nearest(p: Vec3): number;
  /**
   * Node ids from nearest(from) to nearest(to), or null if unreachable. `blocked` (a node id, e.g. the next node of
   * a path the bot is stuck on) is excluded from the search; it is ignored if it is the start or the goal node.
   * Unblocked results are cached (LRU, 512 pairs) until clearCache().
   */
  findPath(from: Vec3, to: Vec3, blocked?: number): number[] | null;
  /** String-pulled corners for a node path (start node excluded, last node included): 3–8 corners typical. */
  pullString(ids: number[], out?: Vec3[]): Vec3[];
  /**
   * Nearest node (XZ) within `radius` of `p` with coverScore > 0 whose segment to the threat is blocked: from the
   * node at floor + 0.9 m (crouched chest) to `threat` + 1.5 m. `p` and `threat` are FEET positions (PlayerState.pos).
   */
  coverNear(p: Vec3, threat: Vec3, radius: number): NavNode | null;
  holdSpot(id: string): { node: number; yaw: number; crouch: boolean };
  randomNodeInArea(area: AreaId, rng: Rng): NavNode;
  clearCache(): void;
  /** Search cost of the edge a → b (3D length, × 1.4 if either end is nearWall); Infinity if there is no edge. */
  edgeCost(a: number, b: number): number;
  /** Debug: ASCII dump of the sub-grid ('#' blocked, '.' floor, '^' raised, '=' ramp, '!' chokepoint). */
  ascii(): string;
}

/** Body shape used when sampling walkability (shared with world/compile.ts). */
export const NAV_BODY = { halfWidth: BODY.halfWidth, height: BODY.standHeight, stepHeight: BODY.stepHeight };

export const NAV = {
  cacheLimit: 512, nearWallDist: 0.5, nearWallCost: 1.4, wallMinHeight: 1.0,
  coverProbe: 1.2, coverProbeHeight: 0.5, kneeHeight: 0.5, bodyExpand: 0.35, chokeClearance: 1,
  coverEye: 0.9, threatEye: 1.5,
} as const;

const SQRT2M1 = Math.SQRT2 - 1;
const DIRS8: readonly [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
/** cover probe directions (unit XZ vectors, 45° apart) */
const PROBES: readonly Vec3[] = [0, 1, 2, 3, 4, 5, 6, 7].map((k) => v3(Math.cos((k * Math.PI) / 4), 0, Math.sin((k * Math.PI) / 4)));

/** Total length of a polyline, optionally starting at `start`. */
export function polylineLength(points: readonly Vec3[], start?: Vec3): number {
  let len = 0;
  let prev = start ?? points[0];
  for (const p of points) { if (prev) len += Math.hypot(p.x - prev.x, p.y - prev.y, p.z - prev.z); prev = p; }
  return len;
}

class NavGraphImpl implements NavGraph {
  readonly nodes: NavNode[] = [];
  private readonly walk: WalkGrid;
  private readonly cellNode: Int32Array; // sub-cell index → node id or −1
  private readonly cols: number; private readonly rows: number; private readonly ox: number; private readonly oz: number;
  // CSR adjacency for the search
  private edgeStart = new Int32Array(1); private edgeTo = new Int32Array(0); private edgeW = new Float64Array(0);
  // A* scratch (allocated once)
  private readonly g: Float64Array; private readonly came: Int32Array; private readonly seen: Uint32Array; private readonly closed: Uint32Array;
  private stamp = 0;
  private heapId: Int32Array; private heapF: Float64Array; private heapN = 0;
  private readonly cache = new Map<number, Int32Array | null>();
  private readonly holds: Record<string, { node: number; yaw: number; crouch: boolean }> = {};
  private readonly byArea: Record<string, number[]> = {};

  constructor(private readonly map: CompiledMap, private readonly world: StaticWorld) {
    const w = (this.walk = map.walk);
    this.cols = w.cols; this.rows = w.rows; this.ox = w.originX; this.oz = w.originZ;
    this.cellNode = new Int32Array(w.cols * w.rows).fill(-1);
    for (let cz = 0; cz < w.rows; cz++) for (let cx = 0; cx < w.cols; cx++) {
      const i = cz * w.cols + cx;
      if (!w.walkable[i]) continue;
      const x = this.ox + cx + 0.5, z = this.oz + cz + 0.5;
      const id = this.nodes.length;
      this.cellNode[i] = id;
      const site = rectContains(map.sites.a, x, z) ? 'a' : rectContains(map.sites.b, x, z) ? 'b' : null;
      const inArea = (a: AreaId) => map.areas.some((r) => r.id === a && rectContains(r.rect, x, z));
      this.nodes.push({ id, pos: v3(x, w.floorY[i], z), area: map.areaAt(x, z), chokepoint: false, coverScore: 0, coverHeight: 0, nearWall: false, ramp: w.ramp[i] === 1, edges: [], cx, cz, site, spawnT: inArea('t_spawn'), spawnCT: inArea('ct_spawn'), clearance: 0 });
    }
    const N = this.nodes.length;
    this.g = new Float64Array(N); this.came = new Int32Array(N); this.seen = new Uint32Array(N); this.closed = new Uint32Array(N);
    this.heapId = new Int32Array(Math.max(16, N * 2)); this.heapF = new Float64Array(this.heapId.length);
    this.tagWalls();
    this.link();
    this.tagChokepoints();
    for (const n of this.nodes) { if (!n.area) continue; const list = this.byArea[n.area] ?? (this.byArea[n.area] = []); list.push(n.id); }
    for (const h of map.holdSpots) this.holds[h.id] = { node: this.snapHold(h.pos), yaw: h.yaw, crouch: h.crouch };
  }

  private nodeAt(cx: number, cz: number): number {
    if (cx < 0 || cz < 0 || cx >= this.cols || cz >= this.rows) return -1;
    return this.cellNode[cz * this.cols + cx];
  }

  // ───────── construction ─────────

  /** nearWall, coverScore, coverHeight. */
  private tagWalls(): void {
    const tmp: Solid[] = [];
    const q: Aabb = { min: v3(), max: v3() };
    const o = v3();
    for (const n of this.nodes) {
      const f = n.pos.y;
      // nearWall: Euclidean XZ distance ≤ 0.5 m to a solid rising ≥ 1 m above this floor that overlaps the body's height
      const r = NAV.nearWallDist + 0.01; // the query box must reach past faces exactly 0.5 m away (overlap is strict)
      q.min.x = n.pos.x - r; q.min.y = f + 0.01; q.min.z = n.pos.z - r;
      q.max.x = n.pos.x + r; q.max.y = f + BODY.standHeight; q.max.z = n.pos.z + r;
      this.world.query(q, tmp);
      for (const s of tmp) {
        if (s.kind === 'ramp-step' || s.kind === 'ceiling' || s.box.max.y - f < NAV.wallMinHeight) continue;
        const dx = Math.max(s.box.min.x - n.pos.x, 0, n.pos.x - s.box.max.x), dz = Math.max(s.box.min.z - n.pos.z, 0, n.pos.z - s.box.max.z);
        if (Math.hypot(dx, dz) <= NAV.nearWallDist + 1e-6) { n.nearWall = true; break; }
      }
      // cover: 8 horizontal probes at knee height
      o.x = n.pos.x; o.y = f + NAV.coverProbeHeight; o.z = n.pos.z;
      let score = 0, height = 0;
      for (const d of PROBES) {
        const hit = this.world.raycast(o, d, NAV.coverProbe, (s) => s.kind !== 'ramp-step' && s.box.max.y - f >= NAV.wallMinHeight);
        if (hit && hit.solid) { score++; height = Math.max(height, hit.solid.box.max.y - f); }
      }
      n.coverScore = score;
      n.coverHeight = height >= BODY.standHeight ? 2 : height >= 1.2 - 1e-6 ? 1.2 : height >= 1.0 - 1e-6 ? 1.0 : 0;
    }
  }

  private link(): void {
    const w = this.walk;
    const idx = (n: NavNode) => n.cz * this.cols + n.cx;
    const flatOk = (a: number, b: number) => Math.abs(w.floorY[a] - w.floorY[b]) <= WALK_MAX_STEP + 1e-6;
    const to: number[] = [], cost: number[] = [];
    this.edgeStart = new Int32Array(this.nodes.length + 1);
    for (const n of this.nodes) {
      const i = idx(n);
      for (const [dx, dz] of DIRS8) {
        const m = this.nodeAt(n.cx + dx, n.cz + dz);
        if (m < 0) continue;
        const o = this.nodes[m], j = idx(o);
        if (dx === 0 || dz === 0) {
          // orthogonal: shared rule with the compiler's BFS (ramp-axis steps exempt from the Δfloor test)
          const axis = dx !== 0 ? 1 : 2;
          if ((w.ramp[i] && w.rampAxis[i] === axis) || (w.ramp[j] && w.rampAxis[j] === axis) || flatOk(i, j)) n.edges.push(m);
          continue;
        }
        // diagonal: never into/out of a ramp; both orthogonal neighbours walkable; every leg within the step limit
        if (n.ramp || o.ramp) continue;
        const a = this.nodeAt(n.cx + dx, n.cz), b = this.nodeAt(n.cx, n.cz + dz);
        if (a < 0 || b < 0 || this.nodes[a].ramp || this.nodes[b].ramp) continue;
        const ia = idx(this.nodes[a]), ib = idx(this.nodes[b]);
        if (flatOk(i, j) && flatOk(i, ia) && flatOk(i, ib) && flatOk(ia, j) && flatOk(ib, j)) n.edges.push(m);
      }
      n.edges.sort((p, q) => p - q);
      this.edgeStart[n.id] = to.length;
      for (const m of n.edges) {
        const o = this.nodes[m];
        const len = Math.hypot(o.pos.x - n.pos.x, o.pos.y - n.pos.y, o.pos.z - n.pos.z);
        to.push(m); cost.push(len * (n.nearWall || o.nearWall ? NAV.nearWallCost : 1));
      }
    }
    this.edgeStart[this.nodes.length] = to.length;
    this.edgeTo = Int32Array.from(to); this.edgeW = Float64Array.from(cost);
  }

  /** Distance transform (chessboard, two-pass chamfer) → clearance; ridge cells with clearance ≤ 1 m are chokepoints. */
  private tagChokepoints(): void {
    const { cols, rows } = this;
    const w = this.walk;
    const INF = 1 << 20;
    const d = new Int32Array(cols * rows);
    for (let i = 0; i < d.length; i++) d[i] = w.walkable[i] ? INF : 0;
    const at = (x: number, z: number) => (x < 0 || z < 0 || x >= cols || z >= rows ? 0 : d[z * cols + x]); // outside = blocked
    for (let z = 0; z < rows; z++) for (let x = 0; x < cols; x++) {
      const i = z * cols + x;
      if (d[i] === 0) continue;
      d[i] = Math.min(d[i], at(x - 1, z) + 1, at(x - 1, z - 1) + 1, at(x, z - 1) + 1, at(x + 1, z - 1) + 1);
    }
    for (let z = rows - 1; z >= 0; z--) for (let x = cols - 1; x >= 0; x--) {
      const i = z * cols + x;
      if (d[i] === 0) continue;
      d[i] = Math.min(d[i], at(x + 1, z) + 1, at(x + 1, z + 1) + 1, at(x, z + 1) + 1, at(x - 1, z + 1) + 1);
    }
    for (const n of this.nodes) {
      const c = d[n.cz * cols + n.cx];
      n.clearance = c;
      if (c > NAV.chokeClearance) continue;
      // a ridge of the transform: no neighbour is farther from the walls (so this is a corridor, not a room's edge)
      let ridge = true;
      for (const [dx, dz] of DIRS8) if (at(n.cx + dx, n.cz + dz) > NAV.chokeClearance) { ridge = false; break; }
      if (ridge) n.chokepoint = true;
    }
    // the map's listed chokes: every node of the choke's 2 m cell
    const cell = this.map.cellSize;
    for (const c of this.map.chokes) {
      const x0 = Math.floor((c.pos.x - this.ox) / cell) * cell, z0 = Math.floor((c.pos.z - this.oz) / cell) * cell;
      for (let dz = 0; dz < cell; dz++) for (let dx = 0; dx < cell; dx++) { const id = this.nodeAt(x0 + dx, z0 + dz); if (id >= 0) this.nodes[id].chokepoint = true; }
    }
  }

  /** Hold spot → walkable node: nodes inside the spot's 2 m cell, best cover first (then lowest id); else nearest(). */
  private snapHold(p: Vec3): number {
    const cell = this.map.cellSize;
    const x0 = Math.floor((p.x - this.ox) / cell) * cell, z0 = Math.floor((p.z - this.oz) / cell) * cell;
    let best = -1;
    for (let dz = 0; dz < cell; dz++) for (let dx = 0; dx < cell; dx++) {
      const id = this.nodeAt(x0 + dx, z0 + dz);
      if (id < 0) continue;
      if (best < 0 || this.nodes[id].coverScore > this.nodes[best].coverScore) best = id;
    }
    return best >= 0 ? best : this.nearest(p);
  }

  // ───────── queries ─────────

  nearest(p: Vec3): number {
    if (this.nodes.length === 0) return -1;
    const cx0 = Math.floor(p.x - this.ox), cz0 = Math.floor(p.z - this.oz);
    const maxR = this.cols + this.rows + Math.abs(cx0) + Math.abs(cz0);
    let best = -1, bestD = Infinity;
    for (let r = 0; r <= maxR; r++) {
      if (best >= 0 && r - 0.5 > bestD) break; // every node in ring r is ≥ r − 0.5 m away in XZ
      for (let dz = -r; dz <= r; dz++) {
        const edge = dz === -r || dz === r;
        for (let dx = -r; dx <= r; dx += edge ? 1 : 2 * r) {
          const id = this.nodeAt(cx0 + dx, cz0 + dz);
          if (id >= 0) {
            const n = this.nodes[id];
            const d = Math.hypot(n.pos.x - p.x, n.pos.z - p.z) + Math.abs(n.pos.y - p.y) * 2;
            if (d < bestD || (d === bestD && id < best)) { bestD = d; best = id; }
          }
          if (r === 0) break;
        }
      }
    }
    return best;
  }

  findPath(from: Vec3, to: Vec3, blocked = -1): number[] | null {
    const a = this.nearest(from), b = this.nearest(to);
    if (a < 0 || b < 0) return null;
    const useCache = blocked < 0 || blocked === a || blocked === b;
    if (useCache) {
      const key = a * this.nodes.length + b;
      const hit = this.cache.get(key);
      if (hit !== undefined) {
        this.cache.delete(key); this.cache.set(key, hit); // most recently used
        return hit ? Array.from(hit) : null;
      }
      const path = this.search(a, b, -1);
      if (this.cache.size >= NAV.cacheLimit) this.cache.delete(this.cache.keys().next().value as number); // least recently used
      this.cache.set(key, path ? Int32Array.from(path) : null);
      return path;
    }
    return this.search(a, b, blocked);
  }

  /** Number of cached (from, to) pairs (tests). */
  get cacheSize(): number { return this.cache.size; }

  private heapPush(id: number, f: number): void {
    if (this.heapN === this.heapId.length) {
      const ni = new Int32Array(this.heapId.length * 2), nf = new Float64Array(ni.length);
      ni.set(this.heapId); nf.set(this.heapF); this.heapId = ni; this.heapF = nf;
    }
    const hi = this.heapId, hf = this.heapF;
    let i = this.heapN++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (hf[p] < f || (hf[p] === f && hi[p] < id)) break;
      hi[i] = hi[p]; hf[i] = hf[p]; i = p;
    }
    hi[i] = id; hf[i] = f;
  }
  private heapPop(): number {
    const hi = this.heapId, hf = this.heapF;
    const top = hi[0];
    const n = --this.heapN;
    if (n > 0) {
      const id = hi[n], f = hf[n];
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        const c = r < n && (hf[r] < hf[l] || (hf[r] === hf[l] && hi[r] < hi[l])) ? r : l;
        if (hf[c] > f || (hf[c] === f && hi[c] > id)) break;
        hi[i] = hi[c]; hf[i] = hf[c]; i = c;
      }
      hi[i] = id; hf[i] = f;
    }
    return top;
  }

  private search(from: number, to: number, blocked: number): number[] | null {
    if (from === to) return [from];
    const st = ++this.stamp;
    const { g, came, seen, closed, edgeStart, edgeTo, edgeW } = this;
    const tp = this.nodes[to].pos;
    const h = (i: number) => { const p = this.nodes[i].pos; const dx = Math.abs(p.x - tp.x), dz = Math.abs(p.z - tp.z); return dx > dz ? dx + SQRT2M1 * dz : dz + SQRT2M1 * dx; };
    this.heapN = 0;
    g[from] = 0; came[from] = -1; seen[from] = st;
    this.heapPush(from, h(from));
    while (this.heapN > 0) {
      const cur = this.heapPop();
      if (closed[cur] === st) continue;
      if (cur === to) {
        const out: number[] = [];
        for (let c = cur; c !== -1; c = came[c]) out.push(c);
        return out.reverse();
      }
      closed[cur] = st;
      const gc = g[cur];
      for (let e = edgeStart[cur], end = edgeStart[cur + 1]; e < end; e++) {
        const nb = edgeTo[e];
        if (nb === blocked || closed[nb] === st) continue;
        const ng = gc + edgeW[e];
        if (seen[nb] !== st || ng < g[nb]) { seen[nb] = st; g[nb] = ng; came[nb] = cur; this.heapPush(nb, ng + h(nb)); }
      }
    }
    return null;
  }

  /** Flat straight segment a → b: same floor, walk-grid samples on that floor, three knee-height rays (body ± 0.35 m) clear. */
  private segmentClear(a: NavNode, b: NavNode): boolean {
    if (Math.abs(a.pos.y - b.pos.y) > 1e-3) return false;
    const dx = b.pos.x - a.pos.x, dz = b.pos.z - a.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < 1e-6) return true;
    const w = this.walk;
    const steps = Math.ceil(d / 0.25);
    for (let k = 1; k < steps; k++) {
      const t = k / steps;
      const i = w.index(a.pos.x + dx * t, a.pos.z + dz * t);
      if (!w.walkable[i] || w.ramp[i] || Math.abs(w.floorY[i] - a.pos.y) > 1e-3) return false;
    }
    const px = (-dz / d) * NAV.bodyExpand, pz = (dx / d) * NAV.bodyExpand;
    const y = a.pos.y + NAV.kneeHeight;
    for (const s of [0, 1, -1]) {
      if (!this.world.lineOfSight(v3(a.pos.x + px * s, y, a.pos.z + pz * s), v3(b.pos.x + px * s, y, b.pos.z + pz * s))) return false;
    }
    return true;
  }

  /** Path nodes ids[i..j] form one straight orthogonal grid run (how ramps are crossed). */
  private straightRun(ids: number[], i: number, j: number): boolean {
    const a = this.nodes[ids[i]], b = this.nodes[ids[i + 1]];
    const sx = b.cx - a.cx, sz = b.cz - a.cz;
    if (Math.abs(sx) + Math.abs(sz) !== 1) return false;
    for (let k = i + 1; k <= j; k++) {
      const p = this.nodes[ids[k - 1]], q = this.nodes[ids[k]];
      if (q.cx - p.cx !== sx || q.cz - p.cz !== sz) return false;
    }
    return true;
  }

  private canSkip(ids: number[], i: number, j: number): boolean {
    if (this.straightRun(ids, i, j)) return true;
    for (let k = i; k <= j; k++) if (this.nodes[ids[k]].ramp) return false;
    return this.segmentClear(this.nodes[ids[i]], this.nodes[ids[j]]);
  }

  pullString(ids: number[], out: Vec3[] = []): Vec3[] {
    out.length = 0;
    if (ids.length === 0) return out;
    if (ids.length === 1) { const n = this.nodes[ids[0]].pos; out.push(v3(n.x, n.y, n.z)); return out; }
    let a = 0, k = 1;
    while (k < ids.length) {
      if (k + 1 < ids.length && this.canSkip(ids, a, k + 1)) { k++; continue; }
      const n = this.nodes[ids[k]].pos;
      out.push(v3(n.x, n.y, n.z));
      a = k; k = a + 1;
    }
    return out;
  }

  coverNear(p: Vec3, threat: Vec3, radius: number): NavNode | null {
    const cand: { id: number; d: number }[] = [];
    const x0 = Math.floor(p.x - radius - this.ox), x1 = Math.floor(p.x + radius - this.ox);
    const z0 = Math.floor(p.z - radius - this.oz), z1 = Math.floor(p.z + radius - this.oz);
    for (let cz = z0; cz <= z1; cz++) for (let cx = x0; cx <= x1; cx++) {
      const id = this.nodeAt(cx, cz);
      if (id < 0 || this.nodes[id].coverScore === 0) continue;
      const n = this.nodes[id];
      const d = Math.hypot(n.pos.x - p.x, n.pos.z - p.z);
      if (d <= radius) cand.push({ id, d });
    }
    cand.sort((a, b) => a.d - b.d || a.id - b.id);
    const eye = v3(threat.x, threat.y + NAV.threatEye, threat.z);
    for (const c of cand) {
      const n = this.nodes[c.id];
      if (!this.world.lineOfSight(v3(n.pos.x, n.pos.y + NAV.coverEye, n.pos.z), eye)) return n;
    }
    return null;
  }

  holdSpot(id: string): { node: number; yaw: number; crouch: boolean } {
    const h = this.holds[id];
    if (!h) throw new Error(`unknown hold spot '${id}'`);
    return h;
  }

  randomNodeInArea(area: AreaId, rng: Rng): NavNode {
    const ids = this.byArea[area];
    if (!ids || ids.length === 0) return this.nodes[rng.int(0, this.nodes.length - 1)];
    return this.nodes[ids[rng.int(0, ids.length - 1)]];
  }

  clearCache(): void { this.cache.clear(); }

  edgeCost(a: number, b: number): number {
    if (a < 0 || a >= this.nodes.length) return Infinity;
    for (let e = this.edgeStart[a]; e < this.edgeStart[a + 1]; e++) if (this.edgeTo[e] === b) return this.edgeW[e];
    return Infinity;
  }

  ascii(): string {
    const lines: string[] = [];
    for (let cz = 0; cz < this.rows; cz++) {
      let line = '';
      for (let cx = 0; cx < this.cols; cx++) {
        const id = this.nodeAt(cx, cz);
        if (id < 0) { line += '#'; continue; }
        const n = this.nodes[id];
        line += n.chokepoint ? '!' : n.ramp ? '=' : n.pos.y > 0.01 ? '^' : '.';
      }
      lines.push(line);
    }
    return lines.join('\n');
  }
}

export function buildNavGraph(map: CompiledMap, world: StaticWorld): NavGraph { return new NavGraphImpl(map, world); }
