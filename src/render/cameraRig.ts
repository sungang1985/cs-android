/**
 * World camera (§10.4, §4.3): FOV from settings (vertical, default 75), near 0.1, far 120; orientation uses the
 * §0 yaw convention (rotation.y = yaw, rotation.x = pitch, order YXZ); hit / explosion shake; AWP zoom to
 * 20° / 10° over 0.15 s. Also the main-menu orbit.
 */
import { PerspectiveCamera, Vector3 } from 'three';
import { DEG, clamp, type Vec3 } from '../core/math';
import { Shake, approachFov } from './viewmodelMath';

export class CameraRig {
  readonly camera: PerspectiveCamera;
  baseFov: number;
  fov: number;
  readonly shake = new Shake();
  private readonly off = { yaw: 0, pitch: 0 };
  readonly pos = new Vector3(); readonly fwd = new Vector3(0, 0, -1); readonly up = new Vector3(0, 1, 0);

  constructor(fov: number) {
    this.baseFov = fov; this.fov = fov;
    this.camera = new PerspectiveCamera(fov, 1, 0.1, 120);
    this.camera.rotation.order = 'YXZ';
  }
  setAspect(a: number): void { this.camera.aspect = a; this.camera.updateProjectionMatrix(); }
  setFov(deg: number): void { this.baseFov = clamp(deg, 50, 110); }

  /** scoped: 0 none, 1 → 20°, 2 → 10°. */
  update(dt: number, eye: Vec3, yaw: number, pitch: number, scoped: number): void {
    const target = scoped === 2 ? 10 : scoped === 1 ? 20 : this.baseFov;
    const f = approachFov(this.fov, target, dt);
    if (f !== this.camera.fov) { this.fov = f; this.camera.fov = f; this.camera.updateProjectionMatrix(); }
    this.shake.sample(dt, this.off);
    const c = this.camera;
    c.position.set(eye.x, eye.y, eye.z);
    c.rotation.set(clamp(pitch + this.off.pitch, -89 * DEG, 89 * DEG), yaw + this.off.yaw, 0, 'YXZ');
    c.updateMatrixWorld();
    this.pos.copy(c.position); c.getWorldDirection(this.fwd); this.up.set(0, 1, 0).applyQuaternion(c.quaternion);
  }

  /** Point the camera at a target (menu orbit, death cam). */
  lookAt(eye: Vec3, target: Vec3, dt: number): void {
    const f = approachFov(this.fov, this.baseFov, dt);
    if (f !== this.camera.fov) { this.fov = f; this.camera.fov = f; this.camera.updateProjectionMatrix(); }
    const c = this.camera;
    c.position.set(eye.x, eye.y, eye.z); c.lookAt(target.x, target.y, target.z); c.updateMatrixWorld();
    this.pos.copy(c.position); c.getWorldDirection(this.fwd); this.up.set(0, 1, 0).applyQuaternion(c.quaternion);
  }

  get scopedIn(): boolean { return this.fov < this.baseFov - 1; }
}
