/**
 * Explosions (§10.5): additive sphere growing 0 → 3 m (HE) / 0 → 10 m (bomb) over 120 ms with alpha fade,
 * 40 grey smoke particles for 1.5 s; flashbang: small white burst + 12 bright particles. The bomb's 150 ms
 * white screen flash is a quad in the viewmodel scene (viewmodel.ts).
 */
import { SphereGeometry, Mesh, Group, MeshBasicMaterial, AdditiveBlending, type BufferGeometry } from 'three';
import type { Rng } from '../../core/rng';
import type { Vec3 } from '../../core/math';
import type { ParticlePool } from './particles';

interface Boom { mesh: Mesh; mat: MeshBasicMaterial; t: number; dur: number; r: number; on: boolean }

export class Explosions {
  readonly group = new Group();
  private readonly geo: BufferGeometry = new SphereGeometry(1, 16, 10);
  private readonly pool: Boom[] = [];
  constructor() {
    this.group.name = 'explosions';
    for (let i = 0; i < 3; i++) {
      const mat = new MeshBasicMaterial({ color: '#ffb347', transparent: true, opacity: 0, blending: AdditiveBlending, depthWrite: false, fog: false });
      const mesh = new Mesh(this.geo, mat); mesh.visible = false; mesh.frustumCulled = false; this.group.add(mesh);
      this.pool.push({ mesh, mat, t: 0, dur: 0.12, r: 3, on: false });
    }
  }
  private take(): Boom { const b = this.pool.find((p) => !p.on) ?? this.pool.reduce((a, c) => (a.t > c.t ? a : c)); return b; }
  /** kind: 'he' (3 m), 'bomb' (10 m), 'flash' (white 1.2 m, 80 ms). */
  add(kind: 'he' | 'bomb' | 'flash', p: Vec3, smoke: ParticlePool, bright: ParticlePool, rng: Rng): void {
    const b = this.take();
    b.on = true; b.t = 0; b.dur = kind === 'flash' ? 0.08 : 0.12; b.r = kind === 'bomb' ? 10 : kind === 'he' ? 3 : 1.2;
    b.mat.color.set(kind === 'flash' ? '#ffffff' : '#ffb347');
    b.mesh.position.set(p.x, p.y + 0.2, p.z); b.mesh.scale.setScalar(0.01); b.mesh.visible = true;
    if (kind === 'flash') {
      for (let i = 0; i < 12; i++) { const s = rng.range(2, 6), a = rng.range(0, Math.PI * 2), e = rng.range(-0.3, 1); bright.emit(p, Math.cos(a) * s, e * s, Math.sin(a) * s, 1, 1, 0.95, rng.range(0.25, 0.45), 2, 1, 2); }
      return;
    }
    const n = 40, spread = kind === 'bomb' ? 4 : 1.5;
    for (let i = 0; i < n; i++) {
      const a = rng.range(0, Math.PI * 2), r = rng.range(0, spread), up = rng.range(0.3, 1.6);
      const g = rng.range(0.28, 0.45);
      smoke.emit({ x: p.x + Math.cos(a) * r * 0.3, y: p.y + 0.3, z: p.z + Math.sin(a) * r * 0.3 }, Math.cos(a) * r, up, Math.sin(a) * r, g, g, g, rng.range(1.1, 1.5), -0.15, 0.7, 1.5);
    }
    for (let i = 0; i < 10; i++) { const s = rng.range(4, 9), a = rng.range(0, Math.PI * 2); bright.emit(p, Math.cos(a) * s, rng.range(1, 6), Math.sin(a) * s, 1, 0.7, 0.3, rng.range(0.3, 0.6), 12, 1, 0.5); }
  }
  update(dt: number): void {
    for (const b of this.pool) {
      if (!b.on) continue;
      b.t += dt;
      const u = Math.min(1, b.t / b.dur);
      b.mesh.scale.setScalar(Math.max(0.01, b.r * (1 - (1 - u) * (1 - u))));
      b.mat.opacity = 0.9 * (1 - u);
      if (u >= 1) { b.on = false; b.mesh.visible = false; }
    }
  }
  clear(): void { for (const b of this.pool) { b.on = false; b.mesh.visible = false; } }
  dispose(): void { this.geo.dispose(); for (const b of this.pool) b.mat.dispose(); }
}
