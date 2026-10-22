/** Perception (§6.3). DAY-0 STUB (signature binding); L5 implements. */
import type { Vec3 } from '../core/math';
import type { ThinkContext } from '../sim/brain';
import type { PlayerState, BotMemory, EntityId } from '../sim/state';
import type { DifficultyCfg } from './difficulty';

export interface Perception { visible: { id: EntityId; dist: number; angle: number; seenSinceTick: number }[]; best: EntityId | 0; heard: { pos: Vec3; tick: number; loudness: number }[]; threatDir: Vec3 | null }

export function perceive(ctx: ThinkContext, self: PlayerState, mem: BotMemory, cfg: DifficultyCfg): Perception {
  void ctx; void self; void mem; void cfg;
  return { visible: [], best: 0, heard: [], threatDir: null };
}
