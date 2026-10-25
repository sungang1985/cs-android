/**
 * Grenade throw preview dots (§4.4: SnapLocal.throwHoldT ≥ 0): ballistic arc from the eye at aim pitch + 10°,
 * 12 m/s (tap) or 7 m/s (held ≥ 0.3 s), gravity 20 m/s², stopped at the first solid (ray vs map AABBs) or floor.
 */
import { BufferGeometry, BufferAttribute, Points, PointsMaterial, DynamicDrawUsage, type Texture } from 'three';
import { rayAabb, DEG, type Vec3, type Aabb } from '../../core/math';
import { GRENADE } from '../../weapons/defs';

const N = 28, STEP = 0.045;

export class ThrowPreview {
  readonly points: Points;
  private readonly pos = new Float32Array(N * 3);
  private boxes: Aabb[] = [];
  constructor(map: Texture) {
    const g = new BufferGeometry(); g.setAttribute('position', new BufferAttribute(this.pos, 3).setUsage(DynamicDrawUsage));
    this.points = new Points(g, new PointsMaterial({ size: 0.07, map, color: '#ffd54f', transparent: true, depthWrite: false, sizeAttenuation: true }));
    this.points.frustumCulled = false; this.points.visible = false; this.points.name = 'throw-preview';
  }
  setSolids(boxes: Aabb[]): void { this.boxes = boxes; }
  update(eye: Vec3, yaw: number, pitch: number, holdT: number, floorY: (x: number, z: number) => number): void {
    if (holdT < 0) { this.points.visible = false; return; }
    const speed = holdT * 60 >= GRENADE.shortHoldTicks ? GRENADE.shortSpeed : GRENADE.speed;
    const p = Math.min(89 * DEG, pitch + GRENADE.pitchUp * DEG), cp = Math.cos(p);
    let x = eye.x, y = eye.y, z = eye.z, vx = -Math.sin(yaw) * cp * speed, vy = Math.sin(p) * speed, vz = -Math.cos(yaw) * cp * speed;
    let n = 0, stopped = false;
    const o = { x: 0, y: 0, z: 0 }, d = { x: 0, y: 0, z: 0 };
    for (let i = 0; i < N * 3 && n < N && !stopped; i++) {
      const nx = x + vx * STEP, ny = y + vy * STEP - 0.5 * GRENADE.gravity * STEP * STEP, nz = z + vz * STEP;
      vy -= GRENADE.gravity * STEP;
      o.x = x; o.y = y; o.z = z; d.x = nx - x; d.y = ny - y; d.z = nz - z;
      const len = Math.hypot(d.x, d.y, d.z); d.x /= len; d.y /= len; d.z /= len;
      let t = len;
      for (const b of this.boxes) { const h = rayAabb(o, d, b, t); if (h !== null && h < t) { t = h; stopped = true; } }
      x = o.x + d.x * t; y = o.y + d.y * t; z = o.z + d.z * t;
      const f = floorY(x, z); if (y <= f) { y = f + 0.02; stopped = true; }
      if (i % 3 === 2 || stopped) { this.pos[n * 3] = x; this.pos[n * 3 + 1] = y; this.pos[n * 3 + 2] = z; n++; }
    }
    for (let i = n; i < N; i++) { this.pos[i * 3] = x; this.pos[i * 3 + 1] = -1000; this.pos[i * 3 + 2] = z; }
    this.points.geometry.getAttribute('position').needsUpdate = true;
    this.points.visible = n > 0;
  }
  dispose(): void { this.points.geometry.dispose(); (this.points.material as PointsMaterial).dispose(); }
}
