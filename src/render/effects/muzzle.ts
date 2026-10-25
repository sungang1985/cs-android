/**
 * Muzzle flashes (§10.5): 2 crossed additive quads (+ a front star) along the barrel, random roll,
 * scale 0.12–0.25 m, visible 2 frames. World flashes are instanced; the human's flash lives in the
 * viewmodel scene at the viewmodel muzzle (see viewmodel.ts).
 */
import { PlaneGeometry, Matrix4, Quaternion, Vector3, type BufferGeometry, type Material } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { InstBatch } from '../models/batch';
import type { Rng } from '../../core/rng';
import type { Vec3 } from '../../core/math';

/** Two quads crossing along +z (the barrel axis) and one star facing +z; centred slightly ahead of the muzzle. */
export function flashGeometry(): BufferGeometry {
  const a = new PlaneGeometry(0.6, 1); a.rotateX(Math.PI / 2); a.rotateY(0); a.translate(0, 0, -0.4);
  const b = new PlaneGeometry(0.6, 1); b.rotateX(Math.PI / 2); b.rotateZ(Math.PI / 2); b.translate(0, 0, -0.4);
  const c = new PlaneGeometry(0.8, 0.8);
  const g = mergeGeometries([a, b, c], false)!;
  a.dispose(); b.dispose(); c.dispose();
  return g;
}

interface Flash { p: Vector3; q: Quaternion; s: number; frames: number }
const _m = new Matrix4(), _r = new Quaternion(), _s = new Vector3(), Z = new Vector3(0, 0, 1), _d = new Vector3();

export class MuzzleFlashes {
  readonly batch: InstBatch;
  private readonly list: Flash[] = Array.from({ length: 16 }, () => ({ p: new Vector3(), q: new Quaternion(), s: 0, frames: 0 }));
  private head = 0;
  constructor(mat: Material) { this.batch = new InstBatch(flashGeometry(), mat, 16, false, 'muzzle'); }
  /** dir = barrel direction (forward); the geometry's −z extends along it. */
  add(p: Vec3, dir: Vec3, rng: Rng): void {
    const f = this.list[this.head]; this.head = (this.head + 1) % this.list.length;
    f.p.set(p.x, p.y, p.z);
    f.q.setFromUnitVectors(Z, _d.set(-dir.x, -dir.y, -dir.z).normalize()).multiply(_r.setFromAxisAngle(Z, rng.range(0, Math.PI * 2)));
    f.s = rng.range(0.12, 0.25); f.frames = 2;
  }
  /** Called once per rendered frame: each flash is visible for 2 frames. */
  update(): void {
    const b = this.batch; b.begin();
    for (const f of this.list) if (f.frames > 0) { f.frames--; b.push(_m.compose(f.p, f.q, _s.set(f.s, f.s, f.s))); }
    b.end();
  }
  clear(): void { for (const f of this.list) f.frames = 0; }
  dispose(): void { this.batch.dispose(); }
}
