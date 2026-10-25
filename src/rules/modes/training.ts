/** Training range (§2.4): solo, no timer, free items anywhere, targets pop back 120 ticks after being hit. */
import type { Rng } from '../../core/rng';
import type { WorldState, PlayerState } from '../../sim/state';
import type { SimEventSink } from '../../sim/events';
import type { CompiledMap } from '../../world/types';
import { placeAtSpawn, applyFreeLoadout } from '../loadout';
import type { GameMode } from './types';

/** Ticks a target stays down; the weapons lane sets `downUntilTick = tick + TARGET_DOWN_TICKS` when it knocks one down. */
export const TARGET_DOWN_TICKS = 120;

/** Pops every downed target whose timer ran out back up (no randomness). */
export function trainingTick(state: WorldState, map: CompiledMap, out: SimEventSink): void {
  void map;
  for (const t of state.targets) {
    if (!t.up && state.tick >= t.downUntilTick) { t.up = true; out.emit('targetReset', { id: t.id }); }
  }
}

/** The human respawns (e.g. after an HE self-kill) on the team's first spawn with the remembered loadout. */
function trainingRespawn(state: WorldState, p: PlayerState, map: CompiledMap, rng: Rng): void {
  void state; void rng;
  const sp = map.spawns[p.team][0];
  placeAtSpawn(p, sp.pos, sp.yaw);
  applyFreeLoadout(p, p.lastBuy);
}

export const TRAINING: GameMode = {
  freezeSec: 0, liveSec: 1e9, buyAnywhere: true, economy: false, bomb: false,
  respawn: trainingRespawn, checkEnd: () => null, tick: trainingTick,
  respawnTicks: 120, startMoney: 16000,
};
