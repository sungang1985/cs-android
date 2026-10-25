/**
 * Perception (§6.3): FOV cone, vision range, LOS (head OR chest, 3 nearest in-FOV enemies), continuous-visibility
 * recognition, sampled reaction, 6 s memory, 0.5 s callout to the team blackboard, hearing via `sound` events
 * (confidence 0.5), blindness. `perceive()` runs on the bot's stagger tick and updates the target fields of
 * BotMemory; `hearSound()` is called from BotBrain.onEvent and only writes the team blackboard.
 */
import { v3, v3sub, v3len, yawFromDir, pitchFromDir, wrapAngle, DEG, type Vec3 } from '../core/math';
import type { ThinkContext } from '../sim/brain';
import type { PlayerState, BotMemory, EntityId, Blackboard, WorldState } from '../sim/state';
import type { SimEvents } from '../sim/events';
import { eyePos } from '../world/movement';
import type { DifficultyCfg } from './difficulty';
import { chestPos, headPos, copyV, ticks, player, SEC } from './common';

export interface Perception { visible: { id: EntityId; dist: number; angle: number; seenSinceTick: number }[]; best: EntityId | 0; heard: { pos: Vec3; tick: number; loudness: number }[]; threatDir: Vec3 | null }

export const PERCEPTION = {
  fovHalfH: 60 * DEG, fovHalfV: 45 * DEG, losChecks: 3,
  memoryTicks: 6 * SEC, shareTicks: Math.round(0.5 * SEC), heardTicks: Math.round(1.5 * SEC),
} as const;

export function recognitionTicks(cfg: DifficultyCfg): number { return ticks(cfg.recognitionSec); }
/** Recognised = the tracked target has been continuously visible for ≥ recognition delay. */
export function isRecognised(mem: BotMemory, cfg: DifficultyCfg, tick: number): boolean {
  return mem.target !== 0 && mem.targetSeenSinceTick >= 0 && tick - mem.targetSeenSinceTick >= recognitionTicks(cfg);
}
/** Target visible at the latest perception pass (passes are ≤ 6 ticks apart). */
export function targetVisibleNow(mem: BotMemory, tick: number): boolean { return mem.target !== 0 && mem.targetSeenSinceTick >= 0 && tick - mem.targetLastSeenTick <= 6; }

const _eye = v3(), _chest = v3(), _head = v3(), _d = v3();

export function perceive(ctx: ThinkContext, self: PlayerState, mem: BotMemory, cfg: DifficultyCfg): Perception {
  const st = ctx.state, tick = ctx.tick;
  const per: Perception = { visible: [], best: 0, heard: [], threatDir: null };
  eyePos(self, _eye);
  if (self.blindUntilTick > tick) {                         // blind: perception off (§6.3)
    mem.targetSeenSinceTick = -1;
    if (mem.lastKnown) per.threatDir = dirTo(_eye, mem.lastKnown);
    return per;
  }
  // 1. FOV + range for every alive enemy (ascending id), then LOS for the 3 nearest
  const inFov: { p: PlayerState; dist: number; angle: number }[] = [];
  for (const p of st.players) {
    if (!p.alive || p.team === self.team) continue;
    chestPos(p, _chest); v3sub(_chest, _eye, _d);
    const dist = v3len(_d);
    if (dist > cfg.visionM || dist < 1e-4) continue;
    const dh = Math.abs(wrapAngle(yawFromDir(_d) - self.yaw)), dv = Math.abs(pitchFromDir(_d) - self.pitch);
    if (dh > PERCEPTION.fovHalfH || dv > PERCEPTION.fovHalfV) continue;
    inFov.push({ p, dist, angle: Math.max(dh, dv) });
  }
  inFov.sort((a, b) => a.dist - b.dist || a.p.id - b.p.id);
  for (let i = 0; i < inFov.length && i < PERCEPTION.losChecks; i++) {
    const c = inFov[i];
    if (!ctx.world.lineOfSight(_eye, headPos(c.p, _head)) && !ctx.world.lineOfSight(_eye, chestPos(c.p, _chest))) continue;
    per.visible.push({ id: c.p.id, dist: c.dist, angle: c.angle, seenSinceTick: tick });
  }
  // 2. Target tracking: keep the current target while visible, else switch to the nearest visible enemy
  const cur = per.visible.find((v) => v.id === mem.target);
  if (!cur && per.visible.length) {
    if (mem.target !== per.visible[0].id) { mem.target = per.visible[0].id; mem.targetSeenSinceTick = -1; }
  }
  const tv = per.visible.find((v) => v.id === mem.target);
  const tp = player(st, mem.target);
  if (tv && tp) {
    if (mem.targetSeenSinceTick < 0) mem.targetSeenSinceTick = tick;   // continuity starts now
    tv.seenSinceTick = mem.targetSeenSinceTick;
    mem.targetLastSeenTick = tick;
    mem.lastKnown = copyV(tp.pos);
    const recog = recognitionTicks(cfg);
    if (tick - mem.targetSeenSinceTick >= recog) {
      // reaction sampled once per recognition, measured from the exact recognition time (not the pass tick)
      if (mem.reactionUntilTick < mem.targetSeenSinceTick) mem.reactionUntilTick = mem.targetSeenSinceTick + recog + Math.max(0, Math.round(ctx.rng.gauss(cfg.reactionSec, 0.2 * cfg.reactionSec) * SEC));
      per.best = mem.target;
      ctx.out.emit('spotted', { team: self.team, enemy: tp.id, pos: copyV(tp.pos), by: self.id });
      if (tick - mem.targetSeenSinceTick >= PERCEPTION.shareTicks) upsertSighting(st.teams[self.team], tp.id, tp.pos, tick, 1, self.id);
    }
  } else {
    mem.targetSeenSinceTick = -1;
    if (mem.target !== 0 && (!tp || !tp.alive || tick - mem.targetLastSeenTick > PERCEPTION.memoryTicks)) { mem.target = 0; mem.lastKnown = null; }
  }
  // 3. Hearing memory (own 0.5-confidence entries) and threat direction
  for (const e of st.teams[self.team].lastEnemySeen) {
    if (e.by !== self.id || e.confidence !== 0.5 || tick - e.tick > PERCEPTION.heardTicks) continue;
    per.heard.push({ pos: copyV(e.pos), tick: e.tick, loudness: Math.hypot(e.pos.x - self.pos.x, e.pos.z - self.pos.z) });
  }
  per.heard.sort((a, b) => b.tick - a.tick);
  if (per.best && tp) per.threatDir = dirTo(_eye, chestPos(tp, _chest));
  else if (mem.lastKnown && tick - mem.targetLastSeenTick <= PERCEPTION.memoryTicks) per.threatDir = dirTo(_eye, mem.lastKnown);
  else if (per.heard.length) per.threatDir = dirTo(_eye, per.heard[0].pos);
  return per;
}

function dirTo(from: Vec3, to: Vec3): Vec3 { const d = v3(to.x - from.x, to.y - from.y, to.z - from.z); const l = v3len(d) || 1; d.x /= l; d.y /= l; d.z /= l; return d; }

/** Upsert one blackboard entry keyed by (enemy id, reporting bot). Sightings outrank recent sounds. */
export function upsertSighting(bb: Blackboard, id: EntityId, pos: Vec3, tick: number, confidence: 0.5 | 1, by: EntityId): void {
  const e = bb.lastEnemySeen.find((x) => x.id === id && x.by === by);
  if (e) {
    if (confidence === 0.5 && e.confidence === 1 && tick - e.tick < 30) return;
    e.pos = copyV(pos); e.tick = tick; e.confidence = confidence;
  } else bb.lastEnemySeen.push({ id, pos: copyV(pos), tick, confidence, by });
}
export function pruneBlackboard(bb: Blackboard, tick: number, state: WorldState): void {
  bb.lastEnemySeen = bb.lastEnemySeen.filter((e) => tick - e.tick <= PERCEPTION.memoryTicks && (e.id === 0 || player(state, e.id)?.alive === true));
}

/** Hearing (§6.3, §11.5): audible if dist ≤ loudness × hearingMult and the emitter is an alive enemy (or unknown, player 0). */
export function hearSound(e: SimEvents['sound'], self: PlayerState, ctx: ThinkContext, cfg: DifficultyCfg): boolean {
  if (e.player === self.id) return false;
  let id: EntityId = 0;
  if (e.player) {
    const src = player(ctx.state, e.player);
    if (!src || src.team === self.team || !src.alive) return false;
    // impacts / whizzes locate the bullet, not the shooter: keep them as an unknown-source noise
    id = e.id.startsWith('impact_') || e.id === 'bullet_whiz' ? 0 : src.id;
  }
  const d = Math.hypot(e.pos.x - self.pos.x, e.pos.y - self.pos.y, e.pos.z - self.pos.z);
  if (d > e.loudness * cfg.hearingMult) return false;
  upsertSighting(ctx.state.teams[self.team], id, e.pos, ctx.tick, 0.5, self.id);
  return true;
}
