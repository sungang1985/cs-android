/** Spread / recoil / firing state machine. DAY-0 STUB: signatures binding (§11.8); L3 implements §4.2–4.4. */
import { dirFromYawPitch, DEG, type Vec3 } from '../core/math';
import type { Rng, RngStreams } from '../core/rng';
import type { PlayerState, InputCommand, WorldState } from '../sim/state';
import type { SimEventSink } from '../sim/events';
import type { StaticWorld } from '../world/collision';
import type { WeaponDef } from './defs';

/** Cone half-angle in degrees (§4.2). */
export function computeSpread(def: WeaponDef, p: Pick<PlayerState, 'vel' | 'crouched' | 'grounded' | 'heat' | 'scoped'>): number {
  const speed = Math.hypot(p.vel.x, p.vel.z);
  const sp = def.spread;
  const stand = p.scoped && sp.scoped !== undefined ? sp.scoped : sp.stand;
  const move = p.scoped && sp.scopedMove !== undefined ? sp.scopedMove : sp.move;
  const crouch = p.scoped && sp.scoped !== undefined ? sp.scoped : sp.crouch;
  const pose = speed < 0.3 ? (p.crouched ? crouch : stand) : stand + (move - stand) * Math.min(1, speed / def.speed);
  return pose * (1 + (p.grounded ? 0 : 3.0)) + def.perShot * p.heat;
}

export function applyRecoil(p: PlayerState, def: WeaponDef, rng: Rng): void {
  const idx = Math.min(Math.floor(p.shotIndex), def.pattern.length - 1);
  const [pitch, yaw] = def.pattern[idx];
  const jitter = 1 + rng.gauss(0, 0.08);
  p.aimOffset.pitch = Math.min(12 * DEG, p.aimOffset.pitch + pitch * DEG * jitter);
  p.aimOffset.yaw = Math.max(-6 * DEG, Math.min(6 * DEG, p.aimOffset.yaw + yaw * DEG * jitter));
  p.shotIndex += 1;
  p.heat += 1;
}

export function recoverRecoil(p: PlayerState, def: WeaponDef): void {
  const k = Math.exp(-(1 / 60) / 0.45);
  p.aimOffset.pitch *= k; p.aimOffset.yaw *= k;
  if (Math.abs(p.aimOffset.pitch) < 1e-5) p.aimOffset.pitch = 0;
  if (Math.abs(p.aimOffset.yaw) < 1e-5) p.aimOffset.yaw = 0;
  p.heat = Math.max(0, p.heat - def.heatRecover / 60);
  if (!p.triggerHeld) p.shotIndex = Math.max(0, p.shotIndex - def.patternRecovery / 60);
}

/** Shot direction: look + aimOffset rotated by a uniform-disc offset of radius spreadDeg (§4.2). */
export function sampleShotDir(yaw: number, pitch: number, aimOffset: { yaw: number; pitch: number }, spreadDeg: number, rng: Rng): Vec3 {
  const u1 = rng.next(), u2 = rng.next();
  const rho = spreadDeg * DEG * Math.sqrt(u1), phi = 2 * Math.PI * u2;
  return dirFromYawPitch(yaw + aimOffset.yaw + rho * Math.cos(phi), pitch + aimOffset.pitch + rho * Math.sin(phi));
}

/** STUB: no firing yet. L3 implements fire/reload/switch/scope/throw and calls resolveHitscan/applyDamage. */
export function tickWeapon(p: PlayerState, cmd: InputCommand, state: WorldState, world: StaticWorld, rng: RngStreams, out: SimEventSink): void {
  void cmd; void state; void world; void rng; void out;
  p.triggerHeld = (cmd.buttons & 1) !== 0;
}
