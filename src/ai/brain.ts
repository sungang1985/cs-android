/**
 * Bot brain (§6.2): FSM DEAD/BUY/PLAN/MOVE/HOLD/INVESTIGATE/ENGAGE/HUNT/RETREAT/PLANT/DEFUSE. think() runs every tick
 * (steering, aim, trigger); perception + FSM decisions run on ticks with tick % 6 == k % 6 (k = index in state.bots).
 * The brain is stateless and shared per difficulty; all per-bot state is BotMemory (§6.9). IdleBot/createIdleBrain
 * stay for tests and freezeBots.
 *
 * BotMemory scratch-field use by state (fields are fixed by §11.4):
 *   burstLeft   ENGAGE: ticks of FIRE left in the burst (AWP: 1 = scope requested) · BUY: 100 normal / 101 eco save /
 *               102 forced Kevlar+Deagle · PLANT/DEFUSE: hp at entry (> 20 damage rule) · MOVE/HOLD/INVESTIGATE:
 *               grenade intent (−1 HE, −2 flash, −3 after-throw, −9 used in this state)
 *   pauseUntilTick  burst pause / pistol tap / AWP zoom+bolt · grenade THROW release tick
 *   holdUntilTick   HOLD timer · RETREAT: end of the 2 s at cover (NEVER until arrived)
 *   peek        MOVE: 0.4 s chokepoint pause · ENGAGE Normal: strafe-peek (dir ±1 out, ±2 back) · ENGAGE Hard: ADAD dir +
 *               crouch-this-burst flag · DEFUSE: fake defuse (active = fake phase, untilTick = phase end)
 *   scanPhase   look-around sweep phase · lastKnown: last seen target position (also the grenade aim point)
 */
import { v3, clamp, DEG, type Vec3 } from '../core/math';
import type { BotBrain, BotBrainFactory, ThinkContext } from '../sim/brain';
import { Btn, cloneCommand, IDLE_COMMAND, type PlayerState, type BotMemory, type Team, type InputCommand, type ItemId, type Difficulty, type BotStateId, type Goal } from '../sim/state';
import type { SimEnvelope, SimEvents } from '../sim/events';
import { eyePos, horizontalSpeed } from '../world/movement';
import { ITEM_PRICES, teamRifle } from '../weapons/defs';
import { buyPlan } from '../rules/buyPlan';
import { DIFFICULTY, type DifficultyCfg } from './difficulty';
import { perceive, hearSound, upsertSighting, type Perception } from './perception';
import { planTeam, requestGoal, teamTick } from './strategy';
import { computePath, followPath, arrivedAt, setWorldMove, pathYaw, scanOffset, advanceScan, resetStuck, trackAim, yawTo, pitchTo, STEER } from './steer';
import {
  engageTick, blindSprayTick, weaponUpkeep, courageAbort, heTarget, flashTarget, startThrow, throwTick, retreatCover, pressEdge, activeDef, engageRange, THROW,
} from './combat';
import {
  NEVER, LOCAL, ticks, distXZ, copyV, player, setState, isDecisionTick, isLastAlive, teammateWithin, liveElapsed, bombRemainingSec,
  isLocalGoal, sameGoal, cloneGoal, teamPlayers, isLive, enemyOf, finite, STAGGER,
} from './common';

export const IdleBot: BotBrain = {
  think(ctx: ThinkContext, self: PlayerState, mem: BotMemory): InputCommand { void mem; const c = cloneCommand(IDLE_COMMAND, ctx.tick); c.yaw = self.yaw; c.pitch = self.pitch; return c; },
  onEvent(): void {},
  teamThink(): void {},
};

/** Day-0 random walker, kept for reference/tests. */
export const RandomBot: BotBrain = {
  think(ctx: ThinkContext, self: PlayerState, mem: BotMemory): InputCommand {
    const c = cloneCommand(IDLE_COMMAND, ctx.tick);
    if (ctx.tick % 60 === mem.id % 60) { mem.scanPhase = ctx.rng.range(-Math.PI, Math.PI); mem.burstLeft = ctx.rng.chance(0.3) ? 5 : 0; }
    c.yaw = self.yaw + (mem.scanPhase - self.yaw) * 0.05; c.pitch = self.pitch; c.moveZ = 1;
    if (mem.burstLeft > 0) { c.buttons |= Btn.FIRE; mem.burstLeft--; }
    return c;
  },
  onEvent(e: SimEnvelope, mem: BotMemory): void { void e; void mem; },
  teamThink(team: Team, ctx: ThinkContext): void { void team; void ctx; },
};

export const BRAIN = { lookTauSec: 0.12, plantSpotR: 1.2, defuseR: 1.3, ninjaSec: 12, huntLostTicks: 120, investigateMaxTicks: 15 * 60, retreatCoverTicks: 120, plantNoEnemyTicks: 90, defuseNoEnemyTicks: 60, plantAloneTicks: 20 * 60, plantTimeoutTicks: 240, chokeCooldown: 180, chokePause: 24, useLookDownDeg: 30, heCheckEvery: 4 } as const;
const BUY_CODE = { normal: 100, save: 101, force: 102 } as const;
const _eye = v3(), _p = v3();

function cfgOf(mem: BotMemory): DifficultyCfg { return DIFFICULTY[mem.profile.difficulty] ?? DIFFICULTY.normal; }
const look = (mem: BotMemory, cfg: DifficultyCfg, yaw: number, pitch: number) => trackAim(mem, yaw, pitch, BRAIN.lookTauSec, cfg.turnRateDeg);
const stand = (cmd: InputCommand) => { cmd.moveX = 0; cmd.moveZ = 0; };

/** Most recent own heard (confidence 0.5) position no older than maxAge ticks (and newer than `since`). */
function freshHeard(ctx: ThinkContext, self: PlayerState, maxAge: number, since = -NEVER): Vec3 | null {
  let best: Vec3 | null = null, bt = -NEVER;
  for (const e of ctx.state.teams[self.team].lastEnemySeen) {
    if (e.by !== self.id || e.confidence !== 0.5 || ctx.tick - e.tick > maxAge || e.tick <= since || e.tick <= bt) continue;
    best = e.pos; bt = e.tick;
  }
  return best;
}

/** CT designated defuser racing the clock: ignores enemies (ninja/hero rule, §6.8). */
function ninja(ctx: ThinkContext, self: PlayerState, mem: BotMemory): boolean {
  const st = ctx.state;
  if (self.team !== 'CT' || st.bomb.state !== 'planted' || mem.goal?.kind !== 'bomb') return false;
  const left = bombRemainingSec(st);
  if (left >= BRAIN.ninjaSec) return false;
  const travel = distXZ(self.pos, st.bomb.pos) / 4.5, defuse = self.hasKit ? 3.5 : 7;
  return travel + defuse <= left + 0.5 || distXZ(self.pos, st.bomb.pos) <= BRAIN.defuseR;
}

function plantSpotOf(ctx: ThinkContext, mem: BotMemory): Vec3 | null { const s = mem.goal?.site; return s ? ctx.map.plantSpots[s] : null; }

function holdTimer(ctx: ThinkContext, self: PlayerState, mem: BotMemory): number {
  const st = ctx.state, g = mem.goal;
  if (st.cfg.mode === 'defusal' && g && !isLocalGoal(g)) {
    if (self.team === 'CT' && g.site && g.kind === 'hold' && st.bomb.state !== 'planted') return NEVER;      // site holders stay (§6.2)
    if (st.bomb.state === 'planted' && g.kind === 'hold') return NEVER;                                      // post-plant / retake holds
    if (g.kind === 'hold' && g.holdSpot?.startsWith('lurk_')) return NEVER;                                   // lurker waits for contact
  }
  return ctx.tick + Math.max(ticks(2), Math.round(ctx.rng.range(8, 25) * mem.profile.holdPreference * 60));
}

/** Adopt a new goal and path it; HOLD in place when unreachable. */
function adopt(ctx: ThinkContext, self: PlayerState, mem: BotMemory, g: Goal, state: BotStateId = 'MOVE'): void {
  mem.goal = cloneGoal(g);
  if (!computePath(ctx, self, mem, mem.goal.pos) && distXZ(self.pos, mem.goal.pos) > 1.5) { setState(ctx, mem, 'HOLD', self); mem.holdUntilTick = ctx.tick + ticks(1); return; }
  setState(ctx, mem, state, self);
}
function doPlan(ctx: ThinkContext, self: PlayerState, mem: BotMemory): void { adopt(ctx, self, mem, requestGoal(ctx, self), 'MOVE'); }
/**
 * Heard positions sit at the sound's height (gunshot eye, wall impact, damage hit point), so hunt/investigate goals are
 * snapped to the nearest nav node (floor height, walkable): arrivedAt() needs |Δy| < 1.2 and a wall point is unreachable.
 */
export function floorGoal(ctx: ThinkContext, pos: Vec3): Vec3 { const n = ctx.nav.nodes[ctx.nav.nearest(pos)]; return copyV(n ? n.pos : pos); }
function goHunt(ctx: ThinkContext, self: PlayerState, mem: BotMemory, pos: Vec3, state: 'HUNT' | 'INVESTIGATE'): void { adopt(ctx, self, mem, { kind: 'investigate', pos: floorGoal(ctx, pos) }, state); }
/** RETREAT to a cover node; coverNear() does not check reachability, so the cover only counts with a path to it. */
function goRetreat(ctx: ThinkContext, self: PlayerState, mem: BotMemory, cover: Vec3 | null): boolean {
  if (cover && computePath(ctx, self, mem, cover)) mem.goal = { kind: 'roam', pos: cover, holdSpot: LOCAL };
  else if (self.blindUntilTick > ctx.tick) { mem.goal = null; mem.path = []; mem.corners = []; mem.pathIdx = 0; }   // blind: back off blindly
  else return false;
  setState(ctx, mem, 'RETREAT', self); mem.holdUntilTick = NEVER;
  return true;
}
function assignmentChanged(ctx: ThinkContext, self: PlayerState, mem: BotMemory): boolean {
  if (isLocalGoal(mem.goal)) return false;
  const a = ctx.state.teams[self.team].assignments[self.id];
  return !a || !sameGoal(a, mem.goal);
}

function tryGrenades(ctx: ThinkContext, self: PlayerState, mem: BotMemory, cfg: DifficultyCfg, per: Perception): void {
  if (mem.burstLeft !== 0 || per.best || !isLive(ctx.state) || cfg.grenades === 'none' || self.throwing) return;
  // heTarget simulates the throw (heAim, up to 3 grenade flights): only on every heCheckEvery-th decision pass
  const he = Math.floor(ctx.tick / STAGGER) % BRAIN.heCheckEvery === 0 ? heTarget(ctx, self, mem, cfg) : null;
  if (he) { startThrow(mem, 'he', he); return; }
  if (mem.state === 'MOVE') { const fl = flashTarget(ctx, self, mem, cfg); if (fl) startThrow(mem, 'flash', fl); }
}

/**
 * FSM decision pass (§6.2 table), run on the stagger tick with this pass's perception (tests feed stubbed perception).
 */
export function decide(ctx: ThinkContext, self: PlayerState, mem: BotMemory, cfg: DifficultyCfg, per: Perception): void {
  const st = ctx.state, tick = ctx.tick, phase = st.round.phase, tdm = st.cfg.mode !== 'defusal';
  if (phase === 'WARMUP' || phase === 'ROUND_END' || phase === 'MATCH_END') return;
  if (per.best && mem.target !== per.best) {                // stub-friendly target sync
    mem.target = per.best; mem.targetLastSeenTick = tick; if (mem.targetSeenSinceTick < 0) mem.targetSeenSinceTick = tick;
    const tp = player(st, per.best); if (tp) mem.lastKnown = copyV(tp.pos);
  }
  const seen = per.best !== 0;
  const tgt = seen ? player(st, per.best) : undefined;
  /** "enemy seen" that warrants a duel: not during FREEZE, within the gun's effective range (§6.2 refinement). */
  const fight = !!tgt && phase !== 'FREEZE' && distXZ(self.pos, tgt.pos) <= engageRange(self);
  if (self.blindUntilTick > tick) {                          // blind: 50 % spray at the last target direction, else retreat
    if (mem.state === 'ENGAGE' || mem.state === 'RETREAT' || mem.state === 'PLANT' || mem.state === 'DEFUSE' || mem.state === 'BUY') return;
    if (tdm || ((mem.lastKnown || mem.target) && ctx.rng.chance(0.5))) setState(ctx, mem, 'ENGAGE', self);
    else goRetreat(ctx, self, mem, mem.lastKnown ? retreatCover(ctx, self, mem.lastKnown) : null);
    return;
  }
  const engage = () => { setState(ctx, mem, 'ENGAGE', self); mem.aimErrUntilTick = 0; };
  switch (mem.state) {
    case 'DEAD': mem.aimYaw = self.yaw; mem.aimPitch = self.pitch; doPlan(ctx, self, mem); return;
    case 'BUY': if (phase !== 'FREEZE' || tdm) doPlan(ctx, self, mem); return;
    case 'PLAN': if (fight) { engage(); return; } doPlan(ctx, self, mem); return;
    case 'MOVE': {
      const g = mem.goal;
      if (!g) { doPlan(ctx, self, mem); return; }
      if (fight && !ninja(ctx, self, mem)) { engage(); return; }
      const heard = freshHeard(ctx, self, 90, mem.stateSinceTick);
      if (!tdm && heard && mem.profile.aggression > 0.5 && !self.hasBomb && g.kind !== 'bomb' && isLive(st)) { goHunt(ctx, self, mem, heard, 'INVESTIGATE'); return; }
      if (assignmentChanged(ctx, self, mem)) { doPlan(ctx, self, mem); return; }
      tryGrenades(ctx, self, mem, cfg, per);
      if (mem.profile.aggression < 0.4 && !mem.peek.active && tick >= mem.peek.untilTick + BRAIN.chokeCooldown && isLive(st)) {
        const n = ctx.nav.nodes[ctx.nav.nearest(self.pos)];
        if (n && n.chokepoint && !arrivedAt(self, mem, g.pos)) { mem.peek.active = true; mem.peek.dir = ctx.rng.chance(0.5) ? 1 : -1; mem.peek.untilTick = tick + BRAIN.chokePause; }
      }
      if (arrivedAt(self, mem, g.pos)) arrive(ctx, self, mem, cfg, per);
      else if (mem.corners.length === 0 && distXZ(self.pos, g.pos) > 1.5 && !computePath(ctx, self, mem, g.pos)) { setState(ctx, mem, 'HOLD', self); mem.holdUntilTick = tick + ticks(1); }
      return;
    }
    case 'HOLD': {
      if (fight && !ninja(ctx, self, mem)) { engage(); return; }
      if (self.team === 'T' && st.bomb.state === 'planted') {
        const h = freshHeard(ctx, self, 60, mem.stateSinceTick);
        if (h && distXZ(h, st.bomb.pos) < 8) { goHunt(ctx, self, mem, h, 'INVESTIGATE'); return; }
      }
      if (assignmentChanged(ctx, self, mem) || tick >= mem.holdUntilTick) { doPlan(ctx, self, mem); return; }
      tryGrenades(ctx, self, mem, cfg, per);
      return;
    }
    case 'INVESTIGATE': {
      if (fight) { engage(); return; }
      const g = mem.goal;
      if (!g || arrivedAt(self, mem, g.pos, 2) || tick - mem.stateSinceTick > BRAIN.investigateMaxTicks) { doPlan(ctx, self, mem); return; }
      const h = freshHeard(ctx, self, 30, mem.stateSinceTick);
      if (h && distXZ(h, g.pos) > 4) { mem.goal = { kind: 'investigate', pos: floorGoal(ctx, h) }; computePath(ctx, self, mem, mem.goal.pos); }
      tryGrenades(ctx, self, mem, cfg, per);
      return;
    }
    case 'ENGAGE': {
      const tp = player(st, mem.target);
      if (!tp || !tp.alive) { mem.target = 0; mem.lastKnown = null; doPlan(ctx, self, mem); return; }
      if (ninja(ctx, self, mem)) { doPlan(ctx, self, mem); return; }
      if (seen && tgt && distXZ(self.pos, tgt.pos) > engageRange(self) * 1.25) { doPlan(ctx, self, mem); return; }   // out of range: back to the objective
      if (!seen && tick - mem.targetLastSeenTick > BRAIN.huntLostTicks) {
        if (tdm || mem.lastKnown) goHunt(ctx, self, mem, mem.lastKnown ?? self.pos, 'HUNT'); else doPlan(ctx, self, mem);
        return;
      }
      if (!tdm && self.hp < cfg.retreatHp && self.lastDamage.tick >= mem.stateSinceTick && !isLastAlive(st, self)) {
        goRetreat(ctx, self, mem, retreatCover(ctx, self, mem.lastKnown ?? tp.pos));
      }
      return;
    }
    case 'HUNT': {
      if (fight) { engage(); return; }
      const g = mem.goal;
      if (!g || arrivedAt(self, mem, g.pos, 1.5) || tick - mem.targetLastSeenTick > 6 * 60) doPlan(ctx, self, mem);
      return;
    }
    case 'RETREAT': {
      const g = mem.goal;
      if (!g) { doPlan(ctx, self, mem); return; }
      if (arrivedAt(self, mem, g.pos) || mem.corners.length === 0) {
        if (mem.holdUntilTick >= NEVER) mem.holdUntilTick = tick + BRAIN.retreatCoverTicks;
        else if (tick >= mem.holdUntilTick) { setState(ctx, mem, 'HOLD', self); mem.holdUntilTick = holdTimer(ctx, self, mem); }
      }
      return;
    }
    case 'PLANT': {
      if (st.bomb.state === 'planted' || !self.hasBomb) { doPlan(ctx, self, mem); return; }
      if (cfg.courage !== 'covered' && mem.burstLeft - self.hp > 20) { if (seen) engage(); else doPlan(ctx, self, mem); return; }
      if (seen && courageAbort(ctx, self, cfg, per)) { engage(); return; }
      if (tick - mem.stateSinceTick > BRAIN.plantTimeoutTicks && self.use.action !== 'plant') doPlan(ctx, self, mem);
      return;
    }
    case 'DEFUSE': {
      if (st.bomb.state !== 'planted') { doPlan(ctx, self, mem); return; }
      if (seen && bombRemainingSec(st) >= BRAIN.ninjaSec && courageAbort(ctx, self, cfg, per)) { engage(); return; }
      if (distXZ(self.pos, st.bomb.pos) > 1.5) adopt(ctx, self, mem, st.bomb.site ? { kind: 'bomb', pos: copyV(st.bomb.pos), site: st.bomb.site } : { kind: 'bomb', pos: copyV(st.bomb.pos) }, 'MOVE');
      return;
    }
  }
}

/** MOVE arrival (§6.2/§6.8): staged goals advance; carrier plants; designated CT defuses; holds start. */
function arrive(ctx: ThinkContext, self: PlayerState, mem: BotMemory, cfg: DifficultyCfg, per: Perception): void {
  const st = ctx.state, tick = ctx.tick, g = mem.goal!;
  if (!isLocalGoal(g)) { const ng = requestGoal(ctx, self); if (!sameGoal(ng, g)) { adopt(ctx, self, mem, ng); return; } }
  if (st.cfg.mode !== 'defusal') { setState(ctx, mem, 'HOLD', self); mem.holdUntilTick = tick + ticks(1); return; }
  const spot = plantSpotOf(ctx, mem);
  if (self.hasBomb && g.kind === 'site' && spot && distXZ(self.pos, spot) <= BRAIN.plantSpotR) {
    const quiet = per.best === 0 && tick - mem.targetLastSeenTick >= BRAIN.plantNoEnemyTicks;
    if (st.round.phase === 'LIVE' && quiet && (teammateWithin(st, self, 10) || liveElapsed(st) >= BRAIN.plantAloneTicks)) { setState(ctx, mem, 'PLANT', self); mem.burstLeft = self.hp; }
    return;                                                    // wait at the spot otherwise
  }
  if (self.team === 'CT' && g.kind === 'bomb') {
    if (st.bomb.state !== 'planted') { doPlan(ctx, self, mem); return; }
    if (distXZ(self.pos, st.bomb.pos) <= BRAIN.defuseR && (tick - mem.targetLastSeenTick >= BRAIN.defuseNoEnemyTicks || bombRemainingSec(st) < BRAIN.ninjaSec)) startDefuse(ctx, self, mem, cfg);
    return;
  }
  if (g.kind === 'bomb') { if (st.bomb.state !== 'dropped') doPlan(ctx, self, mem); return; }   // T: walk over it (auto pickup)
  if (g.kind === 'investigate') { doPlan(ctx, self, mem); return; }
  setState(ctx, mem, 'HOLD', self); mem.holdUntilTick = holdTimer(ctx, self, mem);
}

function startDefuse(ctx: ThinkContext, self: PlayerState, mem: BotMemory, cfg: DifficultyCfg): void {
  setState(ctx, mem, 'DEFUSE', self); mem.burstLeft = self.hp;
  const enemies = ctx.state.players.some((p) => p.alive && p.team !== self.team);
  if (cfg.fakeDefuseP > 0 && enemies && bombRemainingSec(ctx.state) > BRAIN.ninjaSec + 7 && ctx.rng.chance(cfg.fakeDefuseP)) { mem.peek.active = true; mem.peek.dir = 0; mem.peek.untilTick = ctx.tick + 60; }
}

// ───────── per-tick behaviour ─────────

function holdFacing(ctx: ThinkContext, self: PlayerState, mem: BotMemory): number {
  const st = ctx.state, g = mem.goal;
  if (g?.holdSpot) { const h = ctx.map.holdSpots.find((s) => s.id === g.holdSpot); if (h) return h.yaw; }
  if (mem.lastKnown && ctx.tick - mem.targetLastSeenTick < 6 * 60) return yawTo(self.pos, mem.lastKnown, self.yaw);
  const bb = st.teams[self.team];
  if (self.team === 'CT' && bb.bombPos && st.bomb.state !== 'none') return yawTo(self.pos, bb.bombPos, self.yaw);
  return yawTo(self.pos, ctx.map.spawns[enemyOf(self.team)][0].pos, self.yaw);
}

function useHold(cmd: InputCommand, self: PlayerState, action: 'plant' | 'defuse', tick: number): void {
  if (self.use.action === action) cmd.buttons |= Btn.USE; else pressEdge(cmd, tick, Btn.USE);
}

function moveTick(ctx: ThinkContext, self: PlayerState, mem: BotMemory, cfg: DifficultyCfg, cmd: InputCommand): void {
  const st = ctx.state, tick = ctx.tick, g = mem.goal;
  if (!g || st.round.phase === 'FREEZE') { stand(cmd); if (g) look(mem, cfg, pathYaw(self, mem, g.pos), 0); resetStuck(mem, self); return; }
  const ownSpawn = self.team === 'T' ? 't_spawn' : 'ct_spawn';
  const area = ctx.map.areaAt(self.pos.x, self.pos.z);
  const waiting = mem.state === 'MOVE' && g.untilTick !== undefined && tick < g.untilTick && area !== null && area !== ownSpawn;
  const carrierWait = mem.state === 'MOVE' && self.hasBomb && g.kind === 'site' && arrivedAt(self, mem, g.pos);
  const choke = mem.state === 'MOVE' && mem.peek.active;
  if (choke && tick >= mem.peek.untilTick) mem.peek.active = false;
  const heard = freshHeard(ctx, self, 60);
  if (waiting || carrierWait || (choke && mem.peek.active)) {
    stand(cmd); resetStuck(mem, self);
    const base = heard ? yawTo(self.pos, heard, self.yaw) : pathYaw(self, mem, g.pos);
    look(mem, cfg, base + scanOffset(mem, choke ? 35 : STEER.scanDeg), 0);
    return;
  }
  const walk = (mem.state === 'INVESTIGATE' || mem.state === 'HUNT') && mem.profile.aggression < 0.5;
  // look first so the body-local move uses this tick's yaw
  eyePos(self, _eye);
  if ((mem.state === 'HUNT' || mem.state === 'INVESTIGATE') && distXZ(self.pos, g.pos) < 8) { _p.x = g.pos.x; _p.y = g.pos.y + 1.2; _p.z = g.pos.z; look(mem, cfg, yawTo(_eye, _p, mem.aimYaw), pitchTo(_eye, _p)); }
  else if (heard) look(mem, cfg, yawTo(self.pos, heard, self.yaw), 0);
  else look(mem, cfg, pathYaw(self, mem, g.pos) + scanOffset(mem, STEER.scanDeg), 0);
  cmd.yaw = mem.aimYaw;
  followPath(ctx, self, mem, g.pos, cmd, walk);
}

function holdTick(ctx: ThinkContext, self: PlayerState, mem: BotMemory, cfg: DifficultyCfg, cmd: InputCommand): void {
  const tick = ctx.tick, g = mem.goal;
  const spot = g?.holdSpot ? ctx.map.holdSpots.find((s) => s.id === g.holdSpot) : undefined;
  const heard = freshHeard(ctx, self, 60);
  look(mem, cfg, (heard ? yawTo(self.pos, heard, self.yaw) : holdFacing(ctx, self, mem)) + scanOffset(mem, STEER.holdScanDeg), 0);
  cmd.yaw = mem.aimYaw;
  if (g && distXZ(self.pos, g.pos) > 0.6 && distXZ(self.pos, g.pos) < 3 && ctx.state.round.phase !== 'FREEZE') setWorldMove(cmd, g.pos.x - self.pos.x, g.pos.z - self.pos.z, STEER.walkMag);
  else stand(cmd);
  if (spot?.crouch) cmd.buttons |= Btn.CROUCH;
  if (activeDef(self).type === 'sniper' && self.scoped === 0 && tick - mem.stateSinceTick < 30) pressEdge(cmd, tick, Btn.SCOPE);
}

function act(ctx: ThinkContext, self: PlayerState, mem: BotMemory, cfg: DifficultyCfg, cmd: InputCommand): void {
  const st = ctx.state, tick = ctx.tick;
  advanceScan(mem, mem.state === 'HOLD');
  let mode: 'idle' | 'combat' | 'cover' = 'idle';
  const nonCombat = mem.state === 'MOVE' || mem.state === 'HOLD' || mem.state === 'INVESTIGATE';
  if (nonCombat && mem.burstLeft < 0 && mem.burstLeft > THROW.used && throwTick(ctx, self, mem, cfg, cmd)) return;
  switch (mem.state) {
    case 'PLAN': case 'BUY': stand(cmd); break;
    case 'MOVE': case 'INVESTIGATE': case 'HUNT': moveTick(ctx, self, mem, cfg, cmd); break;
    case 'HOLD': holdTick(ctx, self, mem, cfg, cmd); break;
    case 'ENGAGE':
      mode = 'combat';
      if (self.blindUntilTick > tick) { stand(cmd); blindSprayTick(ctx, self, mem, cfg, cmd); }
      else engageTick(ctx, self, mem, cfg, cmd, true);
      break;
    case 'RETREAT': {
      mode = 'cover';
      const g = mem.goal;
      if (!g) { if (self.blindUntilTick > tick) { cmd.moveX = 0; cmd.moveZ = -1; } else stand(cmd); break; }
      eyePos(self, _eye);
      if (mem.lastKnown) { _p.x = mem.lastKnown.x; _p.y = mem.lastKnown.y + 1.2; _p.z = mem.lastKnown.z; look(mem, cfg, yawTo(_eye, _p, mem.aimYaw), pitchTo(_eye, _p)); }
      else look(mem, cfg, pathYaw(self, mem, g.pos), 0);
      cmd.yaw = mem.aimYaw;
      if (followPath(ctx, self, mem, g.pos, cmd, false) || mem.holdUntilTick < NEVER) { stand(cmd); cmd.buttons |= Btn.CROUCH; }
      if (self.blindUntilTick <= tick && mem.target && mem.targetSeenSinceTick >= 0) { const mx = cmd.moveX, mz = cmd.moveZ; engageTick(ctx, self, mem, cfg, cmd, false); cmd.moveX = mx; cmd.moveZ = mz; }
      break;
    }
    case 'PLANT': {
      stand(cmd); look(mem, cfg, mem.aimYaw, -BRAIN.useLookDownDeg * DEG);         // shallow so the 90° vertical FOV still covers enemies
      if (horizontalSpeed(self) <= 0.4) useHold(cmd, self, 'plant', tick);
      break;
    }
    case 'DEFUSE': {
      stand(cmd);
      const b = st.bomb.pos; eyePos(self, _eye);
      look(mem, cfg, yawTo(_eye, b, mem.aimYaw), Math.max(-BRAIN.useLookDownDeg * DEG, pitchTo(_eye, b)));
      if (distXZ(self.pos, b) > BRAIN.defuseR) { cmd.yaw = mem.aimYaw; setWorldMove(cmd, b.x - self.pos.x, b.z - self.pos.z, STEER.walkMag); break; }
      if (mem.peek.active) { if (tick >= mem.peek.untilTick) { mem.peek.active = false; mem.peek.untilTick = tick + 30; } else { useHold(cmd, self, 'defuse', tick); break; } }
      if (tick < mem.peek.untilTick) { look(mem, cfg, holdFacing(ctx, self, mem), 0); break; }   // fake defuse: release and re-check
      if (horizontalSpeed(self) <= 0.4) useHold(cmd, self, 'defuse', tick);
      break;
    }
    default: stand(cmd);
  }
  if (self.scoped && mode === 'idle' && mem.state !== 'HOLD') pressEdge(cmd, tick, Btn.SCOPE);
  weaponUpkeep(ctx, self, mem, cmd, mode);
}

// ───────── buying (§5.2, §6.7) ─────────

function isLastRoundOfHalf(ctx: ThinkContext): boolean {
  const r = ctx.state.round, n = ctx.state.cfg.roundsToWin;
  return r.half === 1 ? r.roundNumber === n - 1 : r.roundNumber === 2 * (n - 1);
}
function lossStreak(ctx: ThinkContext, team: Team): number { return team === 'T' ? ctx.state.round.lossStreakT : ctx.state.round.lossStreakCT; }
/** Team eco rule: average money < $2,000 and nobody can afford a rifle → save (or Kevlar + Deagle at loss streak ≥ 2). */
export function ecoDecision(ctx: ThinkContext, team: Team): number {
  const ps = teamPlayers(ctx.state, team);
  if (!ps.length) return BUY_CODE.normal;
  const avg = ps.reduce((s, p) => s + p.money, 0) / ps.length;
  const rifle = ITEM_PRICES[teamRifle(team)];
  if (avg < 2000 && !ps.some((p) => p.money >= rifle)) return lossStreak(ctx, team) >= 2 ? BUY_CODE.force : BUY_CODE.save;
  return BUY_CODE.normal;
}
/** The next item this bot buys this tick (one per tick), or null when done. */
export function nextBuy(ctx: ThinkContext, self: PlayerState, mem: BotMemory): ItemId | null {
  if (mem.burstLeft === BUY_CODE.save) return null;
  if (mem.burstLeft === BUY_CODE.force) {
    if (self.armor < 100 && self.money >= ITEM_PRICES.kevlar) return 'kevlar';
    if (self.inv.pistol.id !== 'deagle' && self.money >= ITEM_PRICES.deagle) return 'deagle';
    return null;
  }
  const teamHasAwp = ctx.state.players.some((p) => p.team === self.team && p.id !== self.id && p.inv.primary?.id === 'awp');
  const plan = buyPlan(self.money, self.team, { ...self.inv, armor: self.armor, helmet: self.helmet, hasKit: self.hasKit }, { sniper: mem.profile.preferredWeapon === 'awp' }, lossStreak(ctx, self.team), teamHasAwp, isLastRoundOfHalf(ctx));
  return plan.length ? plan[0] : null;
}
function buyTick(ctx: ThinkContext, self: PlayerState, mem: BotMemory, cmd: InputCommand): void {
  const tick = ctx.tick;
  if (tick === mem.stateSinceTick || mem.burstLeft < BUY_CODE.normal || mem.burstLeft > BUY_CODE.force) {
    mem.burstLeft = ecoDecision(ctx, self.team);
    mem.aimYaw = self.yaw; mem.aimPitch = self.pitch; mem.peek.active = false; mem.target = 0; mem.lastKnown = null; mem.targetSeenSinceTick = -1;
    if (tick === mem.stateSinceTick) ctx.out.emit('botState', { bot: mem.id, state: 'BUY' });
  }
  mem.aimYaw = self.yaw; mem.aimPitch = self.pitch;
  const item = ctx.state.round.phase === 'FREEZE' && ctx.state.cfg.mode === 'defusal' && tick - mem.stateSinceTick < 16 ? nextBuy(ctx, self, mem) : null;
  if (item) cmd.buy = item; else setState(ctx, mem, 'PLAN', self);
}
/** TDM: free loadout on (re)spawn — preferred primary + Kevlar & helmet (economy is off, §2.3). */
function tdmLoadout(self: PlayerState, mem: BotMemory): ItemId | null {
  if (!self.inv.primary) return mem.profile.preferredWeapon === 'awp' ? 'awp' : mem.profile.preferredWeapon === 'smg' ? 'mp5' : teamRifle(self.team);
  if (self.armor < 100 || !self.helmet) return 'kevlar_helmet';
  return null;
}

// ───────── BotBrain ─────────

function think(ctx: ThinkContext, self: PlayerState, mem: BotMemory): InputCommand {
  const cmd = cloneCommand(IDLE_COMMAND, ctx.tick);
  cmd.yaw = self.yaw; cmd.pitch = self.pitch;
  if (!self.alive) return cmd;
  const st = ctx.state, tick = ctx.tick, phase = st.round.phase;
  const cfg = cfgOf(mem);
  if (!Number.isFinite(mem.aimYaw) || !Number.isFinite(mem.aimPitch)) { mem.aimYaw = self.yaw; mem.aimPitch = self.pitch; }
  if (phase === 'WARMUP' || phase === 'ROUND_END' || phase === 'MATCH_END') { mem.aimYaw = self.yaw; mem.aimPitch = self.pitch; return cmd; }
  if (mem.state === 'BUY') { buyTick(ctx, self, mem, cmd); return finish(cmd, mem, self); }
  if (mem.state === 'DEAD') { mem.aimYaw = self.yaw; mem.aimPitch = self.pitch; setState(ctx, mem, 'PLAN', self); }
  // TDM respawn (rules/modes/tdm.ts) puts the bot straight into PLAN with no goal on the respawn tick: resync the aim
  // to the freshly placed body, or cmd.yaw would snap it back to the facing it died with
  else if (mem.state === 'PLAN' && mem.goal === null && tick === mem.stateSinceTick) { mem.aimYaw = self.yaw; mem.aimPitch = self.pitch; }
  if (isDecisionTick(st, mem, tick)) decide(ctx, self, mem, cfg, perceive(ctx, self, mem, cfg));
  act(ctx, self, mem, cfg, cmd);
  if (st.cfg.mode === 'tdm' && tick % 10 === 0 && !cmd.buy) cmd.buy = tdmLoadout(self, mem);
  return finish(cmd, mem, self);
}

function finish(cmd: InputCommand, mem: BotMemory, self: PlayerState): InputCommand {
  cmd.yaw = finite(mem.aimYaw, self.yaw);
  cmd.pitch = clamp(finite(mem.aimPitch, 0), -89 * DEG, 89 * DEG);
  let mx = finite(cmd.moveX), mz = finite(cmd.moveZ);
  const l = Math.hypot(mx, mz); if (l > 1) { mx /= l; mz /= l; }
  cmd.moveX = mx; cmd.moveZ = mz;
  return cmd;
}

function onEvent(e: SimEnvelope, mem: BotMemory, self: PlayerState, ctx: ThinkContext): void {
  const st = ctx.state, bb = st.teams[self.team];
  switch (e.type) {
    case 'sound': hearSound(e.data as SimEvents['sound'], self, ctx, cfgOf(mem)); break;
    case 'death': {
      const d = e.data as SimEvents['death'];
      if (mem.target === d.victim) { mem.target = 0; mem.lastKnown = null; mem.targetSeenSinceTick = -1; }
      bb.lastEnemySeen = bb.lastEnemySeen.filter((x) => x.id !== d.victim);
      break;
    }
    case 'bombPlanted': { const d = e.data as SimEvents['bombPlanted']; bb.bombPos = copyV(d.pos); break; }
    case 'bombDrop': { const d = e.data as SimEvents['bombDrop']; if (self.team === 'CT') bb.bombPos = copyV(d.pos); break; }
    case 'damageTaken': {
      const d = e.data as SimEvents['damageTaken'];
      if (d.victim === self.id && (mem.target === 0 || mem.targetSeenSinceTick < 0)) upsertSighting(bb, 0, d.from, ctx.tick, 0.5, self.id);
      break;
    }
  }
}

function makeBrain(): BotBrain {
  return { think, onEvent, teamThink(team: Team, ctx: ThinkContext): void {
    for (const m of ctx.state.bots) {
      const p = player(ctx.state, m.id);
      if (p && p.team === team && !p.alive && m.state !== 'DEAD') { setState(ctx, m, 'DEAD'); m.goal = null; m.path = []; m.corners = []; m.pathIdx = 0; m.target = 0; }
    }
    teamTick(team, ctx);
  } };
}

/** §11.8: one shared, stateless brain instance per difficulty. */
export function createBotBrain(): BotBrainFactory {
  const inst: Record<Difficulty, BotBrain> = { easy: makeBrain(), normal: makeBrain(), hard: makeBrain() };
  return (d: Difficulty) => inst[d] ?? inst.normal;
}
export function createIdleBrain(): BotBrainFactory { return () => IdleBot; }
export { planTeam };
