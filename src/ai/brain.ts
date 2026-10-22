/**
 * Bot brain. DAY-0 STUB: createBotBrain() returns a RandomBot (random walk + occasional fire) so the app runs
 * end-to-end; IdleBot is used by tests/freezeBots. L5 replaces this with the §6 FSM.
 */
import type { BotBrain, BotBrainFactory, ThinkContext } from '../sim/brain';
import { Btn, cloneCommand, IDLE_COMMAND, type PlayerState, type BotMemory, type Team, type InputCommand } from '../sim/state';
import type { SimEnvelope } from '../sim/events';

export const IdleBot: BotBrain = {
  think(ctx: ThinkContext, self: PlayerState, mem: BotMemory): InputCommand { void mem; const c = cloneCommand(IDLE_COMMAND, ctx.tick); c.yaw = self.yaw; c.pitch = self.pitch; return c; },
  onEvent(): void {},
  teamThink(): void {},
};

export const RandomBot: BotBrain = {
  think(ctx: ThinkContext, self: PlayerState, mem: BotMemory): InputCommand {
    const c = cloneCommand(IDLE_COMMAND, ctx.tick);
    c.yaw = self.yaw; c.pitch = self.pitch;
    if (ctx.tick % 60 === mem.id % 60) { mem.scanPhase = ctx.rng.range(-Math.PI, Math.PI); mem.burstLeft = ctx.rng.chance(0.3) ? 5 : 0; }
    c.yaw = self.yaw + (mem.scanPhase - self.yaw) * 0.05;
    c.moveZ = 1; c.moveX = 0;
    if (mem.burstLeft > 0) { c.buttons |= Btn.FIRE; mem.burstLeft--; }
    return c;
  },
  onEvent(e: SimEnvelope, mem: BotMemory): void { void e; void mem; },
  teamThink(team: Team, ctx: ThinkContext): void { void team; void ctx; },
};

export function createBotBrain(): BotBrainFactory { return () => RandomBot; }
export function createIdleBrain(): BotBrainFactory { return () => IdleBot; }
