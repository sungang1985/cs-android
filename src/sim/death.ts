/** Death pipeline (§11.6.1): the only place that credits kills, drops items, clears assignments and emits `death`. */
import { v3 } from '../core/math';
import type { WorldState } from './state';
import type { SimEventSink } from './events';
import type { CompiledMap } from '../world/types';
import { findPlayer } from './entities';
import { onKill } from '../rules/economy';
import { dropItem } from '../weapons/items';

export function processDeaths(state: WorldState, map: CompiledMap, out: SimEventSink): void {
  void map;
  if (state.pendingDeaths.length === 0) return;
  const deaths = state.pendingDeaths.splice(0, state.pendingDeaths.length);
  for (const d of deaths) {
    const victim = findPlayer(state, d.victim);
    if (!victim) continue;
    victim.stats.deaths++;
    const killer = d.killer ? findPlayer(state, d.killer) : undefined;
    if (killer && killer.team !== victim.team && d.weapon !== 'fall' && d.weapon !== 'bomb') {
      killer.stats.kills++;
      if (d.headshot) killer.stats.headshots++;
      onKill(state, killer, d.weapon, out);
      if (state.cfg.mode === 'tdm') { if (killer.team === 'T') state.round.tdmKillsT++; else state.round.tdmKillsCT++; }
    }
    dropItem(state, victim, 'weapon', out);
    if (victim.hasBomb) dropItem(state, victim, 'bomb', out);
    delete state.teams[victim.team].assignments[victim.id];
    // spectate an alive teammate (lowest id); 0 if none
    const mate = state.players.find((p) => p.alive && p.team === victim.team && p.id !== victim.id);
    victim.spectating = mate ? mate.id : 0;
    for (const p of state.players) if (!p.alive && p.team === victim.team && p.spectating === victim.id) p.spectating = mate ? mate.id : 0;
    state.round.lastKill = { killer: d.killer, victim: d.victim, headshot: d.headshot, weapon: d.weapon, tick: state.tick };
    out.emit('death', { victim: d.victim, killer: d.killer, weapon: d.weapon, headshot: d.headshot, pos: v3(victim.pos.x, victim.pos.y, victim.pos.z), dir: v3(d.dir.x, d.dir.y, d.dir.z) });
    out.emit('sound', { id: 'death', pos: v3(victim.pos.x, victim.pos.y, victim.pos.z), loudness: 15, player: victim.id });
  }
}
