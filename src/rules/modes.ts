/** Game modes (§2): MODES registry. Mode logic lives in rules/modes/{defusal,tdm,training}.ts. */
import type { ModeId } from '../sim/state';
import type { GameMode } from './modes/types';
import { DEFUSAL } from './modes/defusal';
import { TDM_MODE } from './modes/tdm';
import { TRAINING } from './modes/training';

export type { GameMode } from './modes/types';
export { aliveCounts } from './modes/types';
export { defusalCheckEnd } from './modes/defusal';
export { TDM, chooseTdmSpawn, tdmRespawn, tdmCheckEnd } from './modes/tdm';
export { TARGET_DOWN_TICKS, trainingTick } from './modes/training';

export const MODES: Record<ModeId, GameMode> = { defusal: DEFUSAL, tdm: TDM_MODE, training: TRAINING };
