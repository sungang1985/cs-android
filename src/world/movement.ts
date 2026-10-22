/**
 * Player movement (humans and bots alike): the §7.8 rule, acceleration/friction, jump, crouch, footsteps, fall
 * damage. Uses StaticWorld.moveBody. Pure; emits footstep/jump/land/sound; pushes DeathInfo on a fatal fall.
 */
import { v3, forwardXZ, rightXZ, clamp, DEG, type Vec3 } from '../core/math';
import type { StaticWorld, BodyShape } from './collision';
import { toSimSurface } from './types';
import { Btn, BODY, DT, type PlayerState, type InputCommand, type WorldState } from '../sim/state';
import type { SimEventSink } from '../sim/events';

export const PLAYER_SHAPE: { stand: BodyShape; crouch: BodyShape } = {
  stand: { halfWidth: BODY.halfWidth, height: BODY.standHeight, stepHeight: BODY.stepHeight },
  crouch: { halfWidth: BODY.halfWidth, height: BODY.crouchHeight, stepHeight: BODY.stepHeight },
};

export const MOVE = {
  walkFactor: 0.52, crouchFactor: 0.5, groundAccel: 40, friction: 8, airAccel: 1.5,
  jumpImpulse: 6.0, gravity: 20, fallDamageMinSpeed: 9, fallDamagePerMs: 10, strideM: 1.5, maxPitch: 89 * DEG,
} as const;

const _fwd = v3(), _right = v3();

/**
 * @param maxSpeed  WEAPONS[active].speed (or scopedSpeed), computed by sim.ts
 * @param frozen    FREEZE phase: no horizontal movement/jump, look still works
 */
export function movePlayer(p: PlayerState, cmd: InputCommand, world: StaticWorld, maxSpeed: number, frozen: boolean, tick: number, state: WorldState, out: SimEventSink): void {
  p.yaw = cmd.yaw;
  p.pitch = clamp(cmd.pitch, -MOVE.maxPitch, MOVE.maxPitch);
  if (!p.alive) return;

  // Crouch (can't stand up under a 1.4 m clearance)
  p.wantCrouch = (cmd.buttons & Btn.CROUCH) !== 0;
  if (p.wantCrouch && !p.crouched) p.crouched = true;
  else if (!p.wantCrouch && p.crouched) {
    const box = { min: v3(p.pos.x - BODY.halfWidth, p.pos.y + 0.01, p.pos.z - BODY.halfWidth), max: v3(p.pos.x + BODY.halfWidth, p.pos.y + BODY.standHeight, p.pos.z + BODY.halfWidth) };
    if (!world.overlaps(box)) p.crouched = false;
  }
  const shape = p.crouched ? PLAYER_SHAPE.crouch : PLAYER_SHAPE.stand;

  // Desired horizontal velocity (§7.8 rule: binary magnitude)
  const len = Math.hypot(cmd.moveX, cmd.moveZ);
  let tx = 0, tz = 0;
  const walk = (cmd.buttons & Btn.WALK) !== 0 || (len > 1e-3 && len <= 0.75);
  if (len > 1e-3 && !frozen) {
    forwardXZ(p.yaw, _fwd); rightXZ(p.yaw, _right);
    const nx = cmd.moveX / len, nz = cmd.moveZ / len;
    const speed = maxSpeed * (walk ? MOVE.walkFactor : 1) * (p.crouched ? MOVE.crouchFactor : 1);
    tx = (_fwd.x * nz + _right.x * nx) * speed;
    tz = (_fwd.z * nz + _right.z * nx) * speed;
  }
  const v = p.vel;
  if (p.grounded) {
    if (len > 1e-3 && !frozen) {
      const dx = tx - v.x, dz = tz - v.z; const d = Math.hypot(dx, dz);
      const step = MOVE.groundAccel * DT;
      if (d <= step) { v.x = tx; v.z = tz; } else { v.x += (dx / d) * step; v.z += (dz / d) * step; }
    } else {
      const f = Math.max(0, 1 - MOVE.friction * DT);
      v.x *= f; v.z *= f;
      if (Math.hypot(v.x, v.z) < 0.05) { v.x = 0; v.z = 0; }
    }
  } else if (len > 1e-3 && !frozen) {
    const step = MOVE.airAccel * DT; const d = Math.hypot(tx, tz) || 1;
    v.x += (tx / d) * step; v.z += (tz / d) * step;
    const sp = Math.hypot(v.x, v.z); if (sp > maxSpeed) { v.x *= maxSpeed / sp; v.z *= maxSpeed / sp; }
  }

  // Jump & gravity
  let jumped = false;
  if ((cmd.buttons & Btn.JUMP) !== 0 && p.grounded && !frozen) {
    v.y = MOVE.jumpImpulse; jumped = true; p.grounded = false;
    out.emit('jump', { player: p.id, pos: v3(p.pos.x, p.pos.y, p.pos.z) });
    out.emit('sound', { id: 'jump', pos: v3(p.pos.x, p.pos.y, p.pos.z), loudness: 8, player: p.id });
  }
  v.y -= MOVE.gravity * DT;
  const vyBefore = v.y;
  const wasGrounded = p.grounded;

  const r = world.moveBody(p.pos, v, DT, shape, { wasGrounded, snapDown: !jumped });
  const dx = r.pos.x - p.pos.x, dz = r.pos.z - p.pos.z;
  p.pos.x = r.pos.x; p.pos.y = r.pos.y; p.pos.z = r.pos.z;
  v.x = r.vel.x; v.y = r.vel.y; v.z = r.vel.z;
  if (r.grounded && v.y < 0) v.y = 0;
  p.grounded = r.grounded;

  // Landing + fall damage
  if (!wasGrounded && r.grounded) {
    const impact = Math.max(0, -vyBefore);
    out.emit('land', { player: p.id, pos: v3(p.pos.x, p.pos.y, p.pos.z), impact });
    out.emit('sound', { id: 'land', pos: v3(p.pos.x, p.pos.y, p.pos.z), loudness: 10, player: p.id });
    const dmg = Math.round(Math.max(0, (impact - MOVE.fallDamageMinSpeed) * MOVE.fallDamagePerMs));
    if (dmg > 0) {
      p.hp -= dmg;
      p.lastDamage = { tick, from: v3(p.pos.x, p.pos.y - 1, p.pos.z), amount: dmg };
      out.emit('damageTaken', { victim: p.id, from: v3(p.pos.x, p.pos.y - 1, p.pos.z), amount: dmg, hpLeft: Math.max(0, p.hp) });
      if (p.hp <= 0) killByFall(p, tick, state);
    }
  }

  // Footsteps & animation phase
  const moved = Math.hypot(dx, dz);
  if (r.grounded && moved > 0) {
    p.distanceWalked += moved;
    p.legPhase = (p.legPhase + (moved / MOVE.strideM) * Math.PI * 2) % (Math.PI * 2);
    const running = !walk && !p.crouched && Math.hypot(v.x, v.z) > 1.0;
    if (running && p.distanceWalked - p.lastFootstepDist >= MOVE.strideM) {
      p.lastFootstepDist = p.distanceWalked;
      const surface = toSimSurface(r.groundSurface);
      out.emit('footstep', { player: p.id, pos: v3(p.pos.x, p.pos.y, p.pos.z), surface, walking: false });
      out.emit('sound', { id: `footstep_${surface}`, pos: v3(p.pos.x, p.pos.y, p.pos.z), loudness: 10, player: p.id });
    }
  } else if (!r.grounded) {
    // keep phase while airborne
  }
}

function killByFall(p: PlayerState, tick: number, state: WorldState): void {
  p.hp = 0; p.alive = false; p.deathTick = tick; p.deathDir = v3(0, -1, 0);
  p.use.action = 'none'; p.reload = null; p.scoped = 0; p.throwing = null;
  state.pendingDeaths.push({ victim: p.id, killer: 0, weapon: 'fall', headshot: false, dir: v3(0, -1, 0), point: v3(p.pos.x, p.pos.y, p.pos.z) });
}

/** Horizontal speed helper used by weapons (spread) and the snapshot. */
export function horizontalSpeed(p: Pick<PlayerState, 'vel'>): number { return Math.hypot(p.vel.x, p.vel.z); }
export function eyePos(p: Pick<PlayerState, 'pos' | 'crouched'>, out: Vec3 = v3()): Vec3 { out.x = p.pos.x; out.y = p.pos.y + (p.crouched ? BODY.crouchEye : BODY.standEye); out.z = p.pos.z; return out; }
