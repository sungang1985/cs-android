/**
 * Bot-only balance simulation (§12.1 ai/balance). Runs N headless Defusal matches per difficulty with the real
 * Simulation and the §6 brains and prints T win-rate, mean round length (LIVE+PLANTED seconds), plant rate,
 * kills/shots, rounds without bot movement and exceptions.
 *
 * Run:  node tools/balance.mjs [--matches 20] [--difficulty all|easy|normal|hard] [--team 5] [--rounds 6] [--cap 60000] [--idle-human]
 * (the wrapper bundles this file with esbuild; the extension-less src imports cannot run under --experimental-strip-types).
 *
 * The human slot (id 1) is driven by a bot of the friendly difficulty (like its team-mates), so the batch measures
 * a full 5v5 bot match; `--idle-human` instead feeds it IDLE_COMMAND every tick (its team plays one man short and
 * an idle T may hold the bomb, which inflates CT time wins). humanTeam alternates with the seed parity
 * (even → CT, odd → T) so the friendly-difficulty rule (Easy enemies vs Normal friendlies) cancels over a batch.
 */
import { compileMap, buildStaticWorld } from '../src/world/compile';
import { buildNavGraph } from '../src/nav/navgraph';
import { DEPOT } from '../src/maps/depot';
import { Simulation, type SimDeps } from '../src/sim/sim';
import { createBotBrain } from '../src/ai/brain';
import { makeProfiles } from '../src/ai/profiles';
import { createBotMemory } from '../src/sim/entities';
import { cloneCommand, IDLE_COMMAND, type MatchConfig, type Difficulty, type Team, type InputCommand, type WinReason } from '../src/sim/state';
import type { BotBrain, BotBrainFactory } from '../src/sim/brain';

export interface MatchOptions { seed: number; difficulty: Difficulty; teamSize?: 2 | 3 | 5; /** any n ≥ 1 (MatchConfig allows 4/6/8; the CI smoke uses 2) */ roundsToWin?: number; tickCap?: number; humanTeam?: Team; /** feed IDLE_COMMAND to the human slot instead of a bot brain */ idleHuman?: boolean }
export interface RoundStat { winner: Team | null; reason: WinReason; liveSec: number; planted: boolean; botMoveM: number; /** a bot carrier entered PLANT (intent, measurable before rules/bomb lands) */ plantTry: boolean; engaged: boolean }
export interface MatchStats {
  seed: number; ticks: number; rounds: RoundStat[]; exceptions: string[]; badCommands: number; nanStates: number;
  shots: number; kills: number; plants: number; firstRoundMove: Record<number, number>; result: Team | 'draw' | 'unfinished';
}
export interface BalanceSummary {
  difficulty: Difficulty; matches: number; rounds: number; tWinRate: number; meanRoundSec: number; plantRate: number; plantTryRate: number; engageRate: number;
  kills: number; shots: number; roundsWithoutMovement: number; exceptions: number; badCommands: number; nanStates: number; reasons: Record<string, number>;
}

let deps: Omit<SimDeps, 'brains'> | null = null;
function worldDeps(): Omit<SimDeps, 'brains'> {
  if (!deps) { const map = compileMap(DEPOT); const world = buildStaticWorld(map); deps = { map, world, nav: buildNavGraph(map, world) }; }
  return deps;
}
const finiteCmd = (c: InputCommand) => [c.moveX, c.moveZ, c.yaw, c.pitch].every(Number.isFinite) && Math.hypot(c.moveX, c.moveZ) <= 1 + 1e-9;

/** One bot-only match; never throws (exceptions are recorded and end the match). */
export function runMatch(o: MatchOptions): MatchStats {
  const cfg: MatchConfig = {
    mode: 'defusal', seed: o.seed, humanTeam: o.humanTeam ?? (o.seed % 2 === 0 ? 'CT' : 'T'), difficulty: o.difficulty,
    teamSize: o.teamSize ?? 5, roundsToWin: (o.roundsToWin ?? 6) as MatchConfig['roundsToWin'], tdmSeconds: 240, tdmKills: 30, mapId: 'depot', options: { autoPickup: true, scopeHold: true },
  };
  const stats: MatchStats = { seed: o.seed, ticks: 0, rounds: [], exceptions: [], badCommands: 0, nanStates: 0, shots: 0, kills: 0, plants: 0, firstRoundMove: {}, result: 'unfinished' };
  const base = createBotBrain();
  const checked = new Map<Difficulty, BotBrain>();
  const brains: BotBrainFactory = (d) => {
    let b = checked.get(d);
    if (!b) { const inner = base(d); b = { ...inner, think: (ctx, self, mem) => { const c = inner.think(ctx, self, mem); if (!finiteCmd(c)) stats.badCommands++; return c; } }; checked.set(d, b); }
    return b;
  };
  let sim: Simulation;
  try { sim = new Simulation({ ...worldDeps(), brains }, cfg, makeProfiles(cfg)); }
  catch (e) { stats.exceptions.push(String(e)); return stats; }
  if (!o.idleHuman) {
    // bot-driven human slot: same friendly difficulty as its team-mates, a middle-of-the-road profile; humanId 0 so
    // the per-tick command no longer overrides it (candidates/snapshot are unused here).
    const st = sim.state, h = st.players.find((p) => p.id === st.humanId)!;
    h.isBot = true;
    st.bots.push(createBotMemory(h.id, { nameKey: 'bot.human_slot', difficulty: cfg.difficulty === 'easy' ? 'normal' : cfg.difficulty, preferredWeapon: 'rifle', aggression: 0.5, holdPreference: 0.5 }, h.pos));
    st.humanId = 0;
  }
  const cap = o.tickCap ?? 60 * 60 * 15;
  let liveStart = -1, planted = false, roundIdx = 0, plantTry = false, engaged = false;
  const start = new Map<number, { x: number; z: number }>(), prev = new Map<number, { x: number; z: number }>();
  let moved = 0;
  for (let t = 0; t < cap; t++) {
    try { sim.step(cloneCommand(IDLE_COMMAND, t)); }
    catch (e) { stats.exceptions.push(`tick ${t}: ${e instanceof Error ? e.stack ?? e.message : String(e)}`); break; }
    stats.ticks = t + 1;
    const s = sim.state;
    for (const e of sim.events.drain()) {
      if (e.type === 'shot') stats.shots++;
      else if (e.type === 'death') { if ((e.data as { killer: number }).killer) stats.kills++; }
      else if (e.type === 'bombPlanted') { stats.plants++; planted = true; }
      else if (e.type === 'roundPhase') {
        const ph = (e.data as { phase: string }).phase;
        if (ph === 'LIVE' || ph === 'SUDDEN_DEATH') {
          liveStart = s.tick; planted = false; plantTry = false; engaged = false; moved = 0; roundIdx++;
          for (const p of s.players) if (p.isBot) { start.set(p.id, { x: p.pos.x, z: p.pos.z }); prev.set(p.id, { x: p.pos.x, z: p.pos.z }); }
        }
      } else if (e.type === 'roundEnd') {
        const d = e.data as { winner: Team | null; reason: WinReason };
        stats.rounds.push({ winner: d.winner, reason: d.reason, liveSec: liveStart >= 0 ? (s.tick - liveStart) / 60 : 0, planted, botMoveM: moved, plantTry, engaged });
      } else if (e.type === 'botState') {
        const st = (e.data as { state: string }).state;
        if (st === 'PLANT') plantTry = true; else if (st === 'ENGAGE') engaged = true;
      } else if (e.type === 'matchEnd') stats.result = (e.data as { result: Team | 'draw' }).result;
    }
    if (liveStart >= 0) for (const p of s.players) {
      if (!p.isBot) continue;
      if (!Number.isFinite(p.pos.x) || !Number.isFinite(p.pos.y) || !Number.isFinite(p.pos.z) || !Number.isFinite(p.yaw) || !Number.isFinite(p.pitch)) stats.nanStates++;
      const q = prev.get(p.id); if (q) { moved += Math.hypot(p.pos.x - q.x, p.pos.z - q.z); q.x = p.pos.x; q.z = p.pos.z; }
      if (roundIdx === 1 && stats.rounds.length === 0) { const s0 = start.get(p.id); if (s0) stats.firstRoundMove[p.id] = Math.max(stats.firstRoundMove[p.id] ?? 0, Math.hypot(p.pos.x - s0.x, p.pos.z - s0.z)); }
    }
    if (s.round.phase === 'MATCH_END') break;
  }
  return stats;
}

export function summarize(difficulty: Difficulty, ms: MatchStats[]): BalanceSummary {
  const rounds = ms.flatMap((m) => m.rounds);
  const decided = rounds.filter((r) => r.winner);
  const reasons: Record<string, number> = {};
  for (const r of rounds) reasons[r.reason] = (reasons[r.reason] ?? 0) + 1;
  return {
    difficulty, matches: ms.length, rounds: rounds.length,
    tWinRate: decided.length ? decided.filter((r) => r.winner === 'T').length / decided.length : 0,
    meanRoundSec: rounds.length ? rounds.reduce((s, r) => s + r.liveSec, 0) / rounds.length : 0,
    plantRate: rounds.length ? rounds.filter((r) => r.planted).length / rounds.length : 0,
    plantTryRate: rounds.length ? rounds.filter((r) => r.plantTry).length / rounds.length : 0,
    engageRate: rounds.length ? rounds.filter((r) => r.engaged).length / rounds.length : 0,
    kills: ms.reduce((s, m) => s + m.kills, 0), shots: ms.reduce((s, m) => s + m.shots, 0),
    roundsWithoutMovement: rounds.filter((r) => r.botMoveM < 5).length,
    exceptions: ms.reduce((s, m) => s + m.exceptions.length, 0), badCommands: ms.reduce((s, m) => s + m.badCommands, 0), nanStates: ms.reduce((s, m) => s + m.nanStates, 0), reasons,
  };
}

export function runBalance(difficulty: Difficulty, seeds: number[], o: Omit<MatchOptions, 'seed' | 'difficulty'> = {}): BalanceSummary {
  return summarize(difficulty, seeds.map((seed) => runMatch({ ...o, seed, difficulty })));
}

/** CLI entry (called by tools/balance.mjs). */
export function main(argv: string[]): number {
  const arg = (k: string, d: string) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  const n = Number(arg('matches', '20')), team = Number(arg('team', '5')) as 2 | 3 | 5, rounds = Number(arg('rounds', '6')), cap = Number(arg('cap', String(60 * 60 * 15)));
  const which = arg('difficulty', 'all'), idleHuman = argv.includes('--idle-human');
  const diffs: Difficulty[] = which === 'all' ? ['easy', 'normal', 'hard'] : [which as Difficulty];
  const seeds = Array.from({ length: n }, (_, i) => i + 1);
  let failures = 0;
  console.log(`balance-sim: ${n} matches × ${diffs.join('/')} · ${team}v${team} · first to ${rounds} · cap ${cap} ticks · human slot ${idleHuman ? 'idles at spawn' : 'bot-driven'} (team alternates by seed)`);
  for (const d of diffs) {
    const t0 = Date.now();
    const r = runBalance(d, seeds, { teamSize: team, roundsToWin: rounds, tickCap: cap, idleHuman });
    failures += r.exceptions + r.badCommands + r.nanStates;
    console.log(`${d.padEnd(6)} rounds ${String(r.rounds).padStart(4)} · T win ${(r.tWinRate * 100).toFixed(1)} % · mean round ${r.meanRoundSec.toFixed(1)} s · plant ${(r.plantRate * 100).toFixed(1)} % (carrier PLANT intent ${(r.plantTryRate * 100).toFixed(1)} %) · rounds with ENGAGE ${(r.engageRate * 100).toFixed(1)} % · kills ${r.kills} · shots ${r.shots} · no-move rounds ${r.roundsWithoutMovement} · exceptions ${r.exceptions} · bad cmds ${r.badCommands} · NaN ${r.nanStates} · reasons ${JSON.stringify(r.reasons)} · ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  }
  return failures ? 1 : 0;
}
