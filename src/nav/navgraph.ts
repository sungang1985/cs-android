/**
 * Navigation graph derived from CompiledMap.walk (1 m sub-grid): nodes, 8-connected edges with the ramp rule,
 * A* over node ids (LRU-cached per round), string pulling, cover queries, hold spots. DESIGN.md §6.4.
 * Pure TypeScript, deterministic, no Set/Map iteration in results (edges are sorted arrays).
 */
import { Aabb, Vec3, v3, v3distXZ, dirFromYawPitch } from '../core/math';
import type { Rng } from '../core/rng';
import type { StaticWorld } from '../world/collision';
import type { CompiledMap, AreaId } from '../world/types';
import { BODY } from '../sim/state';

export interface NavNode {
  id: number; pos: Vec3; area: AreaId | null; chokepoint: boolean; coverScore: number; coverHeight: number; nearWall: boolean; ramp: boolean;
  /** neighbour ids, ascending */
  edges: number[];
  /** sub-grid coordinates */
  cx: number; cz: number;
}

export interface NavGraph {
  nodes: NavNode[];
  nearest(p: Vec3): number;
  findPath(from: Vec3, to: Vec3, blocked?: number): number[] | null;
  pullString(ids: number[], out?: Vec3[]): Vec3[];
  coverNear(p: Vec3, threat: Vec3, radius: number): NavNode | null;
  holdSpot(id: string): { node: number; yaw: number; crouch: boolean };
  randomNodeInArea(area: AreaId, rng: Rng): NavNode;
  clearCache(): void;
  /** Debug: ASCII dump ('#' blocked, '.' floor, '^' raised, '!' chokepoint). */
  ascii(): string;
}

const MAX_STEP = 0.6;
const CACHE_LIMIT = 512;

class NavGraphImpl implements NavGraph {
  readonly nodes: NavNode[] = [];
  private readonly cellNode: Int32Array; // sub-cell index → node id or -1
  private readonly cols: number; private readonly rows: number; private readonly ox: number; private readonly oz: number;
  private cache = new Map<number, number[] | null>();
  private readonly holds = new Map<string, { node: number; yaw: number; crouch: boolean }>();
  private readonly byArea = new Map<AreaId, number[]>();

  constructor(private readonly map: CompiledMap, private readonly world: StaticWorld) {
    const w = map.walk;
    this.cols = w.cols; this.rows = w.rows; this.ox = w.originX; this.oz = w.originZ;
    this.cellNode = new Int32Array(w.cols * w.rows).fill(-1);
    for (let cz = 0; cz < w.rows; cz++) for (let cx = 0; cx < w.cols; cx++) {
      const i = cz * w.cols + cx;
      if (!w.walkable[i]) continue;
      const x = this.ox + cx + 0.5, z = this.oz + cz + 0.5, y = w.floorY[i];
      const id = this.nodes.length;
      this.cellNode[i] = id;
      this.nodes.push({ id, pos: v3(x, y, z), area: map.areaAt(x, z), chokepoint: false, coverScore: 0, coverHeight: 0, nearWall: false, ramp: w.ramp[i] === 1, edges: [], cx, cz });
    }
    this.link();
    this.tag();
    for (const n of this.nodes) { if (n.area) { let a = this.byArea.get(n.area); if (!a) { a = []; this.byArea.set(n.area, a); } a.push(n.id); } }
    for (const h of map.holdSpots) this.holds.set(h.id, { node: this.nearest(h.pos), yaw: h.yaw, crouch: h.crouch });
  }

  private nodeAt(cx: number, cz: number): number {
    if (cx < 0 || cz < 0 || cx >= this.cols || cz >= this.rows) return -1;
    return this.cellNode[cz * this.cols + cx];
  }

  private link(): void {
    const dirs: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
    for (const n of this.nodes) {
      for (const [dx, dz] of dirs) {
        const m = this.nodeAt(n.cx + dx, n.cz + dz);
        if (m < 0) continue;
        const o = this.nodes[m];
        const diagonal = dx !== 0 && dz !== 0;
        if (n.ramp || o.ramp) {
          if (diagonal) continue; // never diagonally into/out of ramp sub-cells
          // orthogonal edges on ramps are always created (wedge heights exceed the step test)
          n.edges.push(m); continue;
        }
        if (Math.abs(o.pos.y - n.pos.y) > MAX_STEP) continue;
        if (diagonal) {
          const a = this.nodeAt(n.cx + dx, n.cz), b = this.nodeAt(n.cx, n.cz + dz);
          if (a < 0 || b < 0) continue;
          if (Math.abs(this.nodes[a].pos.y - n.pos.y) > MAX_STEP || Math.abs(this.nodes[b].pos.y - n.pos.y) > MAX_STEP) continue;
        }
        n.edges.push(m);
      }
      n.edges.sort((a, b) => a - b);
    }
  }

  /** Chokepoint, cover and wall proximity tags. */
  private tag(): void {
    const w = this.map.walk;
    const walk = (cx: number, cz: number) => cx >= 0 && cz >= 0 && cx < this.cols && cz < this.rows && w.walkable[cz * this.cols + cx] === 1;
    const chokeCells = new Set<number>();
    for (const c of this.map.chokes) { const n = this.nearest(c.pos); if (n >= 0) chokeCells.add(n); }
    const dirs8 = [0, 45, 90, 135, 180, 225, 270, 315].map((d) => (d * Math.PI) / 180);
    for (const n of this.nodes) {
      // corridor width: free run along x and along z through this cell (in cells)
      let wx = 1, wz = 1;
      for (let d = 1; d <= 3 && walk(n.cx + d, n.cz); d++) wx++;
      for (let d = 1; d <= 3 && walk(n.cx - d, n.cz); d++) wx++;
      for (let d = 1; d <= 3 && walk(n.cx, n.cz + d); d++) wz++;
      for (let d = 1; d <= 3 && walk(n.cx, n.cz - d); d++) wz++;
      const narrow = Math.min(wx, wz) <= 2 && Math.max(wx, wz) >= 4;
      n.chokepoint = narrow || chokeCells.has(n.id);
      // cover: how many of 8 directions hit a solid ≥ 1.0 m tall within 1.2 m (probe at 0.6 m above the floor)
      let score = 0, height = 0;
      const o = v3(n.pos.x, n.pos.y + 0.6, n.pos.z);
      for (const a of dirs8) {
        const dir = dirFromYawPitch(a, 0);
        const hit = this.world.raycast(o, dir, 1.2, (s) => s.box.max.y - n.pos.y >= 1.0);
        if (hit && hit.solid) { score++; height = Math.max(height, hit.solid.box.max.y - n.pos.y); }
      }
      n.coverScore = score; n.coverHeight = height >= 2 ? 2 : height >= 1.2 ? 1.2 : height >= 1 ? 1 : 0;
      // nearWall: any solid ≥ 1 m within 0.5 m (cost penalty)
      const near: Aabb = { min: v3(n.pos.x - 0.8, n.pos.y + 0.1, n.pos.z - 0.8), max: v3(n.pos.x + 0.8, n.pos.y + 1.0, n.pos.z + 0.8) };
      n.nearWall = this.world.query(near).some((s) => s.box.max.y - n.pos.y >= 1.0 && s.kind !== 'ramp-step');
    }
  }

  nearest(p: Vec3): number {
    const cx0 = Math.floor(p.x - this.ox), cz0 = Math.floor(p.z - this.oz);
    let best = -1, bestD = Infinity;
    for (let r = 0; r <= 6; r++) {
      for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const id = this.nodeAt(cx0 + dx, cz0 + dz);
        if (id < 0) continue;
        const n = this.nodes[id];
        const d = Math.hypot(n.pos.x - p.x, n.pos.z - p.z) + Math.abs(n.pos.y - p.y) * 2;
        if (d < bestD) { bestD = d; best = id; }
      }
      if (best >= 0 && r >= 1) break;
    }
    return best;
  }

  findPath(from: Vec3, to: Vec3, blocked = -1): number[] | null {
    const a = this.nearest(from), b = this.nearest(to);
    if (a < 0 || b < 0) return null;
    const key = (a * 65536 + b) * 4096 + (blocked >= 0 ? (blocked % 4095) + 1 : 0);
    if (blocked < 0) { const c = this.cache.get(key); if (c !== undefined) return c ? c.slice() : null; }
    const path = this.search(a, b, blocked);
    if (blocked < 0) { if (this.cache.size >= CACHE_LIMIT) this.cache.delete(this.cache.keys().next().value as number); this.cache.set(key, path ? path.slice() : null); }
    return path;
  }

  private search(from: number, to: number, blocked: number): number[] | null {
    if (from === to) return [from];
    const N = this.nodes.length;
    const g = new Float64Array(N).fill(Infinity), f = new Float64Array(N).fill(Infinity);
    const came = new Int32Array(N).fill(-1), closed = new Uint8Array(N);
    const heap = new MinHeap((i) => f[i]);
    const t = this.nodes[to].pos;
    const h = (i: number) => { const p = this.nodes[i].pos; const dx = Math.abs(p.x - t.x), dz = Math.abs(p.z - t.z); return Math.max(dx, dz) + 0.41421356 * Math.min(dx, dz) + Math.abs(p.y - t.y); };
    g[from] = 0; f[from] = h(from); heap.push(from);
    while (heap.size) {
      const cur = heap.pop();
      if (cur === to) { const out: number[] = []; let c = cur; while (c !== -1) { out.push(c); c = came[c]; } return out.reverse(); }
      if (closed[cur]) continue;
      closed[cur] = 1;
      const cn = this.nodes[cur];
      for (const nb of cn.edges) {
        if (closed[nb] || nb === blocked) continue;
        const m = this.nodes[nb];
        let cost = Math.hypot(m.pos.x - cn.pos.x, m.pos.z - cn.pos.z) + Math.abs(m.pos.y - cn.pos.y) * 1.5;
        if (m.nearWall || cn.nearWall) cost *= 1.4;
        const ng = g[cur] + cost;
        if (ng < g[nb]) { g[nb] = ng; f[nb] = ng + h(nb); came[nb] = cur; heap.push(nb); }
      }
    }
    return null;
  }

  /** Straight-line walkability between two nodes at knee height with the body expanded 0.35 m (3 parallel rays). */
  private clear(a: Vec3, b: Vec3): boolean {
    const dx = b.x - a.x, dz = b.z - a.z; const d = Math.hypot(dx, dz);
    if (d < 1e-6) return true;
    const px = -dz / d * 0.35, pz = dx / d * 0.35;
    for (const [ox, oz] of [[0, 0], [px, pz], [-px, -pz]]) {
      if (!this.world.lineOfSight(v3(a.x + ox, a.y + 0.5, a.z + oz), v3(b.x + ox, b.y + 0.5, b.z + oz), (s) => s.kind !== 'ramp-step')) return false;
    }
    return true;
  }

  pullString(ids: number[], out: Vec3[] = []): Vec3[] {
    out.length = 0;
    if (ids.length === 0) return out;
    let i = 0;
    while (i < ids.length - 1) {
      const a = this.nodes[ids[i]];
      let j = ids.length - 1;
      while (j > i + 1) {
        const bNode = this.nodes[ids[j]];
        // never skip across ramp nodes (height changes) unless both ends share the floor
        if (Math.abs(bNode.pos.y - a.pos.y) < 1e-3 && !this.rampBetween(ids, i, j) && this.clear(a.pos, bNode.pos)) break;
        j--;
      }
      const n = this.nodes[ids[j]];
      out.push(v3(n.pos.x, n.pos.y, n.pos.z));
      i = j;
    }
    if (out.length === 0) { const n = this.nodes[ids[ids.length - 1]]; out.push(v3(n.pos.x, n.pos.y, n.pos.z)); }
    return out;
  }
  private rampBetween(ids: number[], i: number, j: number): boolean { for (let k = i + 1; k < j; k++) if (this.nodes[ids[k]].ramp) return true; return false; }

  coverNear(p: Vec3, threat: Vec3, radius: number): NavNode | null {
    let best: NavNode | null = null, bestD = Infinity;
    for (const n of this.nodes) {
      if (n.coverScore === 0) continue;
      const d = v3distXZ(n.pos, p);
      if (d > radius || d >= bestD) continue;
      const eye = v3(n.pos.x, n.pos.y + (n.coverHeight >= 1.2 ? 1.1 : 0.9), n.pos.z);
      if (this.world.lineOfSight(eye, v3(threat.x, threat.y + 1.2, threat.z))) continue; // still visible → not cover
      best = n; bestD = d;
    }
    return best;
  }

  holdSpot(id: string): { node: number; yaw: number; crouch: boolean } {
    const h = this.holds.get(id);
    if (!h) throw new Error(`unknown hold spot ${id}`);
    return h;
  }

  randomNodeInArea(area: AreaId, rng: Rng): NavNode {
    const ids = this.byArea.get(area);
    if (!ids || ids.length === 0) return this.nodes[rng.int(0, this.nodes.length - 1)];
    return this.nodes[ids[rng.int(0, ids.length - 1)]];
  }

  clearCache(): void { this.cache.clear(); }

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

/** Body shape used when sampling walkability (shared with world/compile.ts). */
export const NAV_BODY = { halfWidth: BODY.halfWidth, height: BODY.standHeight, stepHeight: BODY.stepHeight };

class MinHeap {
  private a: number[] = [];
  constructor(private readonly key: (i: number) => number) {}
  get size(): number { return this.a.length; }
  push(v: number): void {
    const a = this.a; a.push(v); let i = a.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (this.key(a[p]) <= this.key(a[i])) break; [a[p], a[i]] = [a[i], a[p]]; i = p; }
  }
  pop(): number {
    const a = this.a; const top = a[0]; const last = a.pop()!;
    if (a.length) { a[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < a.length && this.key(a[l]) < this.key(a[m])) m = l; if (r < a.length && this.key(a[r]) < this.key(a[m])) m = r; if (m === i) break; [a[m], a[i]] = [a[i], a[m]]; i = m; } }
    return top;
  }
}
