/**
 * Crosshair math (§8.1, §4.3). The camera shows look + 0.5·aimOffset, bullets go along look + aimOffset, so the
 * crosshair sits at the projection of +0.5·aimOffset relative to the camera. Three.js cameras use a VERTICAL fov,
 * hence both axes scale by (H/2)/tan(fov/2). Yaw follows §0 (positive = left), so +yaw moves the crosshair left;
 * pitch positive = up = negative CSS y.
 */
export interface View { fovDeg: number; width: number; height: number }

export const MAX_GAP_PX = 120;

/** Gap between the four crosshair lines: 4 + spreadDeg × 12 px (capped). */
export function crosshairGap(spreadDeg: number): number {
  const s = Number.isFinite(spreadDeg) ? Math.max(0, spreadDeg) : 0;
  return Math.min(MAX_GAP_PX, 4 + s * 12);
}

/** Screen offset (CSS px, from the centre) of the recoil crosshair. */
export function crosshairOffset(aimOffsetYaw: number, aimOffsetPitch: number, view: View): { dx: number; dy: number } {
  const half = ((view.fovDeg > 1 ? view.fovDeg : 75) * Math.PI) / 360;
  const k = view.height / 2 / Math.tan(half);
  return { dx: -Math.tan(0.5 * aimOffsetYaw) * k, dy: -Math.tan(0.5 * aimOffsetPitch) * k };
}

/** Crosshair colour state: red on an enemy / amber on a teammate, only when aim assist or auto-fire is on (§7.5). */
export function crosshairState(target: 0 | 1 | 2, assistOrAutoFire: boolean): 'none' | 'enemy' | 'friend' {
  if (!assistOrAutoFire) return 'none';
  return target === 1 ? 'enemy' : target === 2 ? 'friend' : 'none';
}
