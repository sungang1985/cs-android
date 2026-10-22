/**
 * Aim-assist candidates for the human (§7.5) and the human's `spotted` events: enemies with LOS from the eye,
 * ≤ 40 m, in front of the camera. Pure.
 */
import { v3, dirFromYawPitch, v3sub, v3dot, v3len, type Vec3 } from '../core/math';
import type { WorldState, AimCandidate, PlayerState } from './state';
import type { SimEventSink } from './events';
import type { StaticWorld } from '../world/collision';
import { eyePos } from '../world/movement';

const CHEST_Y = 1.2, CHEST_Y_CROUCH = 0.85, RANGE = 40, RADIUS = 0.35;
const _eye = v3(), _fwd = v3(), _d = v3();

export function chestOf(p: Pick<PlayerState, 'pos' | 'crouched'>, out: Vec3 = v3()): Vec3 { out.x = p.pos.x; out.y = p.pos.y + (p.crouched ? CHEST_Y_CROUCH : CHEST_Y); out.z = p.pos.z; return out; }

export function computeCandidates(state: WorldState, world: StaticWorld, out: AimCandidate[], sink?: SimEventSink): AimCandidate[] {
  out.length = 0;
  const me = state.players.find((p) => p.id === state.humanId);
  if (!me || !me.alive) return out;
  eyePos(me, _eye);
  dirFromYawPitch(me.yaw, me.pitch, _fwd);
  for (const p of state.players) {
    if (!p.alive || p.team === me.team) continue;
    const chest = chestOf(p);
    v3sub(chest, _eye, _d);
    const dist = v3len(_d);
    if (dist > RANGE || dist < 1e-3) continue;
    if (v3dot(_d, _fwd) / dist < 0.2) continue; // in front of the camera (~78° half-cone)
    if (!world.lineOfSight(_eye, chest) && !world.lineOfSight(_eye, v3(p.pos.x, p.pos.y + (p.crouched ? 1.1 : 1.6), p.pos.z))) continue;
    out.push({ id: p.id, chest, radius: RADIUS, vel: v3(p.vel.x, p.vel.y, p.vel.z) });
    if (sink) sink.emit('spotted', { team: me.team, enemy: p.id, pos: v3(p.pos.x, p.pos.y, p.pos.z), by: me.id });
  }
  return out;
}
