/** Shared harness for rules tests: the BOX map, idle/scripted bots, event recording, small state helpers. */
import { compileMap, buildStaticWorld } from '@/world/compile';
import { buildNavGraph } from '@/nav/navgraph';
import { BOX } from '@/maps/box';
import { DEPOT } from '@/maps/depot';
import { Simulation, type SimDeps } from '@/sim/sim';
import type { BotBrain, BotBrainFactory } from '@/sim/brain';
import type { SimEvents, SimEventSink } from '@/sim/events';
import { applyDamage } from '@/weapons/damage';
import { processDeaths } from '@/sim/death';
import { findPlayer } from '@/sim/entities';
import { cloneCommand, IDLE_COMMAND, Btn, type MatchConfig, type InputCommand, type EntityId, type WeaponId, type PlayerState } from '@/sim/state';
import { v3 } from '@/core/math';

export { Btn };

/** Per-bot scripted commands (merged over an idle command that keeps the bot's view). */
export type Script = Map<EntityId, Partial<InputCommand>>;

export function scriptedBrains(script: Script): BotBrainFactory {
  const brain: BotBrain = {
    think(ctx, self) { const c = cloneCommand(IDLE_COMMAND, ctx.tick); c.yaw = self.yaw; c.pitch = self.pitch; return { ...c, ...(script.get(self.id) ?? {}), tick: ctx.tick }; },
    onEvent() {},
    teamThink() {},
  };
  return () => brain;
}

export function makeDeps(mapId: 'box' | 'depot' = 'box', variant: 'match' | 'training' = 'match', script: Script = new Map()): SimDeps {
  const map = compileMap(mapId === 'box' ? BOX : DEPOT, variant); const world = buildStaticWorld(map);
  return { map, world, nav: buildNavGraph(map, world), brains: scriptedBrains(script) };
}

export function cfg(over: Partial<MatchConfig> = {}): MatchConfig {
  return { mode: 'defusal', seed: 1, humanTeam: 'T', difficulty: 'normal', teamSize: 2, roundsToWin: 4, tdmSeconds: 240, tdmKills: 30, mapId: 'depot', options: { autoPickup: true, scopeHold: true }, ...over };
}

export interface Harness { sim: Simulation; script: Script; events: { type: keyof SimEvents; data: unknown; tick: number }[]; human: () => PlayerState; p: (id: EntityId) => PlayerState; deps: SimDeps }

export function harness(over: Partial<MatchConfig> = {}, mapId: 'box' | 'depot' = 'box', variant?: 'match' | 'training'): Harness {
  const script: Script = new Map();
  const c = cfg(over);
  const deps = makeDeps(mapId, variant ?? (c.mode === 'training' ? 'training' : 'match'), script);
  const sim = new Simulation(deps, c);
  const events: Harness['events'] = [];
  sim.events.onAny((e) => events.push({ type: e.type, data: e.data, tick: e.tick }));
  const p = (id: EntityId) => findPlayer(sim.state, id)!;
  return { sim, script, events, human: () => p(sim.state.humanId), p, deps };
}

/** Human command for the current tick: idle, keeping the view, plus `extra`. */
export function humanCmd(h: Harness, extra: Partial<InputCommand> = {}): InputCommand {
  const me = h.human();
  const c = cloneCommand(IDLE_COMMAND, h.sim.state.tick); c.yaw = me.yaw; c.pitch = me.pitch;
  return { ...c, ...extra, tick: h.sim.state.tick };
}

export function step(h: Harness, n = 1, extra: Partial<InputCommand> = {}): void {
  for (let i = 0; i < n; i++) { h.sim.step(humanCmd(h, extra)); h.sim.events.drain(); }
}

/** Steps until `state.tick === tick` (the next step processes `tick`). */
export function stepTo(h: Harness, tick: number, extra: Partial<InputCommand> = {}): void {
  while (h.sim.state.tick < tick) step(h, 1, extra);
}

/** Steps until the phase is `phase` (max `limit` steps). */
export function stepUntilPhase(h: Harness, phase: string, limit = 100000, extra: Partial<InputCommand> = {}): void {
  for (let i = 0; i < limit && h.sim.state.round.phase !== phase; i++) step(h, 1, extra);
  if (h.sim.state.round.phase !== phase) throw new Error(`phase ${phase} not reached (at ${h.sim.state.round.phase}, tick ${h.sim.state.tick})`);
}

export function teleport(p: PlayerState, x: number, y: number, z: number): void { p.pos = v3(x, y, z); p.prevPos = v3(x, y, z); p.vel = v3(); }

/** Kills `victim` between two steps and runs the death pipeline (kill credit, drops) right away. */
export function kill(h: Harness, victim: EntityId, killer: EntityId | 0 = 0, weapon: WeaponId | 'bomb' = 'ak47'): void {
  const v = h.p(victim);
  applyDamage(v, 10000, 'chest', 1, { attacker: killer, weapon, headshot: false, dir: v3(0, 0, -1), point: v3(v.pos.x, v.pos.y + 1, v.pos.z) }, h.sim.state, h.sim.events);
  processDeaths(h.sim.state, h.deps.map, h.sim.events);
}

/** Gives the C4 to `id` only (clears every other carrier). */
export function giveBomb(h: Harness, id: EntityId): void {
  for (const q of h.sim.state.players) q.hasBomb = false;
  const p = h.p(id); p.hasBomb = true;
  const b = h.sim.state.bomb; b.state = 'carried'; b.carrier = id; b.pos = v3(p.pos.x, p.pos.y, p.pos.z);
}

export function ofType<K extends keyof SimEvents>(h: Harness, type: K): (SimEvents[K] & { tick: number })[] {
  return h.events.filter((e) => e.type === type).map((e) => ({ ...(e.data as SimEvents[K]), tick: e.tick }));
}

/** A sink that records into an array (for calling rules functions directly). */
export function recordingSink(): { sink: SimEventSink; events: { type: keyof SimEvents; data: unknown }[] } {
  const events: { type: keyof SimEvents; data: unknown }[] = [];
  return { events, sink: { emit: (k, e) => { events.push({ type: k, data: e }); } } };
}

/** BOX map: plant site A centre (cell 4,1) and the CT/T spawn rects. */
export const BOX_SITE_A = { x: 9, y: 0, z: 3 } as const;
