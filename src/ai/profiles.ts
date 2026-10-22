/** Bot profiles (§6.1): derived Rng, never a sim stream. */
import { Rng } from '../core/rng';
import type { MatchConfig, BotProfile } from '../sim/state';
import { BOT_NAME_KEYS } from './names';

export function makeProfiles(cfg: MatchConfig): BotProfile[] {
  const rng = new Rng(cfg.seed).fork('profiles');
  const n = cfg.teamSize * 2 - 1;
  const friendlyDifficulty = cfg.difficulty === 'easy' ? 'normal' : cfg.difficulty;
  const names = rng.shuffle([...BOT_NAME_KEYS]);
  const awpTaken = { T: false, CT: false };
  return Array.from({ length: n }, (_, i) => {
    const friendly = i < cfg.teamSize - 1;
    const teamKey = friendly ? (cfg.humanTeam === 'T' ? 'T' : 'CT') : (cfg.humanTeam === 'T' ? 'CT' : 'T');
    let preferred: BotProfile['preferredWeapon'] = rng.chance(0.25) ? 'smg' : 'rifle';
    if (!awpTaken[teamKey] && rng.chance(0.3)) { preferred = 'awp'; awpTaken[teamKey] = true; }
    return { nameKey: 'bot.' + names[i % names.length], difficulty: friendly ? friendlyDifficulty : cfg.difficulty, preferredWeapon: preferred, aggression: rng.range(0.2, 0.9), holdPreference: rng.range(0, 1) };
  });
}
