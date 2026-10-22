/** Aim assist (§7.5). DAY-0 STUB: identity. L7 implements friction + magnetism (same function at tick and preview). */
import type { Vec3 } from '../core/math';
import type { AimCandidate, LookPreview } from '../sim/state';

export function applyAimAssist(delta: { yaw: number; pitch: number }, look: LookPreview, eye: Vec3, candidates: AimCandidate[], level: 0 | 1 | 2 | 3, dt: number, dragging: boolean, strafing: boolean): { yaw: number; pitch: number } {
  void look; void eye; void candidates; void level; void dt; void dragging; void strafing;
  return { yaw: delta.yaw, pitch: delta.pitch };
}
