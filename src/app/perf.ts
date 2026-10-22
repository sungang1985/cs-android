/** Rolling 5 s performance histograms (globalThis.__cs.perf) and Auto quality stepping (§10.3, §12.3). */
import type { QualityPreset } from '../settings/types';

export interface PerfStats { frameMs: { avg: number; p95: number }; simMs: { avg: number; p95: number }; botMs: { avg: number; p95: number }; renderMs: { avg: number; p95: number }; drawCalls: number; triangles: number; heapMB: number; fps: number; quality: QualityPreset }

class Series {
  private buf: number[] = [];
  push(v: number): void { this.buf.push(v); if (this.buf.length > 300) this.buf.shift(); }
  stats(): { avg: number; p95: number } {
    if (!this.buf.length) return { avg: 0, p95: 0 };
    const s = [...this.buf].sort((a, b) => a - b);
    return { avg: s.reduce((a, b) => a + b, 0) / s.length, p95: s[Math.min(s.length - 1, Math.floor(s.length * 0.95))] };
  }
  get size(): number { return this.buf.length; }
}

export class Perf {
  private frame = new Series(); private sim = new Series(); private bot = new Series(); private render = new Series();
  drawCalls = 0; triangles = 0; quality: QualityPreset = 'medium';
  private hotSince = 0; private coolSince = 0; private t = 0;
  /** Auto stepping callback: receives the new effective preset. */
  onQualityStep: ((q: 'low' | 'medium' | 'high') => void) | null = null;
  auto = true;
  effective: 'low' | 'medium' | 'high' = 'medium';
  sample(frameMs: number, simMs: number, renderMs: number, botMs = 0): void {
    this.frame.push(frameMs); this.sim.push(simMs); this.render.push(renderMs); this.bot.push(botMs);
    this.t += frameMs;
    if (!this.auto || this.frame.size < 60) return;
    const p95 = this.frame.stats().p95;
    if (p95 > 18) { this.coolSince = this.t; if (this.hotSince === 0) this.hotSince = this.t; else if (this.t - this.hotSince > 5000) { this.hotSince = 0; this.step(-1); } }
    else { this.hotSince = 0; if (p95 < 12) { if (this.coolSince === 0) this.coolSince = this.t; else if (this.t - this.coolSince > 30000) { this.coolSince = 0; this.step(1); } } else this.coolSince = this.t; }
  }
  private step(dir: 1 | -1): void {
    const order: Array<'low' | 'medium' | 'high'> = ['low', 'medium', 'high'];
    const i = order.indexOf(this.effective) + dir;
    if (i < 0 || i >= order.length) return;
    if (dir > 0 && order[i] === 'high') return; // max Medium on auto
    this.effective = order[i]; this.onQualityStep?.(this.effective);
  }
  stats(fps: number): PerfStats {
    const mem = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
    return { frameMs: this.frame.stats(), simMs: this.sim.stats(), botMs: this.bot.stats(), renderMs: this.render.stats(), drawCalls: this.drawCalls, triangles: this.triangles, heapMB: mem ? mem.usedJSHeapSize / 1048576 : 0, fps, quality: this.quality };
  }
}
