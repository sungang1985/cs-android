/**
 * Tracers (§10.5): one InstancedMesh of thin additive boxes (0.02 × 0.02 × ≤ 1.5 m, yellow-white, alpha 0.6)
 * travelling at 300 m/s, ≤ 120 ms each.
 */
import { BoxGeometry, Matrix4, Quaternion, Vector3, type Material } from 'three';
import { InstBatch } from '../models/batch';
import type { Vec3 } from '../../core/math';

interface Tracer { sx: number; sy: number; sz: number; dx: number; dy: number; dz: number; dist: number; age: number; ttl: number; on: boolean }
const SPEED = 300, LEN = 1.5, MAX_T = 0.12;
const _m = new Matrix4(), _q = new Quaternion(), _p = new Vector3(), _s = new Vector3(), _d = new Vector3(), Z = new Vector3(0, 0, 1);

export class Tracers {
  readonly batch: InstBatch;
  private readonly pool: Tracer[];
  private head = 0;
  constructor(cap: number, mat: Material) {
    this.batch = new InstBatch(new BoxGeometry(0.02, 0.02, 1), mat, cap, false, 'tracers');
    this.pool = Array.from({ length: cap }, () => ({ sx: 0, sy: 0, sz: 0, dx: 0, dy: 0, dz: 1, dist: 0, age: 0, ttl: 0, on: false }));
  }
  add(from: Vec3, to: Vec3): void {
    const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z, dist = Math.hypot(dx, dy, dz);
    if (dist < 0.5) return;
    const t = this.pool[this.head]; this.head = (this.head + 1) % this.pool.length;
    t.sx = from.x; t.sy = from.y; t.sz = from.z; t.dx = dx / dist; t.dy = dy / dist; t.dz = dz / dist; t.dist = dist;
    t.age = 0; t.ttl = Math.min(MAX_T, dist / SPEED + 1 / 60); t.on = true;
  }
  update(dt: number): void {
    const b = this.batch; b.begin();
    for (const t of this.pool) {
      if (!t.on) continue;
      t.age += dt;
      if (t.age > t.ttl) { t.on = false; continue; }
      const headD = Math.min(t.dist, SPEED * t.age), tailD = Math.max(0, headD - LEN), len = headD - tailD;
      if (len < 0.05) continue;
      const mid = (headD + tailD) / 2;
      _p.set(t.sx + t.dx * mid, t.sy + t.dy * mid, t.sz + t.dz * mid);
      _q.setFromUnitVectors(Z, _d.set(t.dx, t.dy, t.dz));
      b.push(_m.compose(_p, _q, _s.set(1, 1, len)));
    }
    b.end();
  }
  clear(): void { for (const t of this.pool) t.on = false; this.batch.begin(); this.batch.end(); }
  dispose(): void { this.batch.dispose(); }
}
