/**
 * Pure camera helpers for the dead human (§2.2, §15): the spectator chase cam (behind and above the followed
 * teammate, pulled in front of walls) and the kill-cam killer latch (the sim's `SnapLocal.killerId` follows
 * `round.lastKill`, which the next death anywhere overwrites).
 */
import type { Vec3, Aabb } from '../core/math';
import { rayAabb } from '../core/math';

export const CHASE = { back: 2.2, up: 0.5, lookAhead: 4, wallGap: 0.2, minDist: 0.3 } as const;

/**
 * Chase cam for the spectated player: `pivot` is their eye, (yaw, pitch) their view (§0: forward = (−sin yaw, ·, −cos yaw)).
 * Writes the camera position into `eye` and the look-at point (ahead along their aim) into `target`.
 */
export function chaseCam(pivot: Vec3, yaw: number, pitch: number, solids: readonly Aabb[], eye: Vec3, target: Vec3): void {
  const cp = Math.cos(pitch);
  target.x = pivot.x - Math.sin(yaw) * cp * CHASE.lookAhead;
  target.y = pivot.y + Math.sin(pitch) * CHASE.lookAhead;
  target.z = pivot.z - Math.cos(yaw) * cp * CHASE.lookAhead;
  const ox = Math.sin(yaw) * CHASE.back, oy = CHASE.up, oz = Math.cos(yaw) * CHASE.back;
  const len = Math.hypot(ox, oy, oz);
  const d = { x: ox / len, y: oy / len, z: oz / len };
  let t = len;
  for (const b of solids) { const h = rayAabb(pivot, d, b, t); if (h !== null && h < t) t = h; }
  if (t < len) t = Math.max(CHASE.minDist, t - CHASE.wallGap);
  eye.x = pivot.x + d.x * t; eye.y = pivot.y + d.y * t; eye.z = pivot.z + d.z * t;
}

/** Remembers who killed the local player (from the `death` event) until they are alive again. */
export class KillcamLatch {
  private killer = 0;
  private latched = false;
  /** `death` event. Self-kills and world deaths (fall, bomb) have no killer to turn to. */
  onDeath(victim: number, killer: number, localId: number): void {
    if (victim !== localId) return;
    this.killer = killer > 0 && killer !== victim ? killer : 0; this.latched = true;
  }
  /** Per frame: the latched killer (the snapshot's `killerId` only if no death event was seen), 0 while alive. */
  resolve(alive: boolean, snapKillerId: number, localId: number): number {
    if (alive) { this.killer = 0; this.latched = false; return 0; }
    if (this.latched) return this.killer;
    return snapKillerId > 0 && snapKillerId !== localId ? snapKillerId : 0;
  }
}
