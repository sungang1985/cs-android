/**
 * Player movement (humans and bots alike): the §7.8 rule, acceleration/friction, jump, crouch, footsteps, fall
 * damage. Uses StaticWorld.moveBody. Pure; emits footstep/jump/land/damageTaken + `sound`; pushes DeathInfo on a
 * fatal fall (§11.6.1). Constants: §2.1.
 *
 * Integration is exact for constant gravity (half of the tick's gravity before the sweep, half after), so a 6 m/s
 * jump peaks at exactly 0.90 m after 18 ticks and lands after 36; fall impact speed is the energy-exact contact
 * speed sqrt(v0² + 2·g·drop) of the landing tick.
 */
import { v3, forwardXZ, rightXZ, clamp, DEG, type Vec3 } from '../core/math';
import type { StaticWorld, BodyShape } from './collision';
import { toSimSurface } from './types';
import { Btn, BODY, DT, type PlayerState, type InputCommand, type WorldState } from '../sim/state';
import { LOUDNESS, type SimEventSink } from '../sim/events';

export const PLAYER_SHAPE: { stand: BodyShape; crouch: BodyShape } = {
  stand: { halfWidth: BODY.halfWidth, height: BODY.standHeight, stepHeight: BODY.stepHeight },
  crouch: { halfWidth: BODY.halfWidth, height: BODY.crouchHeight, stepHeight: BODY.stepHeight },
};

export const MOVE = {
  /** §7.8: walking (WALK bit or 0 < |move| ≤ walkBand) is a binary 0.52× of max speed */
  walkFactor: 0.52, walkBand: 0.75, deadZone: 1e-3, crouchFactor: 0.5,
  /** ground: approach the target velocity at 40 m/s²; no input: friction 8 /s, snap to rest below 0.05 m/s */
  groundAccel: 40, friction: 8, stopSpeed: 0.05, airAccel: 1.5,
  jumpImpulse: 6.0, gravity: 20, fallDamageMinSpeed: 9, fallDamagePerMs: 10,
  /** a running footstep every 1.5 m of grounded travel above 1 m/s */
  strideM: 1.5, footstepMinSpeed: 1.0, maxPitch: 89 * DEG,
} as const;

/** §2.1: max(0, (vImpact − 9) × 10) HP, rounded to whole HP. 10 m/s → 10 HP. */
export function fallDamage(vImpact: number): number {
  return Math.round(Math.max(0, (vImpact - MOVE.fallDamageMinSpeed) * MOVE.fallDamagePerMs));
}

/** The §7.8 rule: is this command a (silent) walk? */
export function isWalking(cmd: Pick<InputCommand, 'moveX' | 'moveZ' | 'buttons'>): boolean {
  const len = Math.hypot(cmd.moveX, cmd.moveZ);
  return (cmd.buttons & Btn.WALK) !== 0 || (len > MOVE.deadZone && len <= MOVE.walkBand);
}

/** Target horizontal speed for a command (§7.8): binary magnitude, never proportional to stick travel. */
export function targetSpeed(cmd: Pick<InputCommand, 'moveX' | 'moveZ' | 'buttons'>, maxSpeed: number, crouched: boolean): number {
  if (Math.hypot(cmd.moveX, cmd.moveZ) < MOVE.deadZone) return 0;
  return maxSpeed * (isWalking(cmd) ? MOVE.walkFactor : 1) * (crouched ? MOVE.crouchFactor : 1);
}

const _fwd = v3(), _right = v3();
const _standBox = { min: v3(), max: v3() };

/** Would a standing body fit at the player's position (un-crouch test, §2.1: not under a 1.4 m clearance)? */
export function canStand(p: Pick<PlayerState, 'pos'>, world: StaticWorld): boolean {
  _standBox.min.x = p.pos.x - BODY.halfWidth; _standBox.min.y = p.pos.y + 0.01; _standBox.min.z = p.pos.z - BODY.halfWidth;
  _standBox.max.x = p.pos.x + BODY.halfWidth; _standBox.max.y = p.pos.y + BODY.standHeight; _standBox.max.z = p.pos.z + BODY.halfWidth;
  return !world.overlaps(_standBox);
}

/**
 * @param maxSpeed  WEAPONS[active].speed (or scopedSpeed), computed by sim.ts
 * @param frozen    FREEZE / ROUND_END: no horizontal input and no jump (friction, gravity, crouch and look still work)
 */
export function movePlayer(p: PlayerState, cmd: InputCommand, world: StaticWorld, maxSpeed: number, frozen: boolean, tick: number, state: WorldState, out: SimEventSink): void {
  p.yaw = cmd.yaw;
  p.pitch = clamp(cmd.pitch, -MOVE.maxPitch, MOVE.maxPitch);
  if (!p.alive) return;

  // Crouch (hold semantics at the sim level; the input layer implements toggle). Can't stand up under low clearance.
  p.wantCrouch = (cmd.buttons & Btn.CROUCH) !== 0;
  if (p.wantCrouch && !p.crouched) p.crouched = true;
  else if (!p.wantCrouch && p.crouched && canStand(p, world)) p.crouched = false;
  const shape = p.crouched ? PLAYER_SHAPE.crouch : PLAYER_SHAPE.stand;

  // Desired horizontal velocity (§7.8 rule: binary magnitude along the normalised stick direction)
  const len = Math.hypot(cmd.moveX, cmd.moveZ);
  const input = len >= MOVE.deadZone && !frozen;
  const walk = isWalking(cmd);
  let tx = 0, tz = 0;
  if (input) {
    forwardXZ(p.yaw, _fwd); rightXZ(p.yaw, _right);
    const nx = cmd.moveX / len, nz = cmd.moveZ / len;
    const speed = targetSpeed(cmd, maxSpeed, p.crouched);
    tx = (_fwd.x * nz + _right.x * nx) * speed;
    tz = (_fwd.z * nz + _right.z * nx) * speed;
  }
  const v = p.vel;
  if (p.grounded) {
    if (input) {
      const dx = tx - v.x, dz = tz - v.z, d = Math.hypot(dx, dz);
      const step = MOVE.groundAccel * DT;
      if (d <= step) { v.x = tx; v.z = tz; } else { v.x += (dx / d) * step; v.z += (dz / d) * step; }
    } else {
      const f = Math.max(0, 1 - MOVE.friction * DT);
      v.x *= f; v.z *= f;
      if (Math.hypot(v.x, v.z) < MOVE.stopSpeed) { v.x = 0; v.z = 0; }
    }
  } else if (input) {
    const step = MOVE.airAccel * DT, d = Math.hypot(tx, tz) || 1;
    v.x += (tx / d) * step; v.z += (tz / d) * step;
    const sp = Math.hypot(v.x, v.z);
    if (sp > maxSpeed) { v.x *= maxSpeed / sp; v.z *= maxSpeed / sp; }
  }

  // Jump
  let jumped = false;
  if ((cmd.buttons & Btn.JUMP) !== 0 && p.grounded && !frozen) {
    v.y = MOVE.jumpImpulse; jumped = true; p.grounded = false;
    const at = v3(p.pos.x, p.pos.y, p.pos.z);
    out.emit('jump', { player: p.id, pos: at });
    out.emit('sound', { id: 'jump', pos: v3(at.x, at.y, at.z), loudness: LOUDNESS.jump, player: p.id });
  }
  const wasGrounded = p.grounded;
  const vy0 = v.y, y0 = p.pos.y;

  // Sweep with half the tick's gravity applied before and half after (exact ballistic arcs)
  v.y -= MOVE.gravity * DT * 0.5;
  const r = world.moveBody(p.pos, v, DT, shape, { wasGrounded, snapDown: !jumped, airStep: true, airStepHeadroom: PLAYER_SHAPE.stand.height, clipWalls: true });
  const dx = r.pos.x - p.pos.x, dz = r.pos.z - p.pos.z;
  p.pos.x = r.pos.x; p.pos.y = r.pos.y; p.pos.z = r.pos.z;
  v.x = r.vel.x; v.y = r.vel.y; v.z = r.vel.z;
  if (r.grounded) { if (v.y < 0) v.y = 0; } else v.y -= MOVE.gravity * DT * 0.5;
  p.grounded = r.grounded;

  // Landing + fall damage (impact = contact speed of the landing tick)
  if (!wasGrounded && r.grounded) {
    const impact = Math.sqrt(Math.max(0, vy0 * vy0 + 2 * MOVE.gravity * (y0 - p.pos.y)));
    const at = v3(p.pos.x, p.pos.y, p.pos.z);
    out.emit('land', { player: p.id, pos: at, impact });
    out.emit('sound', { id: 'land', pos: v3(at.x, at.y, at.z), loudness: LOUDNESS.land, player: p.id });
    const dmg = fallDamage(impact);
    if (dmg > 0) {
      p.hp -= dmg;
      p.lastDamage = { tick, from: v3(p.pos.x, p.pos.y - 1, p.pos.z), amount: dmg };
      out.emit('damageTaken', { victim: p.id, from: v3(p.pos.x, p.pos.y - 1, p.pos.z), amount: dmg, hpLeft: Math.max(0, p.hp) });
      if (p.hp <= 0) killByFall(p, tick, state);
    }
  }

  // Footsteps & animation phase: running emits a footstep every 1.5 m; walking and crouching are silent
  const moved = Math.hypot(dx, dz);
  if (r.grounded && moved > 0) {
    p.distanceWalked += moved;
    p.legPhase = (p.legPhase + (moved / MOVE.strideM) * Math.PI * 2) % (Math.PI * 2);
    const running = !walk && !p.crouched && Math.hypot(v.x, v.z) > MOVE.footstepMinSpeed;
    if (!running) p.lastFootstepDist = p.distanceWalked; // the stride counter restarts when running starts
    else if (p.distanceWalked - p.lastFootstepDist >= MOVE.strideM) {
      p.lastFootstepDist = p.distanceWalked - p.lastFootstepDist >= 2 * MOVE.strideM ? p.distanceWalked : p.lastFootstepDist + MOVE.strideM;
      const surface = toSimSurface(r.groundSurface);
      const at = v3(p.pos.x, p.pos.y, p.pos.z);
      out.emit('footstep', { player: p.id, pos: at, surface, walking: false });
      out.emit('sound', { id: `footstep_${surface}`, pos: v3(at.x, at.y, at.z), loudness: LOUDNESS.footstep, player: p.id });
    }
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
