/** Team Deathmatch (§2.3): 4 min or first to cfg.tdmKills; respawn 2 s after death with 2 s protection; free items. */
import { v3dist } from '../../core/math';
import type { Rng } from '../../core/rng';
import type { WorldState, PlayerState, Team, WinReason } from '../../sim/state';
import type { CompiledMap } from '../../world/types';
import { placeAtSpawn, applyFreeLoadout } from '../loadout';
import type { GameMode } from './types';

export const TDM = { respawnTicks: 120, protectTicks: 120, safeDistance: 12, occupiedRadius: 1.0 } as const;

/**
 * Spawn choice (§2.3): spawns whose nearest alive enemy is ≥ 12 m away qualify; among them one not occupied by an
 * alive teammate is preferred and the pick is uniform from `rng` (stream `spawn`) so simultaneous respawns spread
 * out. If none qualifies, the spawn with the largest nearest-enemy distance is used (ties: lowest index).
 */
export function chooseTdmSpawn(state: WorldState, p: PlayerState, map: CompiledMap, rng: Rng): number {
  const spawns = map.spawns[p.team];
  const nearest: number[] = spawns.map((s) => {
    let d = Infinity;
    for (const q of state.players) if (q.alive && q.team !== p.team) d = Math.min(d, v3dist(q.pos, s.pos));
    return d;
  });
  const qualifying: number[] = [];
  for (let i = 0; i < spawns.length; i++) if (nearest[i] >= TDM.safeDistance) qualifying.push(i);
  if (qualifying.length > 0) {
    const free = qualifying.filter((i) => !state.players.some((q) => q.alive && q.id !== p.id && q.team === p.team && v3dist(q.pos, spawns[i].pos) < TDM.occupiedRadius));
    const pool = free.length > 0 ? free : qualifying;
    return pool[rng.int(0, pool.length - 1)];
  }
  let best = 0;
  for (let i = 1; i < spawns.length; i++) if (nearest[i] > nearest[best]) best = i;
  return best;
}

/** Respawn with the remembered loadout (`lastBuy`, free) or the default one; 2 s spawn protection. */
export function tdmRespawn(state: WorldState, p: PlayerState, map: CompiledMap, rng: Rng): void {
  const sp = map.spawns[p.team][chooseTdmSpawn(state, p, map, rng)];
  placeAtSpawn(p, sp.pos, sp.yaw);
  applyFreeLoadout(p, p.lastBuy);
  p.invulnerableUntilTick = state.tick + TDM.protectTicks;
  const mem = state.bots.find((m) => m.id === p.id);
  if (mem) { mem.state = 'PLAN'; mem.stateSinceTick = state.tick; mem.goal = null; mem.path = []; mem.corners = []; mem.pathIdx = 0; mem.target = 0; }
}

export function tdmCheckEnd(state: WorldState): { winner: Team | null; reason: WinReason } | null {
  const r = state.round, target = state.cfg.tdmKills;
  if (target > 0) {
    if (r.tdmKillsT >= target && r.tdmKillsT > r.tdmKillsCT) return { winner: 'T', reason: 'elimination' };
    if (r.tdmKillsCT >= target && r.tdmKillsCT > r.tdmKillsT) return { winner: 'CT', reason: 'elimination' };
  }
  return null;
}

export const TDM_MODE: GameMode = {
  freezeSec: 3, liveSec: 240, buyAnywhere: true, economy: false, bomb: false,
  respawn: tdmRespawn, checkEnd: tdmCheckEnd, tick: () => {},
  respawnTicks: TDM.respawnTicks, startMoney: 0,
};
