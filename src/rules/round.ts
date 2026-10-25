/**
 * Round state machine (§2.5). tickRound (sim.ts step 1) is the ONLY place that changes `round.phase`:
 *
 *   WARMUP → FREEZE (5 s; TDM 3 s; training 0) → LIVE (75 s; TDM cfg.tdmSeconds; training: no timer)
 *   LIVE ─bomb.state 'planted'→ PLANTED (ends at bomb.explodeTick) ; sudden death: FREEZE → SUDDEN_DEATH (60 s)
 *   LIVE/PLANTED/SUDDEN_DEATH ─MODES[mode].checkEnd or timer→ ROUND_END (4 s, money resolved on entry)
 *   ROUND_END → next round (half after round n−1: sides swap) | SUDDEN_DEATH round at (n−1):(n−1) | MATCH_END
 *   TDM / training are single-round: the end condition goes straight to MATCH_END (roundEnd is still emitted).
 *
 * Bomb completion is written by rules/bomb.ts#tickBomb (step 6) into `bomb.state` and picked up here on the next tick.
 */
import { v3 } from '../core/math';
import type { RngStreams } from '../core/rng';
import type { WorldState, Team, WinReason, RoundPhase, EntityId, PlayerState } from '../sim/state';
import { TICKS_PER_SEC } from '../sim/state';
import type { SimEventSink } from '../sim/events';
import type { CompiledMap } from '../world/types';
import { MODES, type GameMode } from './modes';
import { awardRoundEnd, addMoney, ECON } from './economy';
import { enemyTeam, findPlayer } from '../sim/entities';
import { placeAtSpawn, resetLoadout, suddenDeathLoadout } from './loadout';

export const ROUND = { freezeTicks: 5 * 60, liveTicks: 75 * 60, buyWindowLiveTicks: 10 * 60, roundEndTicks: 4 * 60, plantedTicks: 35 * 60, suddenDeathTicks: 60 * 60 } as const;

/** phaseEndsTick / buyWindowEndsTick value meaning "no timer". */
export const NEVER = Number.MAX_SAFE_INTEGER;

function setPhase(state: WorldState, phase: RoundPhase, endsTick: number, out: SimEventSink): void {
  state.round.phase = phase;
  state.round.phaseEndsTick = endsTick;
  out.emit('roundPhase', { phase, round: state.round.roundNumber, endsTick });
}

function secondsToTicks(sec: number): number { return sec >= 1e9 ? NEVER : Math.round(sec * TICKS_PER_SEC); }
function after(state: WorldState, ticks: number): number { return ticks >= NEVER ? NEVER : state.tick + ticks; }

/** Length of the live phase of the current round. */
export function liveTicksFor(state: WorldState, mode: GameMode = MODES[state.cfg.mode]): number {
  if (state.round.suddenDeath) return ROUND.suddenDeathTicks;
  if (state.cfg.mode === 'tdm') return secondsToTicks(state.cfg.tdmSeconds > 0 ? state.cfg.tdmSeconds : mode.liveSec);
  return secondsToTicks(mode.liveSec);
}

/** True when the current defusal round is the last one before the side swap (bots: buyPlan's isLastRoundOfHalf). */
export function isLastRoundOfHalf(state: WorldState): boolean {
  return state.cfg.mode === 'defusal' && state.round.half === 1 && state.round.roundNumber === state.cfg.roundsToWin - 1;
}

/**
 * MVP (documented simplification, see the L4 report): RoundState/PlayerState carry no per-round kill count, so the
 * MVP is the ALIVE player of the winning team with the most kills this match (ties: lowest id); if none of the
 * winners is alive, any winner; 0 on a draw.
 */
export function computeMvp(state: WorldState, winner: Team | null): EntityId | 0 {
  if (!winner) return 0;
  let pool = state.players.filter((p) => p.team === winner && p.alive);
  if (pool.length === 0) pool = state.players.filter((p) => p.team === winner);
  let best: PlayerState | null = null;
  for (const p of pool) if (!best || p.stats.kills > best.stats.kills) best = p;
  return best ? best.id : 0;
}

function startRound(state: WorldState, map: CompiledMap, rng: RngStreams, out: SimEventSink): void {
  const mode = MODES[state.cfg.mode];
  const r = state.round;
  const n = state.cfg.roundsToWin;
  r.roundNumber += 1;
  r.suddenDeath = state.cfg.mode === 'defusal' && r.scoreT === n - 1 && r.scoreCT === n - 1;
  r.winner = null; r.reason = null; r.mvp = 0; r.lastKill = null;
  state.grenades.length = 0; state.items.length = 0;
  state.bomb = { state: 'none', carrier: 0, itemId: 0, pos: v3(), plantedTick: 0, explodeTick: 0, site: null };
  for (const team of ['T', 'CT'] as const) {
    const bb = state.teams[team];
    bb.assignments = {}; bb.lastEnemySeen.length = 0; bb.bombPos = null; bb.rotateCalledTick = 0;
  }
  const slot = { T: 0, CT: 0 };
  for (const p of state.players) {
    const survived = r.roundNumber > 1 && p.alive;
    const spawns = map.spawns[p.team];
    const sp = spawns[slot[p.team]++ % spawns.length];
    placeAtSpawn(p, sp.pos, sp.yaw);
    p.respawnTick = 0; p.hasBomb = false;
    if (!mode.economy) resetLoadout(p);
    else if (r.suddenDeath) suddenDeathLoadout(p);
    else if (!survived) resetLoadout(p);
    else { p.inv.active = p.inv.primary ? 1 : 2; p.inv.pendingSlot = 0; p.inv.switchEndsTick = 0; }
    if (mode.economy) p.lastBuy = []; // defusal: this round's purchases; TDM/training keep the respawn loadout
  }
  for (const m of state.bots) { m.state = 'BUY'; m.stateSinceTick = state.tick; m.goal = null; m.path = []; m.corners = []; m.pathIdx = 0; m.target = 0; }
  if (mode.bomb && !r.suddenDeath) {
    const ts = state.players.filter((p) => p.team === 'T');
    if (ts.length > 0) {
      const carrier = ts[rng.get('spawn').int(0, ts.length - 1)];
      carrier.hasBomb = true;
      state.bomb.state = 'carried'; state.bomb.carrier = carrier.id; state.bomb.pos = v3(carrier.pos.x, carrier.pos.y, carrier.pos.z);
    }
  }
  const freeze = secondsToTicks(mode.freezeSec);
  r.buyWindowEndsTick = mode.buyAnywhere ? NEVER : r.suddenDeath ? -1 : state.tick + freeze + ROUND.buyWindowLiveTicks;
  if (freeze > 0) setPhase(state, 'FREEZE', state.tick + freeze, out);
  else setPhase(state, r.suddenDeath ? 'SUDDEN_DEATH' : 'LIVE', after(state, liveTicksFor(state, mode)), out);
}

/**
 * Half time (§2.2, after round roundsToWin − 1): every player changes side; money → $800 (`halfReset`), loss
 * streaks → 0, inventories → the new team's default pistol, no armor/kit/bomb; the scores move with the teams
 * (scoreT ↔ scoreCT) and cfg.humanTeam follows the human.
 */
export function swapSides(state: WorldState, out: SimEventSink): void {
  const r = state.round;
  for (const p of state.players) {
    p.team = enemyTeam(p.team);
    addMoney(state, p, ECON.start - p.money, 'halfReset', out);
    resetLoadout(p);
    p.lastBuy = [];
  }
  r.lossStreakT = 0; r.lossStreakCT = 0;
  const sT = r.scoreT; r.scoreT = r.scoreCT; r.scoreCT = sT;
  r.half = 2;
  for (const team of ['T', 'CT'] as const) {
    const bb = state.teams[team];
    bb.assignments = {}; bb.lastEnemySeen.length = 0; bb.bombPos = null; bb.plannedSite = null; bb.rotateCalledTick = 0;
  }
  const human = findPlayer(state, state.humanId);
  if (human) state.cfg.humanTeam = human.team;
}

function enterMatchEnd(state: WorldState, out: SimEventSink): void {
  const r = state.round;
  setPhase(state, 'MATCH_END', NEVER, out);
  out.emit('matchEnd', { result: r.scoreT > r.scoreCT ? 'T' : r.scoreCT > r.scoreT ? 'CT' : 'draw', scoreT: r.scoreT, scoreCT: r.scoreCT });
}

function syncTdmScore(state: WorldState): void {
  if (state.cfg.mode !== 'tdm') return;
  state.round.scoreT = state.round.tdmKillsT; state.round.scoreCT = state.round.tdmKillsCT;
}

function finishRound(state: WorldState, winner: Team | null, reason: WinReason, out: SimEventSink): void {
  const r = state.round;
  r.winner = winner; r.reason = reason;
  if (state.cfg.mode === 'defusal') { if (winner === 'T') r.scoreT++; else if (winner === 'CT') r.scoreCT++; }
  syncTdmScore(state);
  r.mvp = computeMvp(state, winner);
  const mvp = r.mvp ? findPlayer(state, r.mvp) : undefined;
  if (mvp) mvp.stats.mvps++;
  const deltas = awardRoundEnd(state, winner, reason, out);
  if (state.cfg.mode === 'defusal') {
    setPhase(state, 'ROUND_END', state.tick + ROUND.roundEndTicks, out);
    out.emit('roundEnd', { winner, reason, mvp: r.mvp, deltas });
  } else {
    out.emit('roundEnd', { winner, reason, mvp: r.mvp, deltas });
    enterMatchEnd(state, out);
  }
}

/** Timer expiry: defusal LIVE → CT `time`; sudden death → draw; TDM → most kills (`time`, or `draw` if equal). */
function expire(state: WorldState, out: SimEventSink): void {
  const r = state.round;
  if (state.cfg.mode === 'tdm') {
    if (r.tdmKillsT === r.tdmKillsCT) finishRound(state, null, 'draw', out);
    else finishRound(state, r.tdmKillsT > r.tdmKillsCT ? 'T' : 'CT', 'time', out);
  } else if (r.suddenDeath) finishRound(state, null, 'draw', out);
  else finishRound(state, 'CT', 'time', out);
}

/** TDM/training respawns: scheduled `respawnTicks` after death, placed by MODES[mode].respawn with the spawn stream. */
function tickRespawns(state: WorldState, map: CompiledMap, rng: RngStreams, mode: GameMode, out: SimEventSink): void {
  if (mode.respawnTicks <= 0) return;
  for (const p of state.players) {
    if (p.alive) continue;
    if (p.respawnTick <= p.deathTick) p.respawnTick = p.deathTick + mode.respawnTicks;
    if (state.tick >= p.respawnTick) {
      mode.respawn(state, p, map, rng.get('spawn'));
      out.emit('respawn', { player: p.id, pos: v3(p.pos.x, p.pos.y, p.pos.z) });
    }
  }
}

function tickLive(state: WorldState, map: CompiledMap, rng: RngStreams, mode: GameMode, out: SimEventSink): void {
  const r = state.round;
  if (r.phase === 'LIVE' && mode.bomb && state.bomb.state === 'planted') setPhase(state, 'PLANTED', state.bomb.explodeTick, out);
  const end = mode.checkEnd(state);
  if (end) { finishRound(state, end.winner, end.reason, out); return; }
  if (r.phase !== 'PLANTED' && state.tick >= r.phaseEndsTick) { expire(state, out); return; }
  tickRespawns(state, map, rng, mode, out);
}

/** ROUND_END expired: match over, or (half swap and) the next round. */
function nextRound(state: WorldState, map: CompiledMap, rng: RngStreams, out: SimEventSink): void {
  const r = state.round, n = state.cfg.roundsToWin;
  if (r.suddenDeath || r.scoreT >= n || r.scoreCT >= n) { enterMatchEnd(state, out); return; }
  if (r.half === 1 && r.roundNumber >= n - 1) swapSides(state, out);
  startRound(state, map, rng, out);
}

export function tickRound(state: WorldState, map: CompiledMap, rng: RngStreams, out: SimEventSink): void {
  const mode = MODES[state.cfg.mode];
  const r = state.round;
  syncTdmScore(state);
  switch (r.phase) {
    case 'WARMUP':
      startRound(state, map, rng, out);
      break;
    case 'FREEZE':
      if (state.tick >= r.phaseEndsTick) setPhase(state, r.suddenDeath ? 'SUDDEN_DEATH' : 'LIVE', after(state, liveTicksFor(state, mode)), out);
      break;
    case 'LIVE':
    case 'PLANTED':
    case 'SUDDEN_DEATH':
      tickLive(state, map, rng, mode, out);
      break;
    case 'ROUND_END':
      if (state.tick >= r.phaseEndsTick) nextRound(state, map, rng, out);
      break;
    case 'MATCH_END':
      break;
  }
  mode.tick(state, map, out);
}
