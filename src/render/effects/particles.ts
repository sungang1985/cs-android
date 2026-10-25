/**
 * CPU particle pools as one `Points` each (§10.5): impacts by surface (dust / splinters / sparks / sand),
 * blood, flash bursts, explosion smoke. Ring buffer, per-particle RGBA vertex colour (alpha fades with life).
 */
import { BufferGeometry, BufferAttribute, Points, PointsMaterial, AdditiveBlending, NormalBlending, DynamicDrawUsage, type Texture } from 'three';
import type { Rng } from '../../core/rng';
import type { SurfaceId } from '../../sim/state';
import type { Vec3 } from '../../core/math';

export class ParticlePool {
  readonly points: Points;
  private readonly pos: Float32Array; private readonly col: Float32Array; private readonly vel: Float32Array;
  private readonly life: Float32Array; private readonly max: Float32Array; private readonly grav: Float32Array; private readonly alpha0: Float32Array; private readonly drag: Float32Array;
  private head = 0; private alive = 0;
  constructor(readonly cap: number, size: number, map: Texture, additive: boolean, name: string) {
    const g = new BufferGeometry();
    this.pos = new Float32Array(cap * 3).fill(-1000); this.col = new Float32Array(cap * 4);
    this.vel = new Float32Array(cap * 3); this.life = new Float32Array(cap); this.max = new Float32Array(cap).fill(1); this.grav = new Float32Array(cap); this.alpha0 = new Float32Array(cap); this.drag = new Float32Array(cap);
    g.setAttribute('position', new BufferAttribute(this.pos, 3).setUsage(DynamicDrawUsage));
    g.setAttribute('color', new BufferAttribute(this.col, 4).setUsage(DynamicDrawUsage));
    const m = new PointsMaterial({ size, map, vertexColors: true, transparent: true, depthWrite: false, sizeAttenuation: true, blending: additive ? AdditiveBlending : NormalBlending });
    this.points = new Points(g, m); this.points.frustumCulled = false; this.points.name = name; this.points.visible = false;
  }
  emit(p: Vec3, vx: number, vy: number, vz: number, r: number, g: number, b: number, life: number, gravity: number, alpha = 1, drag = 0): void {
    const i = this.head; this.head = (this.head + 1) % this.cap;
    this.pos[i * 3] = p.x; this.pos[i * 3 + 1] = p.y; this.pos[i * 3 + 2] = p.z;
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
    this.col[i * 4] = r; this.col[i * 4 + 1] = g; this.col[i * 4 + 2] = b; this.col[i * 4 + 3] = alpha;
    this.life[i] = life; this.max[i] = life; this.grav[i] = gravity; this.alpha0[i] = alpha; this.drag[i] = drag;
    this.alive = this.cap;
  }
  update(dt: number): void {
    if (this.alive === 0) { this.points.visible = false; return; }
    let any = 0;
    for (let i = 0; i < this.cap; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      if (this.life[i] <= 0) { this.col[i * 4 + 3] = 0; this.pos[i * 3 + 1] = -1000; continue; }
      any++;
      const k = i * 3, dr = Math.exp(-this.drag[i] * dt);
      this.vel[k] *= dr; this.vel[k + 2] *= dr; this.vel[k + 1] = this.vel[k + 1] * dr - this.grav[i] * dt;
      this.pos[k] += this.vel[k] * dt; this.pos[k + 1] += this.vel[k + 1] * dt; this.pos[k + 2] += this.vel[k + 2] * dt;
      this.col[i * 4 + 3] = this.alpha0[i] * Math.min(1, (this.life[i] / this.max[i]) * 1.5);
    }
    const g = this.points.geometry;
    g.getAttribute('position').needsUpdate = true; g.getAttribute('color').needsUpdate = true;
    this.alive = any; this.points.visible = any > 0;
  }
  clear(): void { this.life.fill(0); this.pos.fill(-1000); this.col.fill(0); this.alive = 0; this.points.visible = false; }
  dispose(): void { this.points.geometry.dispose(); (this.points.material as PointsMaterial).dispose(); }
}

/** Surface → impact particle recipe (count, colour, speed, gravity). */
const IMPACT: Record<SurfaceId, { n: number; c: [number, number, number]; speed: number; grav: number; life: number; spark?: boolean }> = {
  concrete: { n: 8, c: [0.62, 0.62, 0.6], speed: 2.2, grav: 4, life: 0.4 },
  wood: { n: 8, c: [0.55, 0.38, 0.2], speed: 3, grav: 9, life: 0.4 },
  metal: { n: 6, c: [1, 0.78, 0.35], speed: 5, grav: 14, life: 0.4, spark: true },
  sand: { n: 8, c: [0.62, 0.56, 0.38], speed: 2, grav: 8, life: 0.4 },
};

/** Spawns surface impact particles around `p` biased along the normal. */
export function emitImpact(pool: ParticlePool, sparks: ParticlePool, rng: Rng, p: Vec3, n: Vec3, surface: SurfaceId): void {
  const r = IMPACT[surface];
  const target = r.spark ? sparks : pool;
  for (let i = 0; i < r.n; i++) {
    const s = r.speed * rng.range(0.4, 1);
    const vx = n.x * s + rng.range(-1, 1) * s * 0.6, vy = n.y * s + rng.range(-0.2, 1) * s * 0.6, vz = n.z * s + rng.range(-1, 1) * s * 0.6;
    const shade = rng.range(0.8, 1.1);
    target.emit(p, vx, vy, vz, r.c[0] * shade, r.c[1] * shade, r.c[2] * shade, r.life * rng.range(0.7, 1.1), r.grav, 0.9, r.spark ? 0 : 3);
  }
}

export function emitBlood(pool: ParticlePool, rng: Rng, p: Vec3, dir: Vec3): void {
  for (let i = 0; i < 10; i++) {
    const s = rng.range(0.8, 2.5);
    pool.emit(p, dir.x * s + rng.range(-0.8, 0.8), dir.y * s + rng.range(-0.3, 1.2), dir.z * s + rng.range(-0.8, 0.8), rng.range(0.45, 0.62), 0.03, 0.03, rng.range(0.3, 0.5), 9, 1, 1);
  }
}
