/**
 * Instanced batch: one InstancedMesh (one draw call) refilled every frame. Characters, weapons, items, grenades,
 * targets and decals are all drawn through batches so 10 players cost a handful of draw calls (§10.3 budget).
 */
import { InstancedMesh, InstancedBufferAttribute, DynamicDrawUsage, Color, Matrix4, type BufferGeometry, type Material } from 'three';

export class InstBatch {
  readonly mesh: InstancedMesh;
  n = 0;
  private readonly colors: boolean;
  constructor(geo: BufferGeometry, mat: Material, readonly cap: number, colors = false, name = 'batch') {
    this.mesh = new InstancedMesh(geo, mat, cap);
    this.mesh.name = name;
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.colors = colors;
    if (colors) { this.mesh.instanceColor = new InstancedBufferAttribute(new Float32Array(cap * 3).fill(1), 3); this.mesh.instanceColor.setUsage(DynamicDrawUsage); }
    this.mesh.count = 0; this.mesh.visible = false;
  }
  begin(): void { this.n = 0; }
  push(m: Matrix4, c?: Color): number {
    if (this.n >= this.cap) return -1;
    const i = this.n++;
    this.mesh.setMatrixAt(i, m);
    if (this.colors) this.mesh.setColorAt(i, c ?? WHITE);
    return i;
  }
  end(): void {
    const m = this.mesh;
    m.count = this.n; m.visible = this.n > 0;
    if (this.n > 0) {
      m.instanceMatrix.clearUpdateRanges(); m.instanceMatrix.addUpdateRange(0, this.n * 16); m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) { m.instanceColor.clearUpdateRanges(); m.instanceColor.addUpdateRange(0, this.n * 3); m.instanceColor.needsUpdate = true; }
    }
  }
  dispose(): void { this.mesh.geometry.dispose(); this.mesh.dispose(); }
}

const WHITE = new Color(1, 1, 1);

/** Scratch helpers (allocation-free composition of TRS matrices). */
export const tmpM = new Matrix4();
