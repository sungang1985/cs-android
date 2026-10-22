/** Game modes (§2). Basic DAY-0 version; L4 completes (TDM respawn placement, training targets). */
import { v3 } from '../core/math';
import type { Rng } from '../core/rng';
import type { WorldState, PlayerState, Team, WinReason, ModeId } from '../sim/state';
import type { SimEventSink } from '../sim/events';
import type { CompiledMap } from '../world/types';
import { defaultInventory } from '../sim/entities';

export interface GameMode {
  freezeSec: number; liveSec: number; buyAnywhere: boolean; economy: boolean; bomb: boolean;
  respawn(state: WorldState, p: PlayerState, map: CompiledMap, rng: Rng): void;
  checkEnd(state: WorldState): { winner: Team | null; reason: WinReason } | null;
  tick(state: WorldState, map: CompiledMap, out: SimEventSink): void;
}

function respawnAtTeamSpawn(state: WorldState, p: PlayerState, map: CompiledMap, rng: Rng): void {
  const spawns = map.spawns[p.team];
  const s = spawns[rng.int(0, spawns.length - 1)];
  p.pos = v3(s.pos.x, s.pos.y, s.pos.z); p.prevPos = v3(s.pos.x, s.pos.y, s.pos.z); p.vel = v3();
  p.yaw = s.yaw; p.pitch = 0; p.hp = 100; p.alive = true; p.grounded = true; p.crouched = false;
  p.deathTick = -1; p.reload = null; p.scoped = 0; p.throwing = null; p.use.action = 'none';
  p.inv = defaultInventory(p.team);
}

function eliminationCheck(state: WorldState): { winner: Team | null; reason: WinReason } | null {
  const aliveT = state.players.some((p) => p.team === 'T' && p.alive), aliveCT = state.players.some((p) => p.team === 'CT' && p.alive);
  if (!aliveT && !aliveCT) return { winner: null, reason: 'draw' };
  if (!aliveCT) return { winner: 'T', reason: 'elimination' };
  if (!aliveT) {
    if (state.bomb.state === 'planted') return null; // round continues until explode/defuse
    return { winner: 'CT', reason: 'elimination' };
  }
  return null;
}

export const MODES: Record<ModeId, GameMode> = {
  defusal: { freezeSec: 5, liveSec: 75, buyAnywhere: false, economy: true, bomb: true, respawn: respawnAtTeamSpawn, checkEnd: eliminationCheck, tick: () => {} },
  tdm: {
    freezeSec: 3, liveSec: 240, buyAnywhere: true, economy: false, bomb: false, respawn: respawnAtTeamSpawn,
    checkEnd: (state) => {
      if (state.round.tdmKillsT >= state.cfg.tdmKills) return { winner: 'T', reason: 'elimination' };
      if (state.round.tdmKillsCT >= state.cfg.tdmKills) return { winner: 'CT', reason: 'elimination' };
      return null;
    },
    tick: () => {},
  },
  training: { freezeSec: 0, liveSec: 1e9, buyAnywhere: true, economy: false, bomb: false, respawn: respawnAtTeamSpawn, checkEnd: () => null, tick: () => {} },
};
