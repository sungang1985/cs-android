/**
 * AudioEngine (§9.3). DAY-0 STUB = SilentAudio with the full interface: unlocks an AudioContext (so the real
 * engine can slot in) and plays nothing. L7 implements the bank, spatialisation and buses.
 */
import type { Vec3 } from '../core/math';
import type { SimEnvelope } from '../sim/events';
import type { SnapLocal } from '../sim/state';
import type { StaticWorld } from '../world/collision';

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private volumes = { master: 80, sfx: 100, ui: 70 };
  async unlock(): Promise<void> {
    if (typeof AudioContext === 'undefined') return;
    if (!this.ctx) this.ctx = new AudioContext({ latencyHint: 'interactive' });
    try { await this.ctx.resume(); } catch { /* ignore */ }
  }
  get unlocked(): boolean { return this.ctx?.state === 'running'; }
  suspend(): void { void this.ctx?.suspend(); }
  resume(): void { void this.ctx?.resume(); }
  handle(e: SimEnvelope, local: SnapLocal): void { void e; void local; }
  setListener(p: { pos: Vec3; fwd: Vec3; up: Vec3 }): void { void p; }
  setWorld(world: StaticWorld): void { void world; }
  setVolumes(v: { master: number; sfx: number; ui: number }): void { this.volumes = { ...v }; }
  getVolumes(): { master: number; sfx: number; ui: number } { return this.volumes; }
  ui(id: 'tap' | 'back' | 'buy' | 'denied'): void { void id; }
  startAmbient(): void {}
  stopAmbient(): void {}
}
