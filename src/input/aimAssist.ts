/**
 * Aim assist & auto-fire (§7.5). Pure: `applyAimAssist` is called identically at tick time (dt = 1/60) and for the
 * render-frame preview (dt = 0 ⇒ friction only, no magnetism integration), so friction never "snaps".
 * Body only (chest centre, 0.35 m radius), never the head; candidates are LOS-checked by the sim.
 */
import { DEG, clamp, v3, v3sub, v3dot, v3len, dirFromYawPitch, yawFromDir, pitchFromDir, angleDelta, type Vec3 } from '../core/math';
import { WEAPON_INDEX, type AimCandidate, type LookPreview, type SnapLocal } from '../sim/state';
import { WEAPONS } from '../weapons/defs';

export interface AssistLevelCfg { friction: number; frictionDeg: number; magnetDegPerSec: number; magnetDeg: number; strafe: boolean; track: number }
/** Index = ControlSettings.aimAssist (0 Off, 1 Low, 2 Medium, 3 High). */
export const ASSIST_LEVELS: readonly (AssistLevelCfg | null)[] = [
  null,
  { friction: 0.75, frictionDeg: 2.0, magnetDegPerSec: 0, magnetDeg: 0, strafe: false, track: 0 },
  { friction: 0.60, frictionDeg: 2.5, magnetDegPerSec: 1.5, magnetDeg: 4, strafe: false, track: 0 },
  { friction: 0.50, frictionDeg: 3.0, magnetDegPerSec: 3.0, magnetDeg: 5, strafe: true, track: 0.6 },
];

const _fwd = v3(), _d = v3(), _f = v3();
const TRACK_PROBE_SEC = 0.1;

/** Angular distance (radians) from the look direction to the edge of the candidate's body disc (0 when on it). */
export function angularEdge(look: LookPreview, eye: Vec3, c: AimCandidate): number {
  dirFromYawPitch(look.yaw, look.pitch, _fwd);
  v3sub(c.chest, eye, _d);
  const dist = v3len(_d);
  if (dist < 1e-3) return Infinity;
  const angle = Math.acos(clamp(v3dot(_fwd, _d) / dist, -1, 1));
  return Math.max(0, angle - Math.atan(c.radius / dist));
}

export function applyAimAssist(delta: { yaw: number; pitch: number }, look: LookPreview, eye: Vec3, candidates: AimCandidate[], level: 0 | 1 | 2 | 3, dt: number, dragging: boolean, strafing: boolean): { yaw: number; pitch: number } {
  const cfg = ASSIST_LEVELS[level];
  if (!cfg || candidates.length === 0) return { yaw: delta.yaw, pitch: delta.pitch };
  let best: AimCandidate | null = null, bestEdge = Infinity;
  for (const c of candidates) {
    const e = angularEdge(look, eye, c);
    if (e < bestEdge) { bestEdge = e; best = c; }
  }
  if (!best) return { yaw: delta.yaw, pitch: delta.pitch };
  let yaw = delta.yaw, pitch = delta.pitch;
  if (bestEdge <= cfg.frictionDeg * DEG) { yaw *= cfg.friction; pitch *= cfg.friction; }
  const magnet = dt > 0 && cfg.magnetDegPerSec > 0 && (dragging || (cfg.strafe && strafing)) && bestEdge <= cfg.magnetDeg * DEG;
  if (!magnet) return { yaw, pitch };
  v3sub(best.chest, eye, _d);
  const ty = yawFromDir(_d), tp = pitchFromDir(_d);
  const oy = angleDelta(look.yaw + yaw, ty), op = tp - (look.pitch + pitch);
  const m = Math.hypot(oy * Math.cos(look.pitch), op);
  if (m > 1e-9) {
    const step = Math.min(cfg.magnetDegPerSec * DEG * dt, m) / m;
    yaw += oy * step; pitch += op * step;
  }
  if (cfg.track > 0) {
    // the target's angular velocity as seen from the eye, compensated by `track` (60 % at High)
    _f.x = best.chest.x + best.vel.x * TRACK_PROBE_SEC - eye.x; _f.y = best.chest.y + best.vel.y * TRACK_PROBE_SEC - eye.y; _f.z = best.chest.z + best.vel.z * TRACK_PROBE_SEC - eye.z;
    const wy = angleDelta(ty, yawFromDir(_f)) / TRACK_PROBE_SEC, wp = (pitchFromDir(_f) - tp) / TRACK_PROBE_SEC;
    yaw += cfg.track * wy * dt; pitch += cfg.track * wp * dt;
  }
  return { yaw, pitch };
}

// ───────── auto-fire / auto-reload (§7.5, §4.4) ─────────
export const AUTO_FIRE_TICKS = 6;
export const AUTO_RELOAD_TICKS = 48;      // 0.8 s
export const AUTO_RELOAD_RETRY_TICKS = 240;
export const SEMI_PULSE_FRACTION = 0.7;   // semi-autos are pulsed at 70 % of max RPM

export interface AutoState { fireStreak: number; pulse: number; emptyStreak: number; reloadWeapon: number }
export function createAutoState(): AutoState { return { fireStreak: 0, pulse: 0, emptyStreak: 0, reloadWeapon: -1 }; }

/** Called once per sample(): true when auto-fire sets FIRE this tick. */
export function autoFireStep(st: AutoState, local: SnapLocal, enabled: boolean): boolean {
  if (!enabled || local.alive !== 1 || local.crosshairTarget !== 1) { st.fireStreak = 0; st.pulse = 0; return false; }
  st.fireStreak++;
  if (st.fireStreak < AUTO_FIRE_TICKS) return false;
  const id = WEAPON_INDEX[local.weapon];
  if (!id) return false;
  const def = WEAPONS[id];
  if (def.type === 'melee' || def.type === 'grenade' || (id === 'awp' && local.scoped === 0)) return false;
  if (def.auto) return true;
  const period = 3600 / (SEMI_PULSE_FRACTION * def.rpm);   // ticks between press edges
  st.pulse -= 1;
  if (st.pulse <= 0) { st.pulse += period; return true; }
  return false;
}

/** Called once per sample(): true when auto-reload sets RELOAD (once per empty episode, retried every 4 s). */
export function autoReloadStep(st: AutoState, local: SnapLocal, candidateCount: number, enabled: boolean): boolean {
  const id = WEAPON_INDEX[local.weapon];
  const gun = !!id && WEAPONS[id].type !== 'melee' && WEAPONS[id].type !== 'grenade';
  if (st.reloadWeapon !== local.weapon) { st.reloadWeapon = local.weapon; st.emptyStreak = 0; }
  if (!enabled || local.alive !== 1 || !gun || local.mag > 0 || local.reserve <= 0 || candidateCount > 0) { st.emptyStreak = 0; return false; }
  st.emptyStreak++;
  const n = st.emptyStreak - AUTO_RELOAD_TICKS;
  return n === 0 || (n > 0 && n % AUTO_RELOAD_RETRY_TICKS === 0);
}
