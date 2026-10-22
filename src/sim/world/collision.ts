/**
 * Static collision world: axis-aligned solids with a uniform XZ grid broadphase, ray casts (single and
 * multi-hit for wall penetration), floor probing and AABB body movement with step-up.
 * Pure TypeScript: no DOM, no Three.js. Deterministic.
 *
 * Bodies (players) are AABBs positioned by their feet centre: box = [x-hw, y, z-hw] .. [x+hw, y+h, z+hw].
 * Ramps and stairs are authored as stacks of thin boxes; the step-up logic climbs them.
 */
import { Aabb, Vec3, v3, v3copy, aabbOverlap, rayAabb } from '../../core/math';

export type SurfaceId = 'concrete' | 'sand' | 'wood' | 'metal' | 'brick' | 'ground' | 'glass' | 'plaster';

export interface Solid {
  /** Index in the world's solid array (stable). */
  id: number;
  box: Aabb;
  surface: SurfaceId;
  /** Can bullets penetrate this solid? (thin walls, crates, doors). Thickness decides damage loss. */
  penetrable: boolean;
  /** Optional authoring tag (e.g. "crate", "wall", "stairs") for the renderer/tools. */
  tag?: string;
}

export interface RayHit {
  /** Distance along the ray to the entry point. */
  t: number;
  /** Distance to the exit point (for penetration thickness); equals t for the ground plane. */
  tExit: number;
  point: Vec3;
  normal: Vec3;
  solid: Solid | null; // null = ground plane
  surface: SurfaceId;
}

export interface MoveResult {
  pos: Vec3;
  vel: Vec3;
  grounded: boolean;
  /** Horizontal movement was clipped by a wall this step. */
  hitWall: boolean;
  /** Head hit a ceiling. */
  hitCeiling: boolean;
  steppedUp: boolean;
  /** Surface the body is standing on (if grounded). */
  groundSurface: SurfaceId;
}

export interface BodyShape {
  /** Half width in XZ (0.3 m for players). */
  halfWidth: number;
  /** Height (1.8 standing, 1.3 crouched). */
  height: number;
  /** Max step the body can climb without jumping (0.5 m). */
  stepHeight: number;
}

const SKIN = 1e-4;

/** Ray vs AABB returning [tEnter, tExit] or null (tEnter clamped to >= 0). */
export function rayAabbRange(origin: Vec3, dir: Vec3, box: Aabb, tMax = Infinity): [number, number] | null {
  let tmin = 0, tmax = tMax;
  const o = [origin.x, origin.y, origin.z], d = [dir.x, dir.y, dir.z];
  const mn = [box.min.x, box.min.y, box.min.z], mx = [box.max.x, box.max.y, box.max.z];
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-12) {
      if (o[i] < mn[i] || o[i] > mx[i]) return null;
    } else {
      const inv = 1 / d[i];
      let t1 = (mn[i] - o[i]) * inv, t2 = (mx[i] - o[i]) * inv;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return null;
    }
  }
  return [tmin, tmax];
}

export class StaticWorld {
  readonly solids: Solid[] = [];
  readonly bounds: Aabb;
  private readonly cellSize: number;
  private readonly cols: number;
  private readonly rows: number;
  private readonly cells: number[][];
  private stamp = 1;
  private readonly stamps: Int32Array;
  /** Whether an infinite ground plane exists at y = groundY (true for all shipped maps). */
  readonly groundY: number | null;

  constructor(solids: Array<Omit<Solid, 'id'>>, opts: { cellSize?: number; groundY?: number | null; bounds?: Aabb } = {}) {
    this.cellSize = opts.cellSize ?? 4;
    this.groundY = opts.groundY === undefined ? 0 : opts.groundY;
    for (const s of solids) this.solids.push({ ...s, id: this.solids.length, box: { min: v3copy(s.box.min), max: v3copy(s.box.max) } });
    const b: Aabb = opts.bounds ?? this.computeBounds();
    this.bounds = b;
    this.cols = Math.max(1, Math.ceil((b.max.x - b.min.x) / this.cellSize) + 1);
    this.rows = Math.max(1, Math.ceil((b.max.z - b.min.z) / this.cellSize) + 1);
    this.cells = Array.from({ length: this.cols * this.rows }, () => []);
    this.stamps = new Int32Array(this.solids.length);
    for (const s of this.solids) this.forCells(s.box, (ci) => this.cells[ci].push(s.id));
  }

  private computeBounds(): Aabb {
    const b: Aabb = { min: v3(Infinity, Infinity, Infinity), max: v3(-Infinity, -Infinity, -Infinity) };
    for (const s of this.solids) {
      b.min.x = Math.min(b.min.x, s.box.min.x); b.min.y = Math.min(b.min.y, s.box.min.y); b.min.z = Math.min(b.min.z, s.box.min.z);
      b.max.x = Math.max(b.max.x, s.box.max.x); b.max.y = Math.max(b.max.y, s.box.max.y); b.max.z = Math.max(b.max.z, s.box.max.z);
    }
    if (!isFinite(b.min.x)) return { min: v3(-1, -1, -1), max: v3(1, 1, 1) };
    return b;
  }

  private cellIndex(cx: number, cz: number): number { return cz * this.cols + cx; }
  private cellCoord(x: number, z: number): [number, number] {
    const cx = Math.floor((x - this.bounds.min.x) / this.cellSize), cz = Math.floor((z - this.bounds.min.z) / this.cellSize);
    return [Math.min(this.cols - 1, Math.max(0, cx)), Math.min(this.rows - 1, Math.max(0, cz))];
  }
  private forCells(box: Aabb, fn: (ci: number) => void): void {
    const [x0, z0] = this.cellCoord(box.min.x, box.min.z);
    const [x1, z1] = this.cellCoord(box.max.x, box.max.z);
    for (let cz = z0; cz <= z1; cz++) for (let cx = x0; cx <= x1; cx++) fn(this.cellIndex(cx, cz));
  }

  /** Solids whose boxes overlap the query box (deduplicated, ordered by id). */
  query(box: Aabb, out: Solid[] = []): Solid[] {
    out.length = 0;
    const st = ++this.stamp;
    this.forCells(box, (ci) => {
      for (const id of this.cells[ci]) {
        if (this.stamps[id] === st) continue;
        this.stamps[id] = st;
        const s = this.solids[id];
        if (aabbOverlap(box, s.box)) out.push(s);
      }
    });
    if (out.length > 1) out.sort((a, b) => a.id - b.id);
    return out;
  }

  /** Does a body box overlap any solid (or sit below the ground plane)? */
  overlaps(box: Aabb): boolean {
    if (this.groundY !== null && box.min.y < this.groundY - SKIN) return true;
    const st = ++this.stamp;
    let hit = false;
    this.forCells(box, (ci) => {
      if (hit) return;
      for (const id of this.cells[ci]) {
        if (this.stamps[id] === st) continue;
        this.stamps[id] = st;
        if (aabbOverlap(box, this.solids[id].box)) { hit = true; return; }
      }
    });
    return hit;
  }

  /**
   * Height of the highest walkable surface at (x, z) that is at or below yStart (+ small tolerance),
   * considering a body of the given half width. Returns -Infinity if nothing (no ground plane).
   */
  floorHeightAt(x: number, z: number, yStart: number, halfWidth = 0): number {
    let best = this.groundY === null ? -Infinity : this.groundY;
    const q: Aabb = { min: v3(x - halfWidth, -1e9, z - halfWidth), max: v3(x + halfWidth, yStart + SKIN, z + halfWidth) };
    const st = ++this.stamp;
    this.forCells(q, (ci) => {
      for (const id of this.cells[ci]) {
        if (this.stamps[id] === st) continue;
        this.stamps[id] = st;
        const b = this.solids[id].box;
        if (b.max.x <= q.min.x || b.min.x >= q.max.x || b.max.z <= q.min.z || b.min.z >= q.max.z) continue;
        if (b.max.y <= yStart + SKIN && b.max.y > best) best = b.max.y;
      }
    });
    return best;
  }

  /** Nearest ray hit against solids and the ground plane. `dir` must be normalised. */
  raycast(origin: Vec3, dir: Vec3, maxDist = 1000, filter?: (s: Solid) => boolean): RayHit | null {
    let best: RayHit | null = null;
    let bestT = maxDist;
    // Ground plane
    if (this.groundY !== null && dir.y < -1e-9 && origin.y > this.groundY) {
      const t = (this.groundY - origin.y) / dir.y;
      if (t < bestT) {
        bestT = t;
        best = { t, tExit: t, point: v3(origin.x + dir.x * t, this.groundY, origin.z + dir.z * t), normal: v3(0, 1, 0), solid: null, surface: 'ground' };
      }
    }
    this.walkRay(origin, dir, bestT, (s) => {
      if (filter && !filter(s)) return;
      const r = rayAabbRange(origin, dir, s.box, bestT);
      if (r && r[0] < bestT) {
        bestT = r[0];
        const p = v3(origin.x + dir.x * r[0], origin.y + dir.y * r[0], origin.z + dir.z * r[0]);
        best = { t: r[0], tExit: r[1], point: p, normal: faceNormal(s.box, p, dir), solid: s, surface: s.surface };
      }
    });
    return best;
  }

  /** All hits along the ray sorted by distance (for penetration). Ground plane included last if hit. */
  raycastAll(origin: Vec3, dir: Vec3, maxDist = 1000): RayHit[] {
    const hits: RayHit[] = [];
    this.walkRay(origin, dir, maxDist, (s) => {
      const r = rayAabbRange(origin, dir, s.box, maxDist);
      if (r) {
        const p = v3(origin.x + dir.x * r[0], origin.y + dir.y * r[0], origin.z + dir.z * r[0]);
        hits.push({ t: r[0], tExit: r[1], point: p, normal: faceNormal(s.box, p, dir), solid: s, surface: s.surface });
      }
    });
    if (this.groundY !== null && dir.y < -1e-9 && origin.y > this.groundY) {
      const t = (this.groundY - origin.y) / dir.y;
      if (t <= maxDist) hits.push({ t, tExit: t, point: v3(origin.x + dir.x * t, this.groundY, origin.z + dir.z * t), normal: v3(0, 1, 0), solid: null, surface: 'ground' });
    }
    hits.sort((a, b) => a.t - b.t);
    return hits;
  }

  /** Visit solids in grid cells along the ray's XZ projection (2D DDA), each at most once. */
  private walkRay(origin: Vec3, dir: Vec3, maxDist: number, visit: (s: Solid) => void): void {
    const st = ++this.stamp;
    const visitCell = (ci: number) => {
      for (const id of this.cells[ci]) { if (this.stamps[id] !== st) { this.stamps[id] = st; visit(this.solids[id]); } }
    };
    const b = this.bounds;
    // Clip the ray to the grid bounds in XZ (extended by one cell) so we don't walk forever.
    const gridBox: Aabb = { min: v3(b.min.x - this.cellSize, -1e9, b.min.z - this.cellSize), max: v3(b.min.x + this.cols * this.cellSize, 1e9, b.min.z + this.rows * this.cellSize) };
    const r = rayAabbRange(origin, dir, gridBox, maxDist);
    if (!r) return;
    const tStart = r[0], tEnd = r[1];
    let x = origin.x + dir.x * tStart, z = origin.z + dir.z * tStart;
    let [cx, cz] = this.cellCoord(x, z);
    const stepX = dir.x > 0 ? 1 : dir.x < 0 ? -1 : 0;
    const stepZ = dir.z > 0 ? 1 : dir.z < 0 ? -1 : 0;
    const tDeltaX = stepX !== 0 ? this.cellSize / Math.abs(dir.x) : Infinity;
    const tDeltaZ = stepZ !== 0 ? this.cellSize / Math.abs(dir.z) : Infinity;
    const nextBoundaryX = this.bounds.min.x + (cx + (stepX > 0 ? 1 : 0)) * this.cellSize;
    const nextBoundaryZ = this.bounds.min.z + (cz + (stepZ > 0 ? 1 : 0)) * this.cellSize;
    let tMaxX = stepX !== 0 ? tStart + (nextBoundaryX - x) / dir.x : Infinity;
    let tMaxZ = stepZ !== 0 ? tStart + (nextBoundaryZ - z) / dir.z : Infinity;
    let guard = this.cols + this.rows + 2;
    while (guard-- > 0) {
      visitCell(this.cellIndex(cx, cz));
      if (tMaxX < tMaxZ) {
        if (tMaxX > tEnd) break;
        cx += stepX; tMaxX += tDeltaX;
        if (cx < 0 || cx >= this.cols) break;
      } else {
        if (tMaxZ > tEnd) break;
        cz += stepZ; tMaxZ += tDeltaZ;
        if (cz < 0 || cz >= this.rows) break;
      }
    }
  }

  /** Line of sight test: true if nothing blocks the segment a→b (ground plane and solids). */
  lineOfSight(a: Vec3, b: Vec3, filter?: (s: Solid) => boolean): boolean {
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    const d = Math.hypot(dx, dy, dz);
    if (d < 1e-6) return true;
    const dir = v3(dx / d, dy / d, dz / d);
    const hit = this.raycast(a, dir, d - 1e-3, filter);
    return hit === null;
  }

  /**
   * Move an AABB body by vel*dt with axis-separated sweeps, step-up and ground snapping.
   * `pos` is the feet centre. Gravity must already be applied to vel by the caller.
   */
  moveBody(pos: Vec3, vel: Vec3, dt: number, shape: BodyShape, opts: { wasGrounded?: boolean; snapDown?: boolean } = {}): MoveResult {
    const hw = shape.halfWidth, h = shape.height;
    const p = v3copy(pos); const v = v3copy(vel);
    let hitWall = false, hitCeiling = false, steppedUp = false, grounded = false;
    let groundSurface: SurfaceId = 'ground';
    const box: Aabb = { min: v3(), max: v3() };
    const setBox = (x: number, y: number, z: number) => { box.min.x = x - hw; box.min.y = y; box.min.z = z - hw; box.max.x = x + hw; box.max.y = y + h; box.max.z = z + hw; };
    const tmp: Solid[] = [];

    // Horizontal axes
    const moveAxis = (axis: 'x' | 'z', amount: number): number => {
      if (amount === 0) return 0;
      setBox(p.x, p.y, p.z);
      const swept: Aabb = { min: v3copy(box.min), max: v3copy(box.max) };
      if (amount > 0) swept.max[axis] += amount; else swept.min[axis] += amount;
      this.query(swept, tmp);
      let allowed = amount;
      for (const s of tmp) {
        const sb = s.box;
        // must overlap on the other two axes to block
        if (!(sb.max.y > box.min.y + SKIN && sb.min.y < box.max.y - SKIN)) continue;
        const other = axis === 'x' ? 'z' : 'x';
        if (!(sb.max[other] > box.min[other] + SKIN && sb.min[other] < box.max[other] - SKIN)) continue;
        if (amount > 0) {
          const gap = sb.min[axis] - box.max[axis];
          if (gap >= -SKIN && gap < allowed) allowed = Math.max(0, gap - SKIN);
        } else {
          const gap = sb.max[axis] - box.min[axis];
          if (gap <= SKIN && gap > allowed) allowed = Math.min(0, gap + SKIN);
        }
      }
      return allowed;
    };

    /** Try to climb a step: returns the horizontal distance moved at the lifted height, or null if not a real step. */
    const tryStepUp = (axis: 'x' | 'z', amount: number, groundAllowed: number): number | null => {
      if (!(opts.wasGrounded ?? true) || shape.stepHeight <= 0) return null;
      const lifted = p.y + shape.stepHeight;
      setBox(p.x, lifted, p.z);
      if (this.overlaps(box)) return null;
      const save = p.y; p.y = lifted;
      const moved = moveAxis(axis, amount);
      // Must get meaningfully farther than at ground level, and land on something higher than before.
      if (Math.abs(moved) <= Math.abs(groundAllowed) + 1e-6) { p.y = save; return null; }
      p[axis] += moved;
      const floor = this.floorHeightAt(p.x, p.z, p.y, hw);
      if (floor <= save + 1e-6 || floor > lifted + SKIN) { p[axis] -= moved; p.y = save; return null; }
      p.y = floor;
      return moved;
    };

    for (const axis of ['x', 'z'] as const) {
      const want = v[axis] * dt;
      if (want === 0) continue;
      const allowed = moveAxis(axis, want);
      if (Math.abs(allowed) < Math.abs(want) - 1e-6) {
        const stepped = tryStepUp(axis, want, allowed);
        if (stepped !== null) {
          steppedUp = true;
          if (Math.abs(stepped) < Math.abs(want) - 1e-6) { hitWall = true; v[axis] = 0; }
          continue;
        }
        hitWall = true;
        p[axis] += allowed;
        v[axis] = 0;
      } else {
        p[axis] += allowed;
      }
    }

    // Vertical
    const wantY = v.y * dt;
    setBox(p.x, p.y, p.z);
    if (wantY !== 0) {
      const swept: Aabb = { min: v3copy(box.min), max: v3copy(box.max) };
      if (wantY > 0) swept.max.y += wantY; else swept.min.y += wantY;
      this.query(swept, tmp);
      let allowed = wantY;
      let surf: SurfaceId = 'ground';
      for (const s of tmp) {
        const sb = s.box;
        if (!(sb.max.x > box.min.x + SKIN && sb.min.x < box.max.x - SKIN && sb.max.z > box.min.z + SKIN && sb.min.z < box.max.z - SKIN)) continue;
        if (wantY > 0) {
          const gap = sb.min.y - box.max.y;
          if (gap >= -SKIN && gap < allowed) { allowed = Math.max(0, gap - SKIN); hitCeiling = true; }
        } else {
          const gap = sb.max.y - box.min.y;
          if (gap <= SKIN && gap > allowed) { allowed = Math.min(0, gap + SKIN); grounded = true; surf = s.surface; }
        }
      }
      if (wantY < 0 && this.groundY !== null) {
        const gap = this.groundY - p.y;
        if (gap > allowed) { allowed = Math.min(0, gap); grounded = true; surf = 'ground'; }
      }
      p.y += allowed;
      if (grounded) { p.y = this.floorHeightAt(p.x, p.z, p.y + SKIN * 2, hw); groundSurface = surf; }
      if (Math.abs(allowed) < Math.abs(wantY) - 1e-9) v.y = 0;
    }

    // Ground snapping when walking off a step (keeps bots/players on stairs, no micro-hops)
    if (!grounded && v.y <= 0 && (opts.snapDown ?? true) && (opts.wasGrounded ?? false)) {
      const floor = this.floorHeightAt(p.x, p.z, p.y, hw);
      if (floor > -Infinity && p.y - floor <= shape.stepHeight + SKIN) {
        p.y = floor; grounded = true; v.y = 0;
        groundSurface = this.surfaceAt(p.x, p.z, floor, hw);
      }
    } else if (!grounded && v.y === 0) {
      // Standing still exactly on a surface
      const floor = this.floorHeightAt(p.x, p.z, p.y, hw);
      if (Math.abs(p.y - floor) <= SKIN * 4) { p.y = floor; grounded = true; groundSurface = this.surfaceAt(p.x, p.z, floor, hw); }
    }

    return { pos: p, vel: v, grounded, hitWall, hitCeiling, steppedUp, groundSurface };
  }

  /** Surface id of the solid whose top is at height y under (x,z); 'ground' for the plane. */
  surfaceAt(x: number, z: number, y: number, halfWidth = 0): SurfaceId {
    const q: Aabb = { min: v3(x - halfWidth, y - 0.01, z - halfWidth), max: v3(x + halfWidth, y + 0.01, z + halfWidth) };
    const st = ++this.stamp;
    let surf: SurfaceId = 'ground';
    this.forCells(q, (ci) => {
      for (const id of this.cells[ci]) {
        if (this.stamps[id] === st) continue;
        this.stamps[id] = st;
        const b = this.solids[id].box;
        if (Math.abs(b.max.y - y) <= 0.01 && b.max.x > q.min.x && b.min.x < q.max.x && b.max.z > q.min.z && b.min.z < q.max.z) surf = this.solids[id].surface;
      }
    });
    return surf;
  }
}

/** Outward face normal of the box face containing p, biased against the ray direction. */
function faceNormal(box: Aabb, p: Vec3, dir: Vec3): Vec3 {
  const dxMin = Math.abs(p.x - box.min.x), dxMax = Math.abs(p.x - box.max.x);
  const dyMin = Math.abs(p.y - box.min.y), dyMax = Math.abs(p.y - box.max.y);
  const dzMin = Math.abs(p.z - box.min.z), dzMax = Math.abs(p.z - box.max.z);
  const m = Math.min(dxMin, dxMax, dyMin, dyMax, dzMin, dzMax);
  if (m === dxMin) return v3(-1, 0, 0);
  if (m === dxMax) return v3(1, 0, 0);
  if (m === dyMin) return v3(0, -1, 0);
  if (m === dyMax) return v3(0, 1, 0);
  if (m === dzMin) return v3(0, 0, -1);
  if (m === dzMax) return v3(0, 0, 1);
  return v3(-Math.sign(dir.x), 0, 0);
}
