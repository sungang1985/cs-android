/** Builds a full MatchConfig from a partial request + settings; remembers the last one (cs.v1.lastSettings). */
import type { MatchConfig, Team } from '../sim/state';
import type { Settings } from '../settings/types';
import { persist } from '../platform/persist';

export const DEFAULT_MATCH: Omit<MatchConfig, 'seed' | 'options'> = { mode: 'defusal', humanTeam: 'CT', difficulty: 'normal', teamSize: 5, roundsToWin: 6, tdmSeconds: 240, tdmKills: 30, mapId: 'depot' };

export function buildMatchConfig(partial: Partial<MatchConfig> & { humanTeam?: Team | 'random' }, settings: Settings, seed: number, rngPick: () => number): MatchConfig {
  const last = persist.get<Partial<MatchConfig> | null>('lastSettings', null) ?? {};
  const base = { ...DEFAULT_MATCH, ...last, ...partial };
  const humanTeam: Team = base.mode === 'training' ? 'T' : (base.humanTeam as Team | 'random') === 'random' ? (rngPick() < 0.5 ? 'T' : 'CT') : (base.humanTeam as Team);
  const cfg: MatchConfig = {
    mode: base.mode, seed: partial.seed ?? seed, humanTeam, difficulty: base.difficulty, teamSize: base.teamSize, roundsToWin: base.roundsToWin,
    tdmSeconds: base.tdmSeconds, tdmKills: base.tdmKills, mapId: 'depot',
    options: { autoPickup: settings.autoPickup, scopeHold: settings.scopeHold },
  };
  persist.set('lastSettings', { mode: cfg.mode, humanTeam: partial.humanTeam ?? cfg.humanTeam, difficulty: cfg.difficulty, teamSize: cfg.teamSize, roundsToWin: cfg.roundsToWin });
  return cfg;
}

/** Seed from ?seed= or a time-based value (only ever used OUTSIDE the sim). */
export function pickSeed(search: string, now: number): number {
  const m = /[?&]seed=(\d+)/.exec(search);
  return m ? Number(m[1]) : (now % 1_000_000_007) >>> 0;
}
