/** Shared harness for sim tests/benches: deps on the Depot map, a default config and a scripted human. */
import { compileMap, buildStaticWorld } from '@/world/compile';
import { buildNavGraph } from '@/nav/navgraph';
import { DEPOT } from '@/maps/depot';
import { Simulation } from '@/sim/sim';
import { createBotBrain } from '@/ai/brain';
import { createSnapshot, cloneCommand, IDLE_COMMAND, Btn, type MatchConfig, type InputCommand } from '@/sim/state';
import { Rng } from '@/core/rng';

export function makeDeps() {
  const map = compileMap(DEPOT); const world = buildStaticWorld(map); const nav = buildNavGraph(map, world);
  return { map, world, nav, brains: createBotBrain() };
}
export const CFG: MatchConfig = { mode: 'defusal', seed: 42, humanTeam: 'CT', difficulty: 'normal', teamSize: 5, roundsToWin: 6, tdmSeconds: 240, tdmKills: 30, mapId: 'depot', options: { autoPickup: true, scopeHold: true } };

/** Scripted human: walks forward and strafes, looks around, fires in bursts, reloads, jumps. Deterministic from a seed. */
export function scriptedCommand(tick: number, rng: Rng, yaw: number): InputCommand {
  const c = cloneCommand(IDLE_COMMAND, tick);
  c.yaw = yaw + Math.sin(tick / 90) * 1.2; c.pitch = Math.sin(tick / 200) * 0.2;
  c.moveZ = tick % 400 < 300 ? 1 : 0; c.moveX = tick % 240 < 120 ? 0.3 : -0.3;
  if (tick % 180 < 40) c.buttons |= Btn.FIRE;
  if (tick % 600 === 500) c.buttons |= Btn.RELOAD;
  if (tick % 350 === 10) c.buttons |= Btn.JUMP;
  if (tick % 900 < 100) c.buttons |= Btn.CROUCH;
  if (rng.chance(0.01)) c.slot = (1 + (tick % 3)) as 1 | 2 | 3;
  return c;
}

