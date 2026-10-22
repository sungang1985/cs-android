/**
 * Entity id allocation and small shared constructors (frozen day 0).
 * Ids are never reused within a match: human = 1, friendly bots 2…n, enemies n+1…2n, then items/grenades/targets.
 */
import { v3, type Vec3 } from '../core/math';
import type { WorldState, EntityId, PlayerState, Team, BotMemory, BotProfile, PlayerStats, Inventory, WeaponSlotState } from './state';

export function allocId(state: WorldState): EntityId { return state.nextId++; }

export function emptyStats(): PlayerStats { return { kills: 0, deaths: 0, headshots: 0, shots: 0, hits: 0, damage: 0, plants: 0, defuses: 0, mvps: 0 }; }

export function pistolFor(team: Team): WeaponSlotState { return team === 'T' ? { id: 'glock', mag: 20, reserve: 120 } : { id: 'usp', mag: 12, reserve: 24 }; }

export function defaultInventory(team: Team): Inventory {
  return { primary: null, pistol: pistolFor(team), knife: true, he: 0, flash: 0, selectedGrenade: 'he', active: 2, pendingSlot: 0, switchEndsTick: 0 };
}

export function createPlayer(id: EntityId, team: Team, isBot: boolean, nameKey: string, pos: Vec3, yaw: number, money = 800): PlayerState {
  return {
    id, team, isBot, nameKey,
    pos: v3(pos.x, pos.y, pos.z), prevPos: v3(pos.x, pos.y, pos.z), vel: v3(), yaw, pitch: 0, prevYaw: yaw, prevPitch: 0,
    aimOffset: { yaw: 0, pitch: 0 }, heat: 0, shotIndex: 0, lastShotTick: -1000, triggerHeld: false,
    hp: 100, armor: 0, helmet: false, alive: true, crouched: false, wantCrouch: false, grounded: true, scoped: 0,
    money, inv: defaultInventory(team), reload: null, hasBomb: false, hasKit: false,
    use: { action: 'none', startTick: 0, endTick: 0, itemId: 0 },
    throwing: null, spectating: 0,
    blindUntilTick: 0, invulnerableUntilTick: 0, respawnTick: 0,
    lastDamage: { tick: -1000, from: v3(), amount: 0 }, deathTick: -1, deathDir: v3(0, 0, -1),
    legPhase: 0, distanceWalked: 0, lastFootstepDist: 0,
    stats: emptyStats(), lastBuy: [],
  };
}

export function createBotMemory(id: EntityId, profile: BotProfile, pos: Vec3): BotMemory {
  return {
    id, profile, state: 'DEAD', stateSinceTick: 0, goal: null, path: [], corners: [], pathIdx: 0,
    target: 0, targetSeenSinceTick: -1, targetLastSeenTick: -1000, lastKnown: null,
    aimErr: { x: 0, y: 0 }, aimErrUntilTick: 0, reactionUntilTick: 0, aimYaw: 0, aimPitch: 0,
    burstLeft: 0, pauseUntilTick: 0, holdUntilTick: 0, scanPhase: 0,
    stuckCheckPos: v3(pos.x, pos.y, pos.z), stuckTicks: 0, blockedNode: -1, blockedUntilTick: 0,
    peek: { active: false, dir: 1, untilTick: 0 },
  };
}

export function findPlayer(state: WorldState, id: EntityId): PlayerState | undefined {
  // players are sorted by ascending id; ids are dense for players (1..2n) so a direct index is usually right
  const guess = state.players[id - 1];
  if (guess && guess.id === id) return guess;
  return state.players.find((p) => p.id === id);
}

export function alivePlayers(state: WorldState, team?: Team): PlayerState[] {
  return state.players.filter((p) => p.alive && (team === undefined || p.team === team));
}

export function enemyTeam(t: Team): Team { return t === 'T' ? 'CT' : 'T'; }
