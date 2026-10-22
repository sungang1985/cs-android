/**
 * Bot brain contract (frozen day 0). Brains are injected into the Simulation through this interface so the
 * sim never imports ai/. One shared, stateless instance per difficulty; per-bot state lives in BotMemory.
 */
import type { Rng } from '../core/rng';
import type { WorldState, PlayerState, BotMemory, Team, Difficulty, InputCommand } from './state';
import type { SimEnvelope, SimEventSink } from './events';
import type { CompiledMap } from '../world/types';
import type { StaticWorld } from '../world/collision';
import type { NavGraph } from '../nav/navgraph';

export interface ThinkContext {
  state: WorldState; map: CompiledMap; world: StaticWorld; nav: NavGraph;
  /** = streams.get('ai') */
  rng: Rng; tick: number;
  /** spotted, botState */
  out: SimEventSink;
}

export interface BotBrain {
  /** Called every tick for every alive bot (ascending id); must return a fresh InputCommand. */
  think(ctx: ThinkContext, self: PlayerState, mem: BotMemory): InputCommand;
  /** Hearing / team info; may mutate only `mem` and `state.teams[*]`, never emits. */
  onEvent(e: SimEnvelope, mem: BotMemory, self: PlayerState, ctx: ThinkContext): void;
  /** Once per team per tick before any think(); may call planTeam(). */
  teamThink(team: Team, ctx: ThinkContext): void;
}

export type BotBrainFactory = (difficulty: Difficulty) => BotBrain;
