/** Shared fixtures for the ai tests: Depot world (built once), a match state and a hand-assembled ThinkContext. */
import { compileMap, buildStaticWorld } from '@/world/compile';
import { buildNavGraph, type NavGraph } from '@/nav/navgraph';
import { DEPOT } from '@/maps/depot';
import { createMatch } from '@/rules/match';
import { makeProfiles } from '@/ai/profiles';
import { RngStreams } from '@/core/rng';
import { DEG, v3 } from '@/core/math';
import type { ThinkContext } from '@/sim/brain';
import type { CompiledMap } from '@/world/types';
import type { StaticWorld } from '@/world/collision';
import type { MatchConfig, PlayerState, BotMemory, Team, Difficulty, WorldState, InputCommand } from '@/sim/state';
import type { SimEvents } from '@/sim/events';
import type { Perception } from '@/ai/perception';

let cached: { map: CompiledMap; world: StaticWorld; nav: NavGraph } | null = null;
export function depot() {
  if (!cached) { const map = compileMap(DEPOT); const world = buildStaticWorld(map); cached = { map, world, nav: buildNavGraph(map, world) }; }
  return cached;
}

export interface Fixture { ctx: ThinkContext; state: WorldState; events: { type: keyof SimEvents; data: unknown }[] }

export function makeFixture(o: { seed?: number; difficulty?: Difficulty; teamSize?: 2 | 3 | 5; mode?: MatchConfig['mode']; humanTeam?: Team } = {}): Fixture {
  const { map, world, nav } = depot();
  const cfg: MatchConfig = { mode: o.mode ?? 'defusal', seed: o.seed ?? 1, humanTeam: o.humanTeam ?? 'CT', difficulty: o.difficulty ?? 'normal', teamSize: o.teamSize ?? 5, roundsToWin: 6, tdmSeconds: 240, tdmKills: 30, mapId: 'depot', options: { autoPickup: true, scopeHold: true } };
  const streams = new RngStreams(cfg.seed);
  const state = createMatch(cfg, map, makeProfiles(cfg), streams);
  const events: Fixture['events'] = [];
  const ctx: ThinkContext = { state, map, world, nav, rng: streams.get('ai'), tick: 0, out: { emit: (k, e) => { events.push({ type: k, data: e }); } } };
  return { ctx, state, events };
}

export function setTick(f: Fixture, t: number): void { f.ctx.tick = t; f.state.tick = t; }
/** Puts the round in LIVE with `elapsedSec` of LIVE already played. */
export function setLive(f: Fixture, elapsedSec: number): void {
  const r = f.state.round; r.phase = 'LIVE'; r.phaseEndsTick = f.ctx.tick - Math.round(elapsedSec * 60) + 75 * 60; r.roundNumber = Math.max(1, r.roundNumber);
}
export function place(p: PlayerState, x: number, y: number, z: number, yawDeg?: number): void {
  p.pos = v3(x, y, z); p.prevPos = v3(x, y, z); p.vel = v3();
  if (yawDeg !== undefined) { p.yaw = yawDeg * DEG; p.pitch = 0; }
}
export function botsOf(f: Fixture, team: Team): { p: PlayerState; mem: BotMemory }[] {
  return f.state.bots.map((mem) => ({ p: f.state.players.find((q) => q.id === mem.id)!, mem })).filter((b) => b.p.team === team);
}
export function playersOf(f: Fixture, team: Team): PlayerState[] { return f.state.players.filter((p) => p.team === team); }
/** Moves everyone except `keep` out of the way: Ts into North Room (z = 3), CTs along the CT-spawn back wall (x = 45). */
export function parkOthers(f: Fixture, keep: PlayerState[]): void {
  let it = 0, ic = 0;
  for (const p of f.state.players) {
    if (keep.includes(p)) continue;
    if (p.team === 'T') place(p, 3 + 2 * it++, 0, 3, 180); else place(p, 45, 0, 13 + 2 * ic++, 0);
  }
}
/** Looks the bot (body and brain aim) at a point. */
export function lookAt(p: PlayerState, mem: BotMemory, x: number, y: number, z: number): void {
  const eyeY = p.pos.y + (p.crouched ? 1.15 : 1.65);
  p.yaw = Math.atan2(-(x - p.pos.x), -(z - p.pos.z)); p.pitch = Math.atan2(y - eyeY, Math.hypot(x - p.pos.x, z - p.pos.z));
  mem.aimYaw = p.yaw; mem.aimPitch = p.pitch;
}
export function stubPer(best = 0, extra: Partial<Perception> = {}): Perception { return { visible: best ? [{ id: best, dist: 10, angle: 0, seenSinceTick: 0 }] : [], best, heard: [], threatDir: null, ...extra }; }
export function finiteCommand(c: InputCommand): boolean {
  return [c.moveX, c.moveZ, c.yaw, c.pitch, c.buttons, c.tick].every(Number.isFinite) && Math.hypot(c.moveX, c.moveZ) <= 1 + 1e-9;
}
/** First tick index ≥ k with tick % 6 == botIndex % 6 (the bot's perception/decision tick). */
export function nextDecisionTick(f: Fixture, mem: BotMemory, from: number): number {
  const k = f.state.bots.indexOf(mem);
  let t = from; while (t % 6 !== k % 6) t++;
  return t;
}
