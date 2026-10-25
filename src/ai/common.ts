/**
 * Small shared helpers for the bot AI (§6). Pure; every per-bot value lives in BotMemory (§6.9).
 * Conventions used across ai/:
 *  - "forever" is NEVER (a finite tick, so JSON round-trips keep it; Infinity would become null).
 *  - Goal.holdSpot === LOCAL marks a bot-local goal (retreat cover, hunt, pickup) that is not a team assignment.
 */
import { v3, type Vec3 } from '../core/math';
import type { ThinkContext } from '../sim/brain';
import { TICKS_PER_SEC, type PlayerState, type BotMemory, type Team, type WorldState, type Goal, type BotStateId, type EntityId } from '../sim/state';
import { findPlayer } from '../sim/entities';
import { MODES } from '../rules/modes';

export const NEVER = 1_000_000_000;
export const LOCAL = '';
export const SEC = TICKS_PER_SEC;
/** Perception/decision stagger period (§6.2). */
export const STAGGER = 6;
/** Body points used by perception and aiming (match sim/candidates.ts and the hitscan hitboxes). */
export const CHEST_Y = { stand: 1.2, crouch: 0.85 } as const;
export const HEAD_Y = { stand: 1.6, crouch: 1.1 } as const;

export function ticks(sec: number): number { return Math.round(sec * SEC); }
export function chestPos(p: Pick<PlayerState, 'pos' | 'crouched'>, out: Vec3 = v3()): Vec3 { out.x = p.pos.x; out.y = p.pos.y + (p.crouched ? CHEST_Y.crouch : CHEST_Y.stand); out.z = p.pos.z; return out; }
export function headPos(p: Pick<PlayerState, 'pos' | 'crouched'>, out: Vec3 = v3()): Vec3 { out.x = p.pos.x; out.y = p.pos.y + (p.crouched ? HEAD_Y.crouch : HEAD_Y.stand); out.z = p.pos.z; return out; }
export function distXZ(a: Vec3, b: Vec3): number { return Math.hypot(a.x - b.x, a.z - b.z); }
export function copyV(a: Vec3): Vec3 { return v3(a.x, a.y, a.z); }
export function finite(n: number, fallback = 0): number { return Number.isFinite(n) ? n : fallback; }
export function enemyOf(t: Team): Team { return t === 'T' ? 'CT' : 'T'; }

/** Index k of the bot in state.bots[] (stagger key, §6.2). */
export function botIndex(state: WorldState, mem: BotMemory): number {
  const i = state.bots.indexOf(mem);
  return i >= 0 ? i : state.bots.findIndex((m) => m.id === mem.id);
}
export function isDecisionTick(state: WorldState, mem: BotMemory, tick: number): boolean { return tick % STAGGER === botIndex(state, mem) % STAGGER; }

export function teamPlayers(state: WorldState, team: Team): PlayerState[] { return state.players.filter((p) => p.team === team); }
export function aliveCount(state: WorldState, team: Team): number { let n = 0; for (const p of state.players) if (p.alive && p.team === team) n++; return n; }
export function isLastAlive(state: WorldState, self: PlayerState): boolean { return aliveCount(state, self.team) <= 1; }
export function teammateWithin(state: WorldState, self: PlayerState, r: number): boolean {
  for (const p of state.players) if (p.alive && p.team === self.team && p.id !== self.id && distXZ(p.pos, self.pos) <= r) return true;
  return false;
}
export function memOf(state: WorldState, id: EntityId): BotMemory | undefined { return state.bots.find((m) => m.id === id); }
export function player(state: WorldState, id: EntityId): PlayerState | undefined { return id ? findPlayer(state, id) : undefined; }

/** Tick at which LIVE started (or will start, during FREEZE); null outside FREEZE/LIVE. */
export function liveStartTick(state: WorldState): number | null {
  const r = state.round; const mode = MODES[state.cfg.mode];
  if (r.phase === 'FREEZE') return r.phaseEndsTick;
  if (r.phase === 'LIVE') return r.phaseEndsTick - ticks(mode.liveSec);
  return null;
}
/** Ticks since LIVE began (negative during FREEZE; large after LIVE). */
export function liveElapsed(state: WorldState): number {
  const s = liveStartTick(state);
  if (s === null) return state.round.phase === 'PLANTED' || state.round.phase === 'SUDDEN_DEATH' ? NEVER : -NEVER;
  return state.tick - s;
}
/** Seconds of round time left in the current phase. */
export function roundRemainingSec(state: WorldState): number { return Math.max(0, (state.round.phaseEndsTick - state.tick) / SEC); }
/** Seconds until the planted bomb explodes (∞-like when not planted). */
export function bombRemainingSec(state: WorldState): number {
  return state.bomb.state === 'planted' ? Math.max(0, (state.bomb.explodeTick - state.tick) / SEC) : NEVER;
}
export function isLive(state: WorldState): boolean { const p = state.round.phase; return p === 'LIVE' || p === 'PLANTED' || p === 'SUDDEN_DEATH'; }

export function cloneGoal(g: Goal): Goal {
  const c: Goal = { kind: g.kind, pos: copyV(g.pos) };
  if (g.holdSpot !== undefined) c.holdSpot = g.holdSpot;
  if (g.site !== undefined) c.site = g.site;
  if (g.untilTick !== undefined) c.untilTick = g.untilTick;
  return c;
}
export function sameGoal(a: Goal | null | undefined, b: Goal | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return a.kind === b.kind && (a.holdSpot ?? null) === (b.holdSpot ?? null) && (a.site ?? null) === (b.site ?? null) && (a.untilTick ?? null) === (b.untilTick ?? null)
    && Math.abs(a.pos.x - b.pos.x) < 0.01 && Math.abs(a.pos.y - b.pos.y) < 0.01 && Math.abs(a.pos.z - b.pos.z) < 0.01;
}
export function isLocalGoal(g: Goal | null): boolean { return !!g && (g.kind === 'investigate' || g.holdSpot === LOCAL); }

/** FSM transition (§6.2): resets the per-state scratch fields and emits `botState` (debug overlay). Never call from onEvent. */
export function setState(ctx: ThinkContext, mem: BotMemory, s: BotStateId, self?: PlayerState): void {
  if (mem.state === s) return;
  mem.state = s; mem.stateSinceTick = ctx.tick;
  mem.burstLeft = 0; mem.pauseUntilTick = 0;
  mem.peek.active = false; mem.peek.untilTick = 0;
  mem.stuckTicks = 0;
  if (self) { mem.stuckCheckPos.x = self.pos.x; mem.stuckCheckPos.y = self.pos.y; mem.stuckCheckPos.z = self.pos.z; }
  ctx.out.emit('botState', { bot: mem.id, state: s });
}
