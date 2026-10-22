/**
 * GameRenderer (§11.8). DAY-0 STUB = NullRenderer: acquires a WebGL2 context, clears to the background colour,
 * tracks nothing. L6 replaces the body with the Three.js renderer behind the same interface.
 */
import type { Vec3 } from '../core/math';
import { v3, dirFromYawPitch } from '../core/math';
import type { CompiledMap } from '../world/types';
import type { RenderSnapshot, LookPreview } from '../sim/state';
import type { SimEnvelope } from '../sim/events';
import type { QualityPreset } from '../settings/types';

export interface RendererStats { drawCalls: number; triangles: number; frameMs: number }

export class GameRenderer {
  readonly stats: RendererStats = { drawCalls: 0, triangles: 0, frameMs: 0 };
  private gl: WebGL2RenderingContext | null;
  private quality: QualityPreset;
  private fov: number;
  private pose = { pos: v3(0, 1.65, 0), fwd: v3(0, 0, -1), up: v3(0, 1, 0) };
  private map: CompiledMap | null = null;

  constructor(private readonly canvas: HTMLCanvasElement, opts: { quality: QualityPreset; fov: number }) {
    this.quality = opts.quality; this.fov = opts.fov;
    this.gl = canvas.getContext('webgl2', { antialias: false, powerPreference: 'high-performance' });
  }
  get webgl2(): boolean { return this.gl !== null; }
  loadMap(map: CompiledMap): void { this.map = map; }
  render(prev: RenderSnapshot, next: RenderSnapshot, alpha: number, preview: LookPreview, frameDt: number): void {
    void prev; void alpha; void frameDt;
    const t0 = performance.now();
    const gl = this.gl;
    if (gl) { gl.viewport(0, 0, this.canvas.width, this.canvas.height); gl.clearColor(0.11, 0.118, 0.133, 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT); }
    const l = next.local;
    this.pose.pos.x = l.eyeX; this.pose.pos.y = l.eyeY; this.pose.pos.z = l.eyeZ;
    dirFromYawPitch(preview.yaw + 0.5 * l.aimOffsetYaw, preview.pitch + 0.5 * l.aimOffsetPitch, this.pose.fwd);
    this.stats.drawCalls = 0; this.stats.triangles = 0; this.stats.frameMs = performance.now() - t0;
  }
  handleEvent(e: SimEnvelope): void { void e; }
  setQuality(q: QualityPreset): void { this.quality = q; }
  getQuality(): QualityPreset { return this.quality; }
  setFov(deg: number): void { this.fov = deg; }
  getFov(): number { return this.fov; }
  resize(w: number, h: number, dpr: number): void { this.canvas.width = Math.round(w * dpr); this.canvas.height = Math.round(h * dpr); }
  dispose(): void { this.map = null; }
  cameraPose(): { pos: Vec3; fwd: Vec3; up: Vec3 } { return this.pose; }
  menuScene(on: boolean): void { void on; }
  setMarker(pos: Vec3 | null): void { void pos; }
}
