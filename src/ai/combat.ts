/**
 * Combat behaviour (§6.6, §6.7): aim error (2D Gaussian in the plane ⟂ to view, metres at the target, resampled every
 * τ_err), tracking (exponential, turn-rate capped), recoil control, fire gate (cone + LOS + reaction), bursts for
 * automatics, 70 % RPM taps for pistols, AWP scope→settle→fire, knife when dry, strafe/peek per difficulty, reload /
 * slot management, grenade intents (HE / flash: select + THROW held then released) and retreat cover.
 * The weapons lane implements the actual firing; this file only emits command bits.
 */
import { v3, v3dot, v3len, v3sub, dirFromYawPitch, clamp, wrapAngle, DEG, type Vec3 } from '../core/math';
import type { ThinkContext } from '../sim/brain';
import { Btn, type PlayerState, type BotMemory, type InputCommand, type Slot } from '../sim/state';
import { WEAPONS, type WeaponDef } from '../weapons/defs';
import { activeWeaponId, activeSlotState } from '../weapons/inventory';
import { eyePos, horizontalSpeed } from '../world/movement';
import type { DifficultyCfg } from './difficulty';
import { chestPos, headPos, distXZ, player, teammateWithin, ticks, copyV } from './common';
import { isRecognised, targetVisibleNow, type Perception } from './perception';
import { trackAim, yawTo, pitchTo, setWorldMove } from './steer';

export const COMBAT = {
  pistolRate: 0.7, awpZoomTicks: 15, awpBoltTicks: 90, awpAimDeg: 0.5, knifeRange: 3, pistolSwitchRange: 6,
  peekP: 0.35, peekTicks: Math.round((1.5 / 4.3) * 60), crouchP: 0.4, counterStopSpeed: 0.3, strafeFlip: [18, 30] as [number, number],
  heRange: 15, heMinDist: 4, flashRange: 12, throwHoldTicks: 6, flashLookAwayTicks: 96, heRecoverTicks: 20,
} as const;
/** mem.burstLeft codes while a grenade intent runs outside combat (it is a burst counter only in ENGAGE). */
export const THROW = { he: -1, flash: -2, after: -3, used: -9 } as const;

const _eye = v3(), _chest = v3(), _head = v3(), _pt = v3(), _aim = v3(), _d = v3();

export function activeDef(self: PlayerState): WeaponDef { return WEAPONS[activeWeaponId(self)]; }
function angleBetween(a: Vec3, b: Vec3): number { const la = v3len(a), lb = v3len(b); if (la < 1e-9 || lb < 1e-9) return Math.PI; return Math.acos(clamp(v3dot(a, b) / (la * lb), -1, 1)); }
/** Press a button on even ticks only (rising edges for semi-auto / toggles). */
export function pressEdge(cmd: InputCommand, tick: number, btn: number): void { if (tick % 2 === 0) cmd.buttons |= btn; }
export function requestSlot(self: PlayerState, cmd: InputCommand, s: Slot): void { if (self.inv.active !== s && self.inv.pendingSlot !== s) cmd.slot = s; }
/** Ticks to hold FIRE so an automatic fires exactly n shots. */
export function burstTicks(n: number, rpm: number): number { return Math.floor(((n - 1) * 3600) / rpm) + 1; }

/** Resample the aim error (§6.6): σ = 10 m·tan(σ_err) scaled by target speed and distance; head with p_head. */
export function resampleAimError(ctx: ThinkContext, mem: BotMemory, cfg: DifficultyCfg, target: PlayerState, dist: number): void {
  const speed = horizontalSpeed(target);
  const sigma = 10 * Math.tan(cfg.sigmaErrDeg * DEG) * (1 + (2 * speed) / 4.3) * (1 + (0.4 * dist) / 20);
  const head = ctx.rng.chance(cfg.pHead);
  mem.aimErr.x = ctx.rng.gauss(0, sigma);
  mem.aimErr.y = ctx.rng.gauss(0, sigma) + (head ? (target.crouched ? 0.25 : 0.4) : 0);
  mem.aimErrUntilTick = ctx.tick + Math.max(1, ticks(cfg.tauErrSec));
}

/** Chest of the target displaced by the stored error (lateral along the view-right, vertical along world up). */
export function aimPoint(eye: Vec3, mem: BotMemory, target: PlayerState, out: Vec3): Vec3 {
  chestPos(target, out);
  const dx = out.x - eye.x, dz = out.z - eye.z, l = Math.hypot(dx, dz) || 1;
  out.x += (-dz / l) * mem.aimErr.x; out.z += (dx / l) * mem.aimErr.x; out.y += mem.aimErr.y;
  return out;
}

/**
 * One ENGAGE tick: aim, strafe (if allowMove), trigger. Fire gate = recognised ∧ reaction elapsed ∧ LOS (latest
 * perception pass) ∧ angle(aim, chest or head) < fireCone. Recoil control pulls the tracker's target down by
 * recoilControl × aimOffset (see the report for why it is applied to the target rather than integrated per tick).
 */
export function engageTick(ctx: ThinkContext, self: PlayerState, mem: BotMemory, cfg: DifficultyCfg, cmd: InputCommand, allowMove: boolean): void {
  const tick = ctx.tick;
  const target = player(ctx.state, mem.target);
  eyePos(self, _eye);
  const visible = !!target && target.alive && targetVisibleNow(mem, tick);
  let wantYaw = mem.aimYaw, wantPitch = mem.aimPitch, dist = 0;
  if (visible && target) {
    chestPos(target, _chest); dist = v3len(v3sub(_chest, _eye, _d));
    if (tick >= mem.aimErrUntilTick) resampleAimError(ctx, mem, cfg, target, dist);
    aimPoint(_eye, mem, target, _pt);
    wantYaw = yawTo(_eye, _pt, mem.aimYaw); wantPitch = pitchTo(_eye, _pt);
  } else if (mem.lastKnown) {
    _pt.x = mem.lastKnown.x; _pt.y = mem.lastKnown.y + 1.2; _pt.z = mem.lastKnown.z;
    wantYaw = yawTo(_eye, _pt, mem.aimYaw); wantPitch = pitchTo(_eye, _pt);
  }
  const firing = self.triggerHeld || mem.burstLeft > 0;
  if (firing) { wantPitch -= cfg.recoilControl * self.aimOffset.pitch; wantYaw -= cfg.recoilControl * self.aimOffset.yaw; }
  trackAim(mem, wantYaw, wantPitch, cfg.tauTrackSec, cfg.turnRateDeg);

  const def = activeDef(self);
  if (!visible || !target) { if (mem.burstLeft > 0) mem.burstLeft = 0; if (allowMove) strafe(ctx, self, mem, cfg, cmd, false); return; }
  dirFromYawPitch(mem.aimYaw, mem.aimPitch, _aim);
  headPos(target, _head);
  const cone = Math.min(angleBetween(_aim, v3sub(_chest, _eye, _d)), angleBetween(_aim, v3sub(_head, _eye, v3())));
  const canFire = isRecognised(mem, cfg, tick) && tick >= mem.reactionUntilTick && cone < cfg.fireConeDeg * DEG;
  // Hard: counter-strafe to a stop before a burst
  const settled = cfg.strafe !== 'counter' || horizontalSpeed(self) <= COMBAT.counterStopSpeed;
  if (allowMove) strafe(ctx, self, mem, cfg, cmd, canFire && !settled && mem.burstLeft <= 0 && tick >= mem.pauseUntilTick);
  if (self.reload) return;
  if (def.type === 'melee') { if (distXZ(self.pos, target.pos) < COMBAT.knifeRange) cmd.buttons |= Btn.FIRE; if (allowMove) setWorldMove(cmd, target.pos.x - self.pos.x, target.pos.z - self.pos.z, 1); return; }
  const slot = activeSlotState(self);
  if (!slot || slot.mag <= 0) return;
  if (def.type === 'sniper') {
    if (tick < mem.pauseUntilTick) return;
    if (self.scoped === 0 && mem.burstLeft !== 1) { cmd.buttons |= Btn.SCOPE; mem.burstLeft = 1; mem.pauseUntilTick = tick + COMBAT.awpZoomTicks; return; }
    if (canFire && settled && angleBetween(_aim, v3sub(_pt, _eye, v3())) < COMBAT.awpAimDeg * DEG) { cmd.buttons |= Btn.FIRE; mem.burstLeft = 0; mem.pauseUntilTick = tick + COMBAT.awpBoltTicks; }
    return;
  }
  if (def.auto) {
    if (mem.burstLeft > 0) { cmd.buttons |= Btn.FIRE; if (--mem.burstLeft === 0) endBurst(ctx, mem, cfg); return; }
    if (tick >= mem.pauseUntilTick && canFire && settled) {
      mem.burstLeft = burstTicks(ctx.rng.int(cfg.burst[0], cfg.burst[1]), def.rpm);
      if (cfg.strafe === 'counter') mem.peek.active = ctx.rng.chance(COMBAT.crouchP);   // Hard: crouch for this burst
      cmd.buttons |= Btn.FIRE; if (--mem.burstLeft === 0) endBurst(ctx, mem, cfg);
    }
    return;
  }
  // semi-automatic pistols: one press edge per shot at 70 % of the RPM
  if (canFire && tick >= mem.pauseUntilTick) { cmd.buttons |= Btn.FIRE; mem.pauseUntilTick = tick + Math.max(2, Math.round(3600 / (COMBAT.pistolRate * def.rpm))); }
}

function endBurst(ctx: ThinkContext, mem: BotMemory, cfg: DifficultyCfg): void {
  mem.pauseUntilTick = ctx.tick + ticks(cfg.burstPauseSec);
  if (cfg.strafe === 'peek' && !mem.peek.active && ctx.rng.chance(COMBAT.peekP)) {
    mem.peek.active = true; mem.peek.dir = ctx.rng.chance(0.5) ? 1 : -1; mem.peek.untilTick = ctx.tick + COMBAT.peekTicks;
  }
  if (cfg.strafe === 'counter' && mem.peek.dir === 0) mem.peek.dir = ctx.rng.chance(0.5) ? 1 : -1;
}

/**
 * Strafe/peek per difficulty (§6.7): Easy none; Normal 35 % strafe-peek 1.5 m out and back (peek.dir ±1 out, ±2 back);
 * Hard ADAD during pauses, counter-strafe to a stop before firing, crouch 40 % of bursts (peek.active = crouch flag).
 */
function strafe(ctx: ThinkContext, self: PlayerState, mem: BotMemory, cfg: DifficultyCfg, cmd: InputCommand, counter: boolean): void {
  const tick = ctx.tick;
  cmd.moveX = 0; cmd.moveZ = 0;
  if (cfg.strafe === 'peek') {
    if (!mem.peek.active) return;
    if (tick < mem.peek.untilTick) { cmd.moveX = Math.abs(mem.peek.dir) === 1 ? Math.sign(mem.peek.dir) : -Math.sign(mem.peek.dir); return; }
    if (Math.abs(mem.peek.dir) === 1) { mem.peek.dir = 2 * Math.sign(mem.peek.dir); mem.peek.untilTick = tick + COMBAT.peekTicks; cmd.moveX = -Math.sign(mem.peek.dir); }
    else mem.peek.active = false;
    return;
  }
  if (cfg.strafe !== 'counter') return;
  if (mem.burstLeft > 0 || counter) {
    if (mem.peek.active && mem.burstLeft > 0) cmd.buttons |= Btn.CROUCH;
    if (horizontalSpeed(self) > COMBAT.counterStopSpeed) setWorldMove(cmd, -self.vel.x, -self.vel.z, 1);
    return;
  }
  if (mem.peek.dir === 0) return;                     // no ADAD before the first burst
  if (tick >= mem.peek.untilTick) { mem.peek.dir = -Math.sign(mem.peek.dir) || 1; mem.peek.untilTick = tick + ctx.rng.int(COMBAT.strafeFlip[0], COMBAT.strafeFlip[1]); }
  cmd.moveX = Math.sign(mem.peek.dir);
}

/** Blind (§6.3): spray toward the last known target direction (or straight ahead) while the flash lasts. */
export function blindSprayTick(ctx: ThinkContext, self: PlayerState, mem: BotMemory, cfg: DifficultyCfg, cmd: InputCommand): void {
  eyePos(self, _eye);
  if (mem.lastKnown) { _pt.x = mem.lastKnown.x; _pt.y = mem.lastKnown.y + 1.2; _pt.z = mem.lastKnown.z; trackAim(mem, yawTo(_eye, _pt, mem.aimYaw), pitchTo(_eye, _pt), cfg.tauTrackSec, cfg.turnRateDeg); }
  const def = activeDef(self); const slot = activeSlotState(self);
  if (!slot || slot.mag <= 0 || self.reload) return;
  if (def.auto) cmd.buttons |= Btn.FIRE;
  else if (ctx.tick >= mem.pauseUntilTick) { cmd.buttons |= Btn.FIRE; mem.pauseUntilTick = ctx.tick + (def.type === 'sniper' ? COMBAT.awpBoltTicks : Math.max(2, Math.round(3600 / (COMBAT.pistolRate * def.rpm)))); }
}

/**
 * Slot and reload management (§6.2/§6.6): out of combat hold the best gun and reload below 25 % when no enemy has
 * been visible for 1 s (at cover: any partial mag); in combat switch to the pistol when the primary is dry and the
 * enemy is < 6 m, reload otherwise, knife when everything is empty.
 */
export function weaponUpkeep(ctx: ThinkContext, self: PlayerState, mem: BotMemory, cmd: InputCommand, mode: 'idle' | 'combat' | 'cover'): void {
  if (self.throwing || (mem.burstLeft < 0 && mem.burstLeft > THROW.used && mode !== 'combat')) return;
  const tick = ctx.tick, inv = self.inv;
  const primaryOk = !!inv.primary && inv.primary.mag + inv.primary.reserve > 0;
  const pistolOk = inv.pistol.mag + inv.pistol.reserve > 0;
  const best: Slot = primaryOk ? 1 : pistolOk ? 2 : 3;
  const noEnemy1s = mem.target === 0 || tick - mem.targetLastSeenTick >= 60;
  const slot = activeSlotState(self);
  const def = activeDef(self);
  const reload = () => { if (!self.reload) pressEdge(cmd, tick, Btn.RELOAD); };
  if (mode === 'combat') {
    const t = player(ctx.state, mem.target);
    const d = t ? distXZ(self.pos, t.pos) : 99;
    if (inv.active === 1 && inv.primary && inv.primary.mag === 0) {
      if (d < COMBAT.pistolSwitchRange && inv.pistol.mag > 0) requestSlot(self, cmd, 2);
      else if (inv.primary.reserve > 0) reload();
      else requestSlot(self, cmd, pistolOk ? 2 : 3);
    } else if (inv.active === 2 && inv.pistol.mag === 0) {
      if (inv.primary && inv.primary.mag > 0) requestSlot(self, cmd, 1);
      else if (inv.pistol.reserve > 0) reload();
      else requestSlot(self, cmd, primaryOk ? 1 : 3);
    } else if (inv.active === 3 && best !== 3 && d >= COMBAT.knifeRange) requestSlot(self, cmd, best);
    else if (inv.active === 4 && !self.throwing) requestSlot(self, cmd, best);
    else if (slot && noEnemy1s && slot.reserve > 0 && slot.mag < 0.25 * def.mag) reload();
    return;
  }
  if (inv.active !== best) requestSlot(self, cmd, best);
  if (slot && slot.reserve > 0 && noEnemy1s && (slot.mag < 0.25 * def.mag || (mode === 'cover' && slot.mag < def.mag))) reload();
}

/**
 * Effective engagement range of the bot's best loaded gun (refinement of "enemy seen → ENGAGE"): pistols/SMGs do not
 * start duels across the 40 m spawn-to-spawn mid sightline; rifles and the AWP engage at any vision range.
 */
export function engageRange(self: PlayerState): number {
  const inv = self.inv;
  const id = inv.primary && inv.primary.mag + inv.primary.reserve > 0 ? inv.primary.id : inv.pistol.mag + inv.pistol.reserve > 0 ? inv.pistol.id : 'knife';
  const t = WEAPONS[id].type;
  return t === 'sniper' ? 90 : t === 'rifle' ? 65 : id === 'deagle' ? 40 : t === 'melee' ? 20 : 30;
}

/** Plant/defuse courage rule (§6.7): Easy aborts on any sighting, Normal if the enemy is < 10 m, Hard only when uncovered. */
export function courageAbort(ctx: ThinkContext, self: PlayerState, cfg: DifficultyCfg, per: Perception): boolean {
  if (!per.best) return false;
  const t = player(ctx.state, per.best);
  if (!t) return false;
  if (cfg.courage === 'abort') return true;
  if (cfg.courage === 'abort10m') return distXZ(self.pos, t.pos) < 10;
  return !teammateWithin(ctx.state, self, 10);
}

// ───────── grenades ─────────

/** HE target (§6.6, Normal+): a heard-but-unseen group of ≥ 2 enemies within 15 m, or a known enemy on the attacked site. */
export function heTarget(ctx: ThinkContext, self: PlayerState, mem: BotMemory, cfg: DifficultyCfg): Vec3 | null {
  if (cfg.grenades === 'none' || self.inv.he <= 0) return null;
  const st = ctx.state, tick = ctx.tick, bb = st.teams[self.team];
  const ids: number[] = []; let sx = 0, sy = 0, sz = 0;
  for (const e of bb.lastEnemySeen) {
    if (!e.id || e.confidence !== 0.5 || tick - e.tick > 120 || ids.includes(e.id)) continue;
    const d = distXZ(e.pos, self.pos);
    if (d > COMBAT.heRange || d < COMBAT.heMinDist) continue;
    if (bb.lastEnemySeen.some((o) => o.id === e.id && o.confidence === 1 && tick - o.tick < 60)) continue;   // seen, not just heard
    ids.push(e.id); sx += e.pos.x; sy += e.pos.y; sz += e.pos.z;
  }
  if (ids.length >= 2) return v3(sx / ids.length, sy / ids.length, sz / ids.length);
  const site = mem.goal?.site;
  if (!site) return null;
  for (const e of bb.lastEnemySeen) {
    if (tick - e.tick > 180 || !e.id) continue;
    const d = distXZ(e.pos, self.pos);
    if (d <= COMBAT.heRange && d >= COMBAT.heMinDist && st.round.phase !== 'FREEZE' && ctx.map.areaAt(e.pos.x, e.pos.z) === (site === 'a' ? 'site_a' : 'site_b')) return copyV(e.pos);
  }
  return null;
}

/** Flash target (§6.6, Hard): the next chokepoint on the path (1.5–7 m ahead) with a known enemy within 12 m beyond it. */
export function flashTarget(ctx: ThinkContext, self: PlayerState, mem: BotMemory, cfg: DifficultyCfg): Vec3 | null {
  if (cfg.grenades !== 'he+flash' || self.inv.flash <= 0 || mem.path.length === 0) return null;
  const nav = ctx.nav, here = nav.nearest(self.pos);
  const i0 = Math.max(0, mem.path.indexOf(here));
  for (let i = i0 + 1; i < mem.path.length && i <= i0 + 8; i++) {
    const n = nav.nodes[mem.path[i]];
    const dc = distXZ(n.pos, self.pos);
    if (!n.chokepoint || dc < 1.5 || dc > 7) continue;
    for (const e of ctx.state.teams[self.team].lastEnemySeen) {
      if (ctx.tick - e.tick > 180 || distXZ(e.pos, n.pos) > COMBAT.flashRange || distXZ(e.pos, self.pos) <= dc + 1) continue;
      const dx = e.pos.x - n.pos.x, dz = e.pos.z - n.pos.z, l = Math.hypot(dx, dz) || 1;
      return v3(n.pos.x + (dx / l) * 3, n.pos.y + 1.2, n.pos.z + (dz / l) * 3);
    }
    return null;
  }
  return null;
}

export function startThrow(mem: BotMemory, kind: 'he' | 'flash', target: Vec3): void {
  mem.burstLeft = kind === 'he' ? THROW.he : THROW.flash; mem.pauseUntilTick = 0; mem.lastKnown = copyV(target);
}

/**
 * Grenade intent sequence: aim (lob pitch) → hold THROW 6 ticks → release → (flash) look away 1.6 s. Returns true
 * while it owns the bot (standing still). cmd.grenade selects HE (1) / flash (2) for the weapons lane.
 */
export function throwTick(ctx: ThinkContext, self: PlayerState, mem: BotMemory, cfg: DifficultyCfg, cmd: InputCommand): boolean {
  const tick = ctx.tick;
  cmd.moveX = 0; cmd.moveZ = 0;
  if (mem.burstLeft === THROW.after) {
    if (tick >= mem.pauseUntilTick) { mem.burstLeft = THROW.used; return false; }
    if (mem.lastKnown && mem.pauseUntilTick - tick > COMBAT.heRecoverTicks) trackAim(mem, yawTo(self.pos, mem.lastKnown, mem.aimYaw) + Math.PI, 0, 0.1, cfg.turnRateDeg);
    return true;
  }
  const kind = mem.burstLeft === THROW.he ? 'he' : 'flash';
  if (!mem.lastKnown || (kind === 'he' ? self.inv.he : self.inv.flash) <= 0) { mem.burstLeft = THROW.used; return false; }
  cmd.grenade = kind === 'he' ? 1 : 2;
  eyePos(self, _eye);
  const d = distXZ(_eye, mem.lastKnown);
  const lob = 0.5 * Math.asin(clamp((20 * d) / 144, 0, 1)) - 10 * DEG;     // 12 m/s release, g 20, +10° above aim (§4.4)
  const wantYaw = yawTo(_eye, mem.lastKnown, mem.aimYaw), wantPitch = clamp(Math.max(lob, pitchTo(_eye, mem.lastKnown)), -30 * DEG, 40 * DEG);
  trackAim(mem, wantYaw, wantPitch, 0.1, cfg.turnRateDeg);
  if (mem.pauseUntilTick === 0) {
    if (Math.abs(wrapAngle(wantYaw - mem.aimYaw)) < 4 * DEG && Math.abs(wantPitch - mem.aimPitch) < 4 * DEG) { mem.pauseUntilTick = tick + COMBAT.throwHoldTicks; cmd.buttons |= Btn.THROW; }
    return true;
  }
  if (tick < mem.pauseUntilTick) { cmd.buttons |= Btn.THROW; return true; }
  mem.burstLeft = THROW.after; mem.pauseUntilTick = tick + (kind === 'flash' ? COMBAT.flashLookAwayTicks : COMBAT.heRecoverTicks);
  return true;
}

/** Retreat cover (§6.6): the nearest cover node ≤ 10 m whose segment to the threat is blocked. */
export function retreatCover(ctx: ThinkContext, self: PlayerState, threat: Vec3): Vec3 | null {
  const n = ctx.nav.coverNear(self.pos, threat, 10);
  return n ? copyV(n.pos) : null;
}
