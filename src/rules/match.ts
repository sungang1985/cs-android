/**
 * Match creation (§2, §6.1, §11.3): players, bots, spawns, blackboards, training targets.
 * Ids: human = 1 (nameKey 'bot.player'), friendly bots 2…n, enemy bots n+1…2n (n = cfg.teamSize), then targets.
 * Training creates only the human + the targets of map.training. `state.cfg` IS the caller's cfg object (not a copy):
 * the half-time swap writes cfg.humanTeam, which the app's own reference then sees too.
 */
import { v3 } from '../core/math';
import type { RngStreams } from '../core/rng';
import type { WorldState, MatchConfig, BotProfile, Team, Blackboard, PlayerState, BotMemory } from '../sim/state';
import type { CompiledMap } from '../world/types';
import { createPlayer, createBotMemory, enemyTeam } from '../sim/entities';
import { MODES } from './modes';

export const BOT_NAME_KEYS: readonly string[] = ['wang', 'qiang', 'lei', 'fang', 'hu', 'lin', 'song', 'yu', 'bao', 'kai', 'ming', 'tao'];
/** i18n key of the human's display name (「你」 / "You"). */
export const HUMAN_NAME_KEY = 'bot.player';

export function defaultProfiles(cfg: MatchConfig): BotProfile[] {
  const n = cfg.teamSize * 2 - 1;
  const friendlyDifficulty = cfg.difficulty === 'easy' ? 'normal' : cfg.difficulty;
  return Array.from({ length: n }, (_, i) => ({
    nameKey: 'bot.' + BOT_NAME_KEYS[i % BOT_NAME_KEYS.length],
    difficulty: i < cfg.teamSize - 1 ? friendlyDifficulty : cfg.difficulty,
    preferredWeapon: 'rifle', aggression: 0.5, holdPreference: 0.5,
  }));
}

function emptyBlackboard(): Blackboard { return { lastEnemySeen: [], bombPos: null, plannedSite: null, assignments: {}, rotateCalledTick: 0 }; }

/** Human = id 1, friendly bots 2…n, enemies n+1…2n. */
export function createMatch(cfg: MatchConfig, map: CompiledMap, profiles: BotProfile[] | undefined, rng: RngStreams): WorldState {
  const profs = profiles ?? defaultProfiles(cfg);
  const mode = MODES[cfg.mode];
  const state: WorldState = {
    cfg, tick: 0, nextId: 1,
    rng: rng.serialize() as WorldState['rng'],
    players: [], grenades: [], items: [], targets: [],
    bomb: { state: 'none', carrier: 0, itemId: 0, pos: v3(), plantedTick: 0, explodeTick: 0, site: null },
    round: { phase: 'WARMUP', phaseEndsTick: 0, roundNumber: 0, half: 1, suddenDeath: false, winner: null, reason: null, scoreT: 0, scoreCT: 0, lossStreakT: 0, lossStreakCT: 0, buyWindowEndsTick: 0, mvp: 0, tdmKillsT: 0, tdmKillsCT: 0, lastKill: null },
    teams: { T: emptyBlackboard(), CT: emptyBlackboard() },
    bots: [], humanId: 1, pendingDeaths: [],
  };
  const human: Team = cfg.humanTeam, enemy = enemyTeam(human);
  const n = cfg.mode === 'training' ? 1 : cfg.teamSize;
  const money = mode.startMoney;
  const mk = (team: Team, isBot: boolean, nameKey: string, slot: number, profile?: BotProfile): PlayerState => {
    const sp = map.spawns[team][slot % map.spawns[team].length];
    const p = createPlayer(state.nextId++, team, isBot, nameKey, sp.pos, sp.yaw, money);
    state.players.push(p);
    if (isBot && profile) { const mem: BotMemory = createBotMemory(p.id, profile, p.pos); state.bots.push(mem); }
    return p;
  };
  mk(human, false, HUMAN_NAME_KEY, 0);
  let pi = 0;
  for (let i = 1; i < n; i++) mk(human, true, profs[pi].nameKey, i, profs[pi++]);
  if (cfg.mode !== 'training') for (let i = 0; i < n; i++) mk(enemy, true, profs[pi].nameKey, i, profs[pi++]);
  if (map.training) for (const t of map.training.targets) state.targets.push({ id: state.nextId++, pos: v3(t.x, t.y, t.z), up: true, downUntilTick: 0 });
  state.rng = rng.serialize() as WorldState['rng'];
  return state;
}
