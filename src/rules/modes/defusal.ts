/** Bomb Defusal (§2.2): elimination / bomb / defuse / time; sudden death shares the rules without a bomb. */
import type { Rng } from '../../core/rng';
import type { WorldState, PlayerState, Team, WinReason } from '../../sim/state';
import type { CompiledMap } from '../../world/types';
import { placeAtSpawn } from '../loadout';
import { aliveCounts, type GameMode } from './types';

/**
 * Defusal end rules, checked by tickRound every live tick (in this order):
 * bomb defused → CT `defuse`; bomb exploded → T `bomb`; after a plant: all CT dead → T `elimination`, all T dead →
 * the round continues until explode/defuse; before a plant (and in sudden death): both teams dead → draw, all CT dead
 * → T `elimination`, all T dead → CT `elimination`.
 */
export function defusalCheckEnd(state: WorldState): { winner: Team | null; reason: WinReason } | null {
  const b = state.bomb.state;
  if (b === 'defused') return { winner: 'CT', reason: 'defuse' };
  if (b === 'exploded') return { winner: 'T', reason: 'bomb' };
  const alive = aliveCounts(state);
  if (b === 'planted') return alive.CT === 0 ? { winner: 'T', reason: 'elimination' } : null;
  if (alive.T === 0 && alive.CT === 0) return { winner: null, reason: 'draw' };
  if (alive.CT === 0) return { winner: 'T', reason: 'elimination' };
  if (alive.T === 0) return { winner: 'CT', reason: 'elimination' };
  return null;
}

/** Defusal never respawns mid-round; kept for the GameMode contract: puts the player on its team's slot spawn. */
function respawnAtSlot(state: WorldState, p: PlayerState, map: CompiledMap, rng: Rng): void {
  void rng;
  const spawns = map.spawns[p.team];
  const slot = state.players.filter((q) => q.team === p.team).indexOf(p);
  const sp = spawns[Math.max(0, slot) % spawns.length];
  placeAtSpawn(p, sp.pos, sp.yaw);
}

export const DEFUSAL: GameMode = {
  freezeSec: 5, liveSec: 75, buyAnywhere: false, economy: true, bomb: true,
  respawn: respawnAtSlot, checkEnd: defusalCheckEnd, tick: () => {},
  respawnTicks: 0, startMoney: 800,
};
