/**
 * Decals (§10.5): bullet holes and blood splats as InstancedMesh quads oriented to the surface normal,
 * offset 1 mm (+ polygon offset), written into a ring buffer sized by the quality preset.
 */
import { PlaneGeometry, Matrix4, Quaternion, Vector3, type Material } from 'three';
import { InstBatch } from '../models/batch';
import type { Vec3 } from '../../core/math';

const _m = new Matrix4(), _q = new Quaternion(), _r = new Quaternion(), _p = new Vector3(), _s = new Vector3(), _n = new Vector3(), Z = new Vector3(0, 0, 1);

export class DecalRing {
  readonly batch: InstBatch;
  private head = 0; private count = 0;
  constructor(readonly cap: number, mat: Material, name: string) {
    this.batch = new InstBatch(new PlaneGeometry(1, 1), mat, Math.max(1, cap), false, name);
  }
  add(p: Vec3, n: Vec3, size: number, roll: number): void {
    _n.set(n.x, n.y, n.z); if (_n.lengthSq() < 1e-6) _n.set(0, 1, 0); _n.normalize();
    _q.setFromUnitVectors(Z, _n).multiply(_r.setFromAxisAngle(Z, roll));
    _p.set(p.x + _n.x * 0.001, p.y + _n.y * 0.001, p.z + _n.z * 0.001);
    const i = this.head; this.head = (this.head + 1) % this.batch.cap; this.count = Math.min(this.batch.cap, this.count + 1);
    this.batch.mesh.setMatrixAt(i, _m.compose(_p, _q, _s.set(size, size, 1)));
    const m = this.batch.mesh;
    m.count = this.count; m.visible = true; m.instanceMatrix.clearUpdateRanges(); m.instanceMatrix.needsUpdate = true;
  }
  clear(): void { this.head = 0; this.count = 0; this.batch.mesh.count = 0; this.batch.mesh.visible = false; }
  get size(): number { return this.count; }
  dispose(): void { this.batch.dispose(); }
}
