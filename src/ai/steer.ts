/**
 * Steering (§6.4 steps 5–7): A* path → string-pulled corners, corner seeking (arrive 0.5 m), teammate separation
 * (1.0 m side-step), world direction → body-local move, look-along-path scan, stuck detector (jump, then block the
 * next path node for 5 s and re-plan). Bots move through the same movePlayer() as the human.
 */
import { wrapAngle, clamp, DEG, type Vec3 } from '../core/math';
import type { ThinkContext } from '../sim/brain';
import { Btn, DT, type PlayerState, type BotMemory, type InputCommand } from '../sim/state';
import { distXZ, copyV } from './common';

export const STEER = {
  arrive: 0.5, goalArrive: 1.0, separation: 1.0, walkMag: 0.7,
  stuckWindow: 60, stuckDist: 0.3, stuckPhase2: 1000, blockTicks: 300,
  scanDeg: 20, holdScanDeg: 15,
} as const;

/** Re-plan mem.path/corners to `to` (honours a still-active blocked node). Returns false when unreachable. */
export function computePath(ctx: ThinkContext, self: PlayerState, mem: BotMemory, to: Vec3): boolean {
  const blocked = ctx.tick < mem.blockedUntilTick ? mem.blockedNode : -1;
  const ids = ctx.nav.findPath(self.pos, to, blocked);
  mem.stuckTicks = 0; mem.stuckCheckPos = copyV(self.pos);
  if (!ids || ids.length === 0) { mem.path = []; mem.corners = []; mem.pathIdx = 0; return false; }
  mem.path = ids; mem.corners = ctx.nav.pullString(ids, []); mem.pathIdx = 0;
  return true;
}

/** True when the bot stands within `r` of `pos` on the same floor (the last metre needs no path). */
export function arrivedAt(self: PlayerState, mem: BotMemory, pos: Vec3, r: number = STEER.goalArrive): boolean {
  void mem;
  return distXZ(self.pos, pos) < r && Math.abs(self.pos.y - pos.y) < 1.2;
}

/** Writes a body-local move into cmd for a desired world-space XZ direction (relative to cmd.yaw). */
export function setWorldMove(cmd: InputCommand, dx: number, dz: number, mag: number): void {
  const l = Math.hypot(dx, dz);
  if (l < 1e-6 || mag <= 0) { cmd.moveX = 0; cmd.moveZ = 0; return; }
  dx /= l; dz /= l;
  const s = Math.sin(cmd.yaw), c = Math.cos(cmd.yaw);
  const mz = dx * -s + dz * -c;          // · forward (−sin, −cos)
  const mx = dx * c + dz * -s;           // · right (cos, −sin)
  const ml = Math.hypot(mx, mz) || 1;
  const m = clamp(mag, 0, 1);
  cmd.moveX = (mx / ml) * m; cmd.moveZ = (mz / ml) * m;
}

/** Next corner (or the goal itself once the corners are used up). Advances pathIdx past reached corners. */
export function nextWaypoint(self: PlayerState, mem: BotMemory, goal: Vec3): Vec3 {
  while (mem.pathIdx < mem.corners.length) {
    const c = mem.corners[mem.pathIdx];
    const last = mem.pathIdx === mem.corners.length - 1;
    if (distXZ(self.pos, c) < (last ? 0.35 : STEER.arrive) && Math.abs(self.pos.y - c.y) < 1.2) mem.pathIdx++;
    else break;
  }
  return mem.pathIdx < mem.corners.length ? mem.corners[mem.pathIdx] : goal;
}

/** Yaw that looks along the path (≥ 2 m ahead when possible). */
export function pathYaw(self: PlayerState, mem: BotMemory, goal: Vec3): number {
  let i = mem.pathIdx;
  while (i < mem.corners.length - 1 && distXZ(self.pos, mem.corners[i]) < 2) i++;
  const t = i < mem.corners.length ? mem.corners[i] : goal;
  const dx = t.x - self.pos.x, dz = t.z - self.pos.z;
  return Math.hypot(dx, dz) < 1e-3 ? self.yaw : Math.atan2(-dx, -dz);
}

/** Look-around sweep: ±amp° sine with a 1–2 s period per bot (mem.scanPhase advances every tick). */
export function scanOffset(mem: BotMemory, ampDeg: number): number { return Math.sin(mem.scanPhase) * ampDeg * DEG; }
export function advanceScan(mem: BotMemory, slow: boolean): void {
  const period = (slow ? 3 : 1) * (60 + ((mem.id * 37) % 61));      // 1–2 s (moving) / 3–6 s (holding)
  mem.scanPhase = wrapAngle(mem.scanPhase + (2 * Math.PI) / period);
}

/**
 * Follow mem.corners toward `goal` (§6.4 step 6): seek, separation, local move, stuck detector.
 * Returns true when arrived (no move written in that case).
 */
export function followPath(ctx: ThinkContext, self: PlayerState, mem: BotMemory, goal: Vec3, cmd: InputCommand, walk: boolean): boolean {
  const wp = nextWaypoint(self, mem, goal);
  if (mem.pathIdx >= mem.corners.length && distXZ(self.pos, goal) < 0.35) { cmd.moveX = 0; cmd.moveZ = 0; resetStuck(mem, self); return true; }
  const l = Math.hypot(wp.x - self.pos.x, wp.z - self.pos.z) || 1;
  const sx = (wp.x - self.pos.x) / l, sz = (wp.z - self.pos.z) / l;   // seek direction
  let dx = sx, dz = sz;
  // teammate separation: push away + side-step perpendicular to travel so two bots in a door do not meet head-on
  for (const p of ctx.state.players) {
    if (!p.alive || p.team !== self.team || p.id === self.id) continue;
    const ox = self.pos.x - p.pos.x, oz = self.pos.z - p.pos.z; const d = Math.hypot(ox, oz);
    if (d >= STEER.separation) continue;
    const w = (1 - d / STEER.separation) * 1.5;
    const side = d < 1e-3 ? (self.id < p.id ? 1 : -1) : (ox * -sz + oz * sx) >= 0 ? 1 : -1;
    if (d >= 1e-3) { dx += (ox / d) * w; dz += (oz / d) * w; }
    dx += -sz * side * w * 0.5; dz += sx * side * w * 0.5;
  }
  setWorldMove(cmd, dx, dz, walk ? STEER.walkMag : 1);
  updateStuck(ctx, self, mem, goal, cmd);
  return false;
}

export function resetStuck(mem: BotMemory, self: PlayerState): void {
  mem.stuckTicks = 0; mem.stuckCheckPos.x = self.pos.x; mem.stuckCheckPos.y = self.pos.y; mem.stuckCheckPos.z = self.pos.z;
}

/** Stuck detector (§6.4 step 7): < 0.3 m over 1 s → JUMP once; still stuck 1 s later → block the next path node 5 s, re-plan. */
export function updateStuck(ctx: ThinkContext, self: PlayerState, mem: BotMemory, goal: Vec3, cmd: InputCommand): void {
  if (mem.corners.length === 0) { resetStuck(mem, self); return; }
  mem.stuckTicks++;
  const moved = distXZ(self.pos, mem.stuckCheckPos);
  if (mem.stuckTicks < STEER.stuckPhase2) {
    if (mem.stuckTicks < STEER.stuckWindow) return;
    if (moved < STEER.stuckDist) { cmd.buttons |= Btn.JUMP; mem.stuckTicks = STEER.stuckPhase2; mem.stuckCheckPos = copyV(self.pos); }
    else resetStuck(mem, self);
    return;
  }
  if (mem.stuckTicks < STEER.stuckPhase2 + STEER.stuckWindow) return;
  if (moved < STEER.stuckDist) {
    mem.blockedNode = nextPathNode(ctx, self, mem);
    mem.blockedUntilTick = ctx.tick + STEER.blockTicks;
    computePath(ctx, self, mem, goal);
  }
  resetStuck(mem, self);
}

/** The path node after the one the bot stands on (the one it cannot reach). */
export function nextPathNode(ctx: ThinkContext, self: PlayerState, mem: BotMemory): number {
  const here = ctx.nav.nearest(self.pos);
  const i = mem.path.indexOf(here);
  if (i >= 0 && i + 1 < mem.path.length) return mem.path[i + 1];
  if (mem.pathIdx < mem.corners.length) return ctx.nav.nearest(mem.corners[mem.pathIdx]);
  return mem.path.length ? mem.path[mem.path.length - 1] : here;
}

/** Angular tracker shared by look and aim (§6.6): exponential approach (rate 1 − e^(−DT/τ)), capped at turnRate. */
export function trackAim(mem: BotMemory, yaw: number, pitch: number, tauSec: number, turnRateDeg: number): void {
  const dy = wrapAngle(yaw - mem.aimYaw), dp = pitch - mem.aimPitch;
  const k = 1 - Math.exp(-DT / Math.max(1e-3, tauSec));
  let sy = dy * k, sp = dp * k;
  const mag = Math.hypot(sy, sp), cap = turnRateDeg * DEG * DT;
  if (mag > cap) { sy *= cap / mag; sp *= cap / mag; }
  mem.aimYaw = wrapAngle(mem.aimYaw + sy);
  mem.aimPitch = clamp(mem.aimPitch + sp, -89 * DEG, 89 * DEG);
}

export function yawTo(from: Vec3, to: Vec3, fallback: number): number { const dx = to.x - from.x, dz = to.z - from.z; return Math.hypot(dx, dz) < 1e-4 ? fallback : Math.atan2(-dx, -dz); }
export function pitchTo(from: Vec3, to: Vec3): number { return Math.atan2(to.y - from.y, Math.hypot(to.x - from.x, to.z - from.z)); }
