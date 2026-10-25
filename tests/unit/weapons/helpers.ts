/** Shared fixtures for weapons tests: a hand-built minimal WorldState, a recording sink and a stepping helper. */
import { v3, aabb, type Vec3 } from '@/core/math';
import { RngStreams } from '@/core/rng';
import { StaticWorld, type Solid } from '@/world/collision';
import { createPlayer } from '@/sim/entities';
import { cloneCommand, IDLE_COMMAND, type WorldState, type PlayerState, type InputCommand, type Team, type MatchConfig } from '@/sim/state';
import type { SimEventSink, SimEvents } from '@/sim/events';
import { tickWeapon, recoverRecoil } from '@/weapons/fire';
import { WEAPONS } from '@/weapons/defs';
import { activeWeaponId } from '@/weapons/inventory';

export type Rec = { type: keyof SimEvents; data: unknown; tick: number };
export function recorder(state?: { tick: number }): SimEventSink & { events: Rec[]; of<K extends keyof SimEvents>(k: K): SimEvents[K][]; clear(): void } {
  const events: Rec[] = [];
  return {
    events,
    emit(k, e) { events.push({ type: k, data: e, tick: state ? state.tick : 0 }); },
    of<K extends keyof SimEvents>(k: K) { return events.filter((r) => r.type === k).map((r) => r.data as SimEvents[K]); },
    clear() { events.length = 0; },
  };
}

export const TEST_CFG: MatchConfig = { mode: 'tdm', seed: 1, humanTeam: 'CT', difficulty: 'normal', teamSize: 5, roundsToWin: 6, tdmSeconds: 240, tdmKills: 30, mapId: 'depot', options: { autoPickup: true, scopeHold: true } };

export function makeState(players: PlayerState[], cfg: Partial<MatchConfig> = {}): WorldState {
  const bb = () => ({ lastEnemySeen: [], bombPos: null, plannedSite: null, assignments: {}, rotateCalledTick: 0 });
  return {
    cfg: { ...TEST_CFG, ...cfg, options: { ...TEST_CFG.options, ...(cfg.options ?? {}) } }, tick: 1000, nextId: 100,
    rng: {} as WorldState['rng'], players: [...players].sort((a, b) => a.id - b.id), grenades: [], items: [], targets: [],
    bomb: { state: 'none', carrier: 0, itemId: 0, pos: v3(), plantedTick: 0, explodeTick: 0, site: null },
    round: { phase: 'LIVE', phaseEndsTick: 1e9, roundNumber: 1, half: 1, suddenDeath: false, winner: null, reason: null, scoreT: 0, scoreCT: 0, lossStreakT: 0, lossStreakCT: 0, buyWindowEndsTick: 0, mvp: 0, tdmKillsT: 0, tdmKillsCT: 0, lastKill: null },
    teams: { T: bb(), CT: bb() }, bots: [], humanId: 1, pendingDeaths: [],
  };
}

/** Player standing at `pos` looking along yaw (radians); ready to fire (no deploy pending). */
export function player(id: number, team: Team, pos: Vec3, yaw = 0, isBot = id !== 1): PlayerState {
  const p = createPlayer(id, team, isBot, 'p' + id, pos, yaw, 0);
  p.inv.switchEndsTick = -1000;
  return p;
}

/** Open ground plane only (big bounds). */
export function openWorld(solids: Array<Omit<Solid, 'id'>> = []): StaticWorld {
  return new StaticWorld(solids, { groundY: 0, bounds: aabb(-100, -1, -100, 100, 20, 100) });
}
export function solid(box: ReturnType<typeof aabb>, kind: string, penetrable = false, penetrationFactor = 0, surface: Solid['surface'] = 'wood'): Omit<Solid, 'id'> {
  return { box, kind, penetrable, penetrationFactor, surface };
}

export function cmd(p: PlayerState, buttons = 0, extra: Partial<InputCommand> = {}): InputCommand {
  const c = cloneCommand(IDLE_COMMAND, 0);
  c.yaw = p.yaw; c.pitch = p.pitch; c.buttons = buttons;
  return Object.assign(c, extra);
}

/** sim.ts step 4 for one player + tick++. */
export function stepWeapon(p: PlayerState, c: InputCommand, state: WorldState, world: StaticWorld, rng: RngStreams, out: SimEventSink): void {
  c.tick = state.tick;
  if (p.alive) tickWeapon(p, c, state, world, rng, out);
  if (p.alive) recoverRecoil(p, WEAPONS[activeWeaponId(p)]);
  state.pendingDeaths.length = 0;
  state.tick++;
}

export function give(p: PlayerState, id: 'ak47' | 'm4a4' | 'awp' | 'mp5' | 'deagle' | 'glock' | 'usp'): void {
  const def = WEAPONS[id];
  if (def.slot === 1) { p.inv.primary = { id, mag: def.mag, reserve: def.reserve }; p.inv.active = 1; }
  else { p.inv.pistol = { id, mag: def.mag, reserve: def.reserve }; p.inv.active = 2; }
}

export const rngs = (seed = 7) => new RngStreams(seed);
