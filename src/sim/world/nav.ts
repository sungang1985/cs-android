/**
 * Navigation grid derived automatically from the collision world: one node per walkable (cell, layer),
 * 8-connected with step-height limits, A* search and line-of-walk path smoothing.
 * Pure TypeScript, deterministic; built once per map at load (a few ms for a 60x60 m map at 1 m cells).
 */
import { Aabb, Vec3, v3, v3distXZ } from '../../core/math';
import { StaticWorld, BodyShape } from './collision';

export interface NavNode {
  id: number;
  /** World position of the node (cell centre, feet height). */
  x: number; y: number; z: number;
  cx: number; cz: number;
  /** Neighbour node ids (precomputed). */
  edges: number[];
  /** Authoring tags assigned via tagNodes (e.g. 'siteA', 'tspawn', 'cover'). */
  tags: Set<string>;
}

export interface NavOptions {
  /** Cell size in metres (default 1). */
  cell?: number;
  body: BodyShape;
  /** XZ extent to sample (default: world bounds). */
  bounds?: Aabb;
  /** Highest floor considered walkable (default 3.5): keeps wall tops out of the graph. */
  maxY?: number;
}

export class NavGrid {
  readonly nodes: NavNode[] = [];
  readonly cell: number;
  readonly cols: number;
  readonly rows: number;
  readonly originX: number;
  readonly originZ: number;
  private readonly body: BodyShape;
  /** nodes per cell (layers), indexed by cz*cols+cx */
  private readonly cellNodes: number[][];

  constructor(readonly world: StaticWorld, opts: NavOptions) {
    this.cell = opts.cell ?? 1;
    this.body = opts.body;
    const b = opts.bounds ?? world.bounds;
    this.originX = b.min.x; this.originZ = b.min.z;
    this.cols = Math.max(1, Math.ceil((b.max.x - b.min.x) / this.cell));
    this.rows = Math.max(1, Math.ceil((b.max.z - b.min.z) / this.cell));
    this.cellNodes = Array.from({ length: this.cols * this.rows }, () => []);
    const maxY = opts.maxY ?? 3.5;
    const hw = this.body.halfWidth, h = this.body.height;
    const box: Aabb = { min: v3(), max: v3() };
    for (let cz = 0; cz < this.rows; cz++) {
      for (let cx = 0; cx < this.cols; cx++) {
        const x = this.originX + (cx + 0.5) * this.cell, z = this.originZ + (cz + 0.5) * this.cell;
        // Candidate floors: ground plane + every solid top under the footprint, highest first.
        const cands = this.candidateFloors(x, z, hw, maxY);
        for (const y of cands) {
          box.min.x = x - hw; box.min.y = y + 1e-3; box.min.z = z - hw; box.max.x = x + hw; box.max.y = y + h; box.max.z = z + hw;
          if (world.overlaps(box)) continue;
          // The floor directly under the centre must be this height (not a lower ledge the footprint merely touches).
          const fc = world.floorHeightAt(x, z, y + 1e-3, hw * 0.5);
          if (Math.abs(fc - y) > 1e-3) continue;
          const id = this.nodes.length;
          this.nodes.push({ id, x, y, z, cx, cz, edges: [], tags: new Set() });
          this.cellNodes[cz * this.cols + cx].push(id);
        }
      }
    }
    this.link();
    this.prune();
  }

  private candidateFloors(x: number, z: number, hw: number, maxY: number): number[] {
    const q: Aabb = { min: v3(x - hw, -1e9, z - hw), max: v3(x + hw, maxY, z + hw) };
    const set = new Set<number>();
    if (this.world.groundY !== null) set.add(this.world.groundY);
    for (const s of this.world.query(q)) if (s.box.max.y <= maxY) set.add(s.box.max.y);
    return [...set].sort((a, b) => b - a);
  }

  private link(): void {
    const step = this.body.stepHeight;
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
    for (const n of this.nodes) {
      for (const [dx, dz] of dirs) {
        const cx = n.cx + dx, cz = n.cz + dz;
        if (cx < 0 || cz < 0 || cx >= this.cols || cz >= this.rows) continue;
        for (const mid of this.cellNodes[cz * this.cols + cx]) {
          const m = this.nodes[mid];
          if (Math.abs(m.y - n.y) > step + 1e-6) continue;
          if (dx !== 0 && dz !== 0) {
            // no corner cutting: both orthogonal neighbours must be walkable at a compatible height
            if (!this.hasNodeNear(n.cx + dx, n.cz, n.y, step) || !this.hasNodeNear(n.cx, n.cz + dz, n.y, step)) continue;
          }
          if (!this.canWalkStraight(n, m)) continue;
          n.edges.push(mid);
        }
      }
    }
  }

  /** Number of nodes dropped by prune() (islands not connected to the main walkable area). */
  prunedCount = 0;

  /** Keep only the largest connected component: crate tops, wall tops and ledges nothing walks to are dropped. */
  private prune(): void {
    const N = this.nodes.length;
    if (N === 0) return;
    const comp = new Int32Array(N).fill(-1);
    const sizes: number[] = [];
    const stack: number[] = [];
    for (let i = 0; i < N; i++) {
      if (comp[i] !== -1) continue;
      const c = sizes.length; sizes.push(0);
      stack.push(i); comp[i] = c;
      while (stack.length) {
        const cur = stack.pop()!; sizes[c]++;
        for (const e of this.nodes[cur].edges) if (comp[e] === -1) { comp[e] = c; stack.push(e); }
      }
    }
    let main = 0; for (let c = 1; c < sizes.length; c++) if (sizes[c] > sizes[main]) main = c;
    const keep = this.nodes.filter((n) => comp[n.id] === main);
    this.prunedCount = N - keep.length;
    const remap = new Int32Array(N).fill(-1);
    keep.forEach((n, i) => { remap[n.id] = i; });
    for (const n of keep) { n.id = remap[n.id]; n.edges = n.edges.map((e) => remap[e]).filter((e) => e >= 0); }
    this.nodes.length = 0; this.nodes.push(...keep);
    for (let i = 0; i < this.cellNodes.length; i++) this.cellNodes[i] = this.cellNodes[i].map((id) => remap[id]).filter((id) => id >= 0);
  }

  private hasNodeNear(cx: number, cz: number, y: number, step: number): boolean {
    if (cx < 0 || cz < 0 || cx >= this.cols || cz >= this.rows) return false;
    for (const id of this.cellNodes[cz * this.cols + cx]) if (Math.abs(this.nodes[id].y - y) <= step + 1e-6) return true;
    return false;
  }

  /** Can a body walk in a straight line from a to b (sampled every 0.25 m, floor changes limited to stepHeight)? */
  canWalkStraight(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): boolean {
    const hw = this.body.halfWidth, h = this.body.height, step = this.body.stepHeight;
    const d = Math.hypot(b.x - a.x, b.z - a.z);
    const n = Math.max(1, Math.ceil(d / 0.25));
    let y = a.y;
    const box: Aabb = { min: v3(), max: v3() };
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      const x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
      const floor = this.world.floorHeightAt(x, z, y + step + 1e-3, hw); // full footprint, like moveBody's snapping
      if (!isFinite(floor) || Math.abs(floor - y) > step + 1e-6) return false;
      y = floor;
      box.min.x = x - hw; box.min.y = y + 1e-3; box.min.z = z - hw; box.max.x = x + hw; box.max.y = y + h; box.max.z = z + hw;
      if (this.world.overlaps(box)) return false;
    }
    return Math.abs(y - b.y) <= step + 1e-6;
  }

  /** Nearest node to a world position (prefers same layer; searches outward up to `radius` cells). */
  nearest(p: Vec3, radius = 4): NavNode | null {
    const cx = Math.floor((p.x - this.originX) / this.cell), cz = Math.floor((p.z - this.originZ) / this.cell);
    let best: NavNode | null = null, bestD = Infinity;
    for (let r = 0; r <= radius; r++) {
      for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const x = cx + dx, z = cz + dz;
        if (x < 0 || z < 0 || x >= this.cols || z >= this.rows) continue;
        for (const id of this.cellNodes[z * this.cols + x]) {
          const n = this.nodes[id];
          const dy = Math.abs(n.y - p.y);
          const d = Math.hypot(n.x - p.x, n.z - p.z) + dy * 2;
          if (d < bestD) { bestD = d; best = n; }
        }
      }
      if (best && r >= 1) break;
    }
    return best;
  }

  nodeAt(cx: number, cz: number, layer = 0): NavNode | null {
    if (cx < 0 || cz < 0 || cx >= this.cols || cz >= this.rows) return null;
    const ids = this.cellNodes[cz * this.cols + cx];
    return ids.length > layer ? this.nodes[ids[layer]] : null;
  }

  /** Tag every node inside the box (XZ, and y within box). */
  tagNodes(box: Aabb, tag: string): number {
    let n = 0;
    for (const node of this.nodes) {
      if (node.x >= box.min.x && node.x <= box.max.x && node.z >= box.min.z && node.z <= box.max.z && node.y >= box.min.y - 0.01 && node.y <= box.max.y) { node.tags.add(tag); n++; }
    }
    return n;
  }
  byTag(tag: string): NavNode[] { return this.nodes.filter((n) => n.tags.has(tag)); }

  nodesWithin(p: Vec3, r: number): NavNode[] {
    const out: NavNode[] = [];
    for (const n of this.nodes) if (v3distXZ(n, p) <= r && Math.abs(n.y - p.y) <= this.body.stepHeight * 4) out.push(n);
    return out;
  }

  /** A* between node ids. Returns node ids from→to inclusive, or null. */
  search(from: number, to: number): number[] | null {
    if (from === to) return [from];
    const N = this.nodes.length;
    const g = new Float64Array(N).fill(Infinity);
    const f = new Float64Array(N).fill(Infinity);
    const came = new Int32Array(N).fill(-1);
    const closed = new Uint8Array(N);
    const open = new BinaryHeap((i) => f[i]);
    const target = this.nodes[to];
    const h = (i: number) => { const n = this.nodes[i]; return Math.hypot(n.x - target.x, n.z - target.z) + Math.abs(n.y - target.y); };
    g[from] = 0; f[from] = h(from); open.push(from);
    while (open.size > 0) {
      const cur = open.pop();
      if (cur === to) {
        const path: number[] = []; let c = cur;
        while (c !== -1) { path.push(c); c = came[c]; }
        return path.reverse();
      }
      if (closed[cur]) continue;
      closed[cur] = 1;
      const cn = this.nodes[cur];
      for (const nb of cn.edges) {
        if (closed[nb]) continue;
        const m = this.nodes[nb];
        const cost = Math.hypot(m.x - cn.x, m.z - cn.z) + Math.abs(m.y - cn.y) * 1.5;
        const ng = g[cur] + cost;
        if (ng < g[nb]) { g[nb] = ng; f[nb] = ng + h(nb); came[nb] = cur; open.push(nb); }
      }
    }
    return null;
  }

  /** World-space path from a to b (smoothed). The first point is the first waypoint, not `a`. */
  findPath(a: Vec3, b: Vec3): Vec3[] | null {
    const na = this.nearest(a), nb = this.nearest(b);
    if (!na || !nb) return null;
    const ids = this.search(na.id, nb.id);
    if (!ids) return null;
    const pts: Vec3[] = ids.map((i) => v3(this.nodes[i].x, this.nodes[i].y, this.nodes[i].z));
    // If the destination is close to its node, walk to the exact destination.
    if (v3distXZ(b, nb) < this.cell && Math.abs(b.y - nb.y) <= this.body.stepHeight) pts.push(v3(b.x, nb.y, b.z));
    return this.smooth(a, pts);
  }

  /** Greedy string pulling: skip intermediate waypoints while a straight walk is possible. */
  smooth(start: Vec3, pts: Vec3[]): Vec3[] {
    if (pts.length <= 1) return pts;
    const out: Vec3[] = [];
    let cur: { x: number; y: number; z: number } = { x: start.x, y: this.nearest(start)?.y ?? start.y, z: start.z };
    let i = 0;
    while (i < pts.length) {
      let j = pts.length - 1;
      while (j > i && !this.canWalkStraight(cur, pts[j])) j--;
      if (j === i && !this.canWalkStraight(cur, pts[i])) { out.push(pts[i]); cur = pts[i]; i++; continue; }
      out.push(pts[j]); cur = pts[j]; i = j + 1;
    }
    return out;
  }

  /** Total XZ length of a path starting at `from`. */
  pathLength(from: Vec3, path: Vec3[]): number {
    let d = 0; let prev = from;
    for (const p of path) { d += v3distXZ(prev, p); prev = p; }
    return d;
  }

  /** ASCII dump for debugging / tools (one char per cell: '.' walkable, '#' blocked, letters for tags). */
  ascii(): string {
    const lines: string[] = [];
    for (let cz = 0; cz < this.rows; cz++) {
      let line = '';
      for (let cx = 0; cx < this.cols; cx++) {
        const ids = this.cellNodes[cz * this.cols + cx];
        if (!ids.length) { line += '#'; continue; }
        const n = this.nodes[ids[0]];
        const tag = [...n.tags][0];
        line += tag ? tag[0].toUpperCase() : ids.length > 1 ? '=' : n.y > 0.01 ? '^' : '.';
      }
      lines.push(line);
    }
    return lines.join('\n');
  }
}

class BinaryHeap {
  private a: number[] = [];
  constructor(private readonly key: (i: number) => number) {}
  get size(): number { return this.a.length; }
  push(v: number): void {
    const a = this.a; a.push(v);
    let i = a.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (this.key(a[p]) <= this.key(a[i])) break; [a[p], a[i]] = [a[i], a[p]]; i = p; }
  }
  pop(): number {
    const a = this.a; const top = a[0]; const last = a.pop()!;
    if (a.length) {
      a[0] = last; let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < a.length && this.key(a[l]) < this.key(a[m])) m = l;
        if (r < a.length && this.key(a[r]) < this.key(a[m])) m = r;
        if (m === i) break; [a[m], a[i]] = [a[i], a[m]]; i = m;
      }
    }
    return top;
  }
}
