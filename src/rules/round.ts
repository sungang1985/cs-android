/** Round state machine (§2.5). Basic DAY-0 version covering phases/timers/elimination; L4 completes (bomb, half, SD, TDM, MVP). */
import { v3 } from '../core/math';
import type { RngStreams } from '../core/rng';
import type { WorldState, Team, WinReason, RoundPhase } from '../sim/state';
import { TICKS_PER_SEC } from '../sim/state';
import type { SimEventSink } from '../sim/events';
import type { CompiledMap } from '../world/types';
import { MODES } from './modes';
import { awardRoundEnd } from './economy';
import { defaultInventory } from '../sim/entities';

export const ROUND = { freezeTicks: 5 * 60, liveTicks: 75 * 60, buyWindowLiveTicks: 10 * 60, roundEndTicks: 4 * 60, plantedTicks: 35 * 60, suddenDeathTicks: 60 * 60 } as const;

function setPhase(state: WorldState, phase: RoundPhase, durationTicks: number, out: SimEventSink): void {
  state.round.phase = phase;
  state.round.phaseEndsTick = durationTicks >= 1e9 ? Number.MAX_SAFE_INTEGER : state.tick + durationTicks;
  out.emit('roundPhase', { phase, round: state.round.roundNumber, endsTick: state.round.phaseEndsTick });
}

function startRound(state: WorldState, map: CompiledMap, rng: RngStreams, out: SimEventSink): void {
  const mode = MODES[state.cfg.mode];
  state.round.roundNumber += 1;
  state.round.winner = null; state.round.reason = null; state.round.mvp = 0; state.round.lastKill = null;
  state.grenades.length = 0; state.items.length = 0;
  state.bomb = { state: 'none', carrier: 0, itemId: 0, pos: v3(), plantedTick: 0, explodeTick: 0, site: null };
  state.teams.T.assignments = {}; state.teams.CT.assignments = {}; state.teams.T.lastEnemySeen.length = 0; state.teams.CT.lastEnemySeen.length = 0;
  const spawnRng = rng.get('spawn');
  for (const p of state.players) {
    const spawns = map.spawns[p.team];
    const idx = state.players.filter((q) => q.team === p.team).indexOf(p) % spawns.length;
    const sp = spawns[idx];
    p.pos = v3(sp.pos.x, sp.pos.y, sp.pos.z); p.prevPos = v3(sp.pos.x, sp.pos.y, sp.pos.z); p.vel = v3();
    p.yaw = sp.yaw; p.pitch = 0; p.prevYaw = sp.yaw; p.prevPitch = 0;
    p.hp = 100; p.alive = true; p.grounded = true; p.crouched = false; p.deathTick = -1; p.reload = null; p.scoped = 0; p.throwing = null;
    p.use.action = 'none'; p.hasBomb = false; p.spectating = 0; p.blindUntilTick = 0;
    p.aimOffset.yaw = 0; p.aimOffset.pitch = 0; p.heat = 0; p.shotIndex = 0;
    if (!mode.economy) { p.inv = defaultInventory(p.team); p.armor = 0; p.helmet = false; }
    else { if (p.inv.primary && p.inv.primary.mag < 0) p.inv.primary = null; p.inv.active = p.inv.primary ? 1 : 2; p.inv.pendingSlot = 0; }
    p.lastBuy = [];
  }
  for (const m of state.bots) { m.state = 'BUY'; m.stateSinceTick = state.tick; m.goal = null; m.path = []; m.corners = []; m.pathIdx = 0; m.target = 0; }
  if (mode.bomb) {
    const ts = state.players.filter((p) => p.team === 'T');
    const carrier = ts[spawnRng.int(0, ts.length - 1)];
    carrier.hasBomb = true; state.bomb.state = 'carried'; state.bomb.carrier = carrier.id; state.bomb.pos = v3(carrier.pos.x, carrier.pos.y, carrier.pos.z);
  }
  const freeze = Math.round(mode.freezeSec * TICKS_PER_SEC);
  state.round.buyWindowEndsTick = mode.buyAnywhere ? Number.MAX_SAFE_INTEGER : state.tick + freeze + ROUND.buyWindowLiveTicks;
  if (freeze > 0) setPhase(state, 'FREEZE', freeze, out);
  else setPhase(state, 'LIVE', mode.liveSec * TICKS_PER_SEC, out);
}

function endRound(state: WorldState, winner: Team | null, reason: WinReason, out: SimEventSink): void {
  state.round.winner = winner; state.round.reason = reason;
  if (winner === 'T') state.round.scoreT++; else if (winner === 'CT') state.round.scoreCT++;
  const deltas = awardRoundEnd(state, winner, reason, out);
  setPhase(state, 'ROUND_END', ROUND.roundEndTicks, out);
  out.emit('roundEnd', { winner, reason, mvp: state.round.mvp, deltas });
}

export function tickRound(state: WorldState, map: CompiledMap, rng: RngStreams, out: SimEventSink): void {
  const mode = MODES[state.cfg.mode];
  const r = state.round;
  switch (r.phase) {
    case 'WARMUP':
      startRound(state, map, rng, out);
      break;
    case 'FREEZE':
      if (state.tick >= r.phaseEndsTick) setPhase(state, 'LIVE', Math.round(mode.liveSec * TICKS_PER_SEC), out);
      break;
    case 'LIVE':
    case 'PLANTED':
    case 'SUDDEN_DEATH': {
      const end = mode.checkEnd(state);
      if (end) { endRound(state, end.winner, end.reason, out); break; }
      if (state.tick >= r.phaseEndsTick) {
        if (state.cfg.mode === 'tdm') endRound(state, r.tdmKillsT > r.tdmKillsCT ? 'T' : r.tdmKillsCT > r.tdmKillsT ? 'CT' : null, r.tdmKillsT === r.tdmKillsCT ? 'draw' : 'time', out);
        else endRound(state, 'CT', 'time', out);
      }
      break;
    }
    case 'ROUND_END':
      if (state.tick >= r.phaseEndsTick) {
        const target = state.cfg.roundsToWin;
        if (r.scoreT >= target || r.scoreCT >= target || state.cfg.mode === 'tdm') {
          r.phase = 'MATCH_END'; r.phaseEndsTick = Number.MAX_SAFE_INTEGER;
          out.emit('roundPhase', { phase: 'MATCH_END', round: r.roundNumber, endsTick: r.phaseEndsTick });
          out.emit('matchEnd', { result: r.scoreT > r.scoreCT ? 'T' : r.scoreCT > r.scoreT ? 'CT' : 'draw', scoreT: r.scoreT, scoreCT: r.scoreCT });
        } else startRound(state, map, rng, out);
      }
      break;
    case 'MATCH_END':
      break;
  }
  mode.tick(state, map, out);
}
