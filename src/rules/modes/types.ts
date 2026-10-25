/** GameMode contract (§11.8). The binding fields first; `respawnTicks`/`startMoney` are L4 additions. */
import type { Rng } from '../../core/rng';
import type { WorldState, PlayerState, Team, WinReason } from '../../sim/state';
import type { SimEventSink } from '../../sim/events';
import type { CompiledMap } from '../../world/types';

export interface GameMode {
  freezeSec: number; liveSec: number; buyAnywhere: boolean; economy: boolean; bomb: boolean;
  /** Puts a dead player back into play (TDM/training); `rng` = streams.get('spawn'). tickRound emits `respawn`. */
  respawn(state: WorldState, p: PlayerState, map: CompiledMap, rng: Rng): void;
  /** Round/match end condition checked every LIVE/PLANTED/SUDDEN_DEATH tick (timer expiry is handled by tickRound). */
  checkEnd(state: WorldState): { winner: Team | null; reason: WinReason } | null;
  /** Per-tick mode logic (training: target pop-back; others: no-op). */
  tick(state: WorldState, map: CompiledMap, out: SimEventSink): void;
  /** Ticks from death to respawn; 0 = no respawn (defusal). */
  respawnTicks: number;
  /** Money every player starts the match with. */
  startMoney: number;
}

export function aliveCounts(state: WorldState): { T: number; CT: number } {
  let t = 0, ct = 0;
  for (const p of state.players) if (p.alive) { if (p.team === 'T') t++; else ct++; }
  return { T: t, CT: ct };
}
