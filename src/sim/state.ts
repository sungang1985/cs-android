/**
 * Shared simulation state types (frozen day 0). Plain data only: no methods, no classes, structuredClone/JSON safe.
 * Imports only types from core. Every lane imports this module. See DESIGN.md §11.4 and §11.7.
 */
import type { Vec3 } from '../core/math';
import type { RngState } from '../core/rng';

export type EntityId = number;
export type Team = 'T' | 'CT';
export type WeaponId = 'knife' | 'glock' | 'usp' | 'deagle' | 'mp5' | 'ak47' | 'm4a4' | 'awp' | 'he' | 'flash';
/** Fixed order; snapshots use the index, −1 = none. */
export const WEAPON_INDEX: readonly WeaponId[] = ['knife', 'glock', 'usp', 'deagle', 'mp5', 'ak47', 'm4a4', 'awp', 'he', 'flash'];
export type ItemId = WeaponId | 'kevlar' | 'kevlar_helmet' | 'defuse_kit' | 'c4';
/** 1 primary, 2 pistol, 3 knife, 4 grenade (the C4 has no slot). */
export type Slot = 1 | 2 | 3 | 4;
export type HitZone = 'head' | 'chest' | 'stomach' | 'legs';
export type SurfaceId = 'concrete' | 'wood' | 'metal' | 'sand';
export type ModeId = 'defusal' | 'tdm' | 'training';
export type Difficulty = 'easy' | 'normal' | 'hard';
export type RoundPhase = 'WARMUP' | 'FREEZE' | 'LIVE' | 'PLANTED' | 'SUDDEN_DEATH' | 'ROUND_END' | 'MATCH_END';
export type WinReason = 'elimination' | 'bomb' | 'defuse' | 'time' | 'draw';
export type BotStateId = 'DEAD' | 'BUY' | 'PLAN' | 'MOVE' | 'HOLD' | 'INVESTIGATE' | 'ENGAGE' | 'HUNT' | 'RETREAT' | 'PLANT' | 'DEFUSE';

export interface WeaponSlotState { id: WeaponId; mag: number; reserve: number }
export interface Inventory {
  primary: WeaponSlotState | null; pistol: WeaponSlotState; knife: true;
  he: number; flash: number; selectedGrenade: 'he' | 'flash';
  active: Slot; pendingSlot: Slot | 0; switchEndsTick: number;
}
export interface ReloadState { startTick: number; endTick: number; weapon: WeaponId }
export interface PlayerStats { kills: number; deaths: number; headshots: number; shots: number; hits: number; damage: number; plants: number; defuses: number; mvps: number }

export interface PlayerState {
  id: EntityId; team: Team; isBot: boolean; nameKey: string;
  pos: Vec3; prevPos: Vec3; vel: Vec3; yaw: number; pitch: number; prevYaw: number; prevPitch: number;
  /** Radians. Recoil aim punch; camera shows half of it (§4.3). */
  aimOffset: { yaw: number; pitch: number }; heat: number; shotIndex: number; lastShotTick: number; triggerHeld: boolean;
  hp: number; armor: number; helmet: boolean; alive: boolean; crouched: boolean; wantCrouch: boolean; grounded: boolean; scoped: 0 | 1 | 2;
  money: number; inv: Inventory; reload: ReloadState | null; hasBomb: boolean; hasKit: boolean;
  use: { action: 'none' | 'plant' | 'defuse' | 'pickup'; startTick: number; endTick: number; itemId: EntityId };
  /** §4.4 throw protocol: THROW held since startTick; returns to returnSlot after the throw. */
  throwing: { startTick: number; returnSlot: Slot } | null;
  /** Dead players: whom the camera follows (sim-owned, §2.2). */
  spectating: EntityId | 0;
  blindUntilTick: number; invulnerableUntilTick: number; respawnTick: number;
  lastDamage: { tick: number; from: Vec3; amount: number }; deathTick: number; deathDir: Vec3;
  legPhase: number; distanceWalked: number; lastFootstepDist: number;
  stats: PlayerStats; lastBuy: ItemId[];
}
export interface GrenadeState { id: EntityId; kind: 'he' | 'flash'; owner: EntityId; team: Team; pos: Vec3; prevPos: Vec3; vel: Vec3; explodeTick: number; bounces: number }
export interface ItemState { id: EntityId; kind: 'weapon' | 'bomb' | 'kit'; weapon?: WeaponSlotState; pos: Vec3; yaw: number; droppedTick: number }
export interface TargetState { id: EntityId; pos: Vec3; up: boolean; downUntilTick: number }
export interface BombState { state: 'none' | 'carried' | 'dropped' | 'planted' | 'exploded' | 'defused'; carrier: EntityId | 0; itemId: EntityId | 0; pos: Vec3; plantedTick: number; explodeTick: number; site: 'a' | 'b' | null }
export interface RoundState {
  phase: RoundPhase; phaseEndsTick: number; roundNumber: number; half: 1 | 2; suddenDeath: boolean;
  winner: Team | null; reason: WinReason | null; scoreT: number; scoreCT: number; lossStreakT: number; lossStreakCT: number;
  buyWindowEndsTick: number; mvp: EntityId | 0; tdmKillsT: number; tdmKillsCT: number;
  lastKill: { killer: EntityId | 0; victim: EntityId; headshot: boolean; weapon: WeaponId | 'fall' | 'bomb'; tick: number } | null;
}
export interface Blackboard {
  lastEnemySeen: { id: EntityId; pos: Vec3; tick: number; confidence: 0.5 | 1; by: EntityId }[];
  bombPos: Vec3 | null; plannedSite: 'a' | 'b' | null; assignments: Record<EntityId, Goal>; rotateCalledTick: number;
}
export interface Goal { kind: 'site' | 'hold' | 'bomb' | 'investigate' | 'roam' | 'pickup'; pos: Vec3; holdSpot?: string; site?: 'a' | 'b'; untilTick?: number }
export interface BotMemory {
  id: EntityId; profile: BotProfile; state: BotStateId; stateSinceTick: number; goal: Goal | null;
  /** Nav node ids of the current path (for blocked-node re-plans and debug dumps). */
  path: number[];
  /** pullString(path): the waypoints steering follows. */
  corners: Vec3[]; pathIdx: number;
  target: EntityId | 0; targetSeenSinceTick: number; targetLastSeenTick: number; lastKnown: Vec3 | null;
  aimErr: { x: number; y: number }; aimErrUntilTick: number; reactionUntilTick: number; aimYaw: number; aimPitch: number;
  burstLeft: number; pauseUntilTick: number; holdUntilTick: number; scanPhase: number;
  stuckCheckPos: Vec3; stuckTicks: number; blockedNode: number; blockedUntilTick: number;
  peek: { active: boolean; dir: number; untilTick: number };
}
export interface BotProfile { nameKey: string; difficulty: Difficulty; preferredWeapon: 'rifle' | 'smg' | 'awp'; aggression: number; holdPreference: number }
/** Human-only gameplay options the SIM needs (bots: always on); copied from Settings by app/matchSettings.ts. */
export interface MatchOptions { autoPickup: boolean; scopeHold: boolean }
export interface MatchConfig {
  mode: ModeId; seed: number; humanTeam: Team; difficulty: Difficulty; teamSize: 2 | 3 | 5; roundsToWin: 4 | 6 | 8;
  tdmSeconds: number; tdmKills: number; mapId: 'depot'; options: MatchOptions;
}

export type RngStreamName = 'fire' | 'spread' | 'ai' | 'spawn' | 'misc';

export interface WorldState {
  cfg: MatchConfig; tick: number; nextId: EntityId;
  /** Copy of the RngStreams state written at the end of every step (§11.10). */
  rng: Record<RngStreamName, RngState>;
  players: PlayerState[];          // ascending id
  grenades: GrenadeState[]; items: ItemState[]; targets: TargetState[];
  bomb: BombState; round: RoundState;
  teams: { T: Blackboard; CT: Blackboard };
  bots: BotMemory[];               // one per bot, ascending id
  humanId: EntityId;               // always 1
  /** Pushed by damage code during a tick, consumed by sim/death.ts; always [] between steps. */
  pendingDeaths: DeathInfo[];
}

export interface DeathInfo { victim: EntityId; killer: EntityId | 0; weapon: WeaponId | 'fall' | 'bomb'; headshot: boolean; dir: Vec3 /* attacker → victim, unit */; point: Vec3 }
export type MoneyReason = 'kill' | 'plant' | 'defuse' | 'win' | 'loss' | 'plantedLoss' | 'buy' | 'halfReset';
export interface MoneyDelta { player: EntityId; delta: number; reason: MoneyReason }
/** Computed by sim/candidates.ts, consumed by input/aimAssist.ts. */
export interface AimCandidate { id: EntityId; chest: Vec3; radius: number; vel: Vec3 }
/** ABSOLUTE radians: the input layer's look incl. the not-yet-consumed drag delta, after aim assist. */
export interface LookPreview { yaw: number; pitch: number }
/** App-side radar list built from `spotted` events. */
export interface Spotted { enemy: EntityId; x: number; z: number; yaw: number; tick: number }

export const TEAM_INDEX: Record<Team, 0 | 1> = { T: 0, CT: 1 };
export const ROUND_PHASE_INDEX: Record<RoundPhase, number> = { WARMUP: 0, FREEZE: 1, LIVE: 2, PLANTED: 3, SUDDEN_DEATH: 4, ROUND_END: 5, MATCH_END: 6 };
export const BOMB_STATE_INDEX: Record<BombState['state'], number> = { none: 0, carried: 1, dropped: 2, planted: 3, exploded: 4, defused: 5 };
export const USE_ACTION_INDEX: Record<PlayerState['use']['action'], number> = { none: 0, plant: 1, defuse: 2, pickup: 3 };
export const ITEM_KIND_INDEX: Record<ItemState['kind'], number> = { weapon: 0, bomb: 1, kit: 2 };
export const GRENADE_INDEX: Record<'he' | 'flash', 0 | 1> = { he: 0, flash: 1 };

/** Index of a weapon id in WEAPON_INDEX, −1 for none; −2 = fall, −3 = bomb (lastKill only). */
export function weaponIndex(id: WeaponId | 'fall' | 'bomb' | null | undefined): number {
  if (!id) return -1;
  if (id === 'fall') return -2;
  if (id === 'bomb') return -3;
  return WEAPON_INDEX.indexOf(id);
}

// ───────── InputCommand (§7.8) ─────────
export const Btn = { FIRE: 1, SCOPE: 2, JUMP: 4, CROUCH: 8, RELOAD: 16, USE: 32, WALK: 64, DROP: 128, THROW: 256 } as const;
export type BtnFlag = (typeof Btn)[keyof typeof Btn];

export interface InputCommand {
  tick: number;
  /** Body-local, |(moveX, moveZ)| ≤ 1; +Z forward, +X right. */
  moveX: number; moveZ: number;
  /** ABSOLUTE view angles (radians); the input layer accumulates deltas, sens, accel, gyro and aim assist. */
  yaw: number; pitch: number;
  /** Btn bitfield, latched per tick. */
  buttons: number;
  /** 0 = no change; 1 primary, 2 pistol, 3 knife, 4 grenade. */
  slot: 0 | 1 | 2 | 3 | 4;
  /** 0 keep, 1 HE, 2 flash (selection). */
  grenade: 0 | 1 | 2;
  /** Processed by rules/economy.ts if allowed. */
  buy: ItemId | null;
  /** Dead players only: cycle the spectated teammate. */
  spectate: -1 | 0 | 1;
}
export const IDLE_COMMAND: Readonly<InputCommand> = Object.freeze({ tick: 0, moveX: 0, moveZ: 0, yaw: 0, pitch: 0, buttons: 0, slot: 0, grenade: 0, buy: null, spectate: 0 });
export function cloneCommand(c: Readonly<InputCommand> = IDLE_COMMAND, tick = c.tick): InputCommand {
  return { tick, moveX: c.moveX, moveZ: c.moveZ, yaw: c.yaw, pitch: c.pitch, buttons: c.buttons, slot: c.slot, grenade: c.grenade, buy: c.buy, spectate: c.spectate };
}

// ───────── RenderSnapshot (§11.7) ─────────
export interface SnapPlayer {
  id: number; nameKey: string; team: 0 | 1; alive: 0 | 1; x: number; y: number; z: number; yaw: number; pitch: number; crouch: 0 | 1;
  weapon: number; legPhase: number; hp: number; armor: number; helmet: 0 | 1; reloadT: number; scoped: 0 | 1; flinchT: number; deathT: number;
  hasBomb: 0 | 1; hasKit: 0 | 1; using: 0 | 1; kills: number; deaths: number; money: number;
}
export interface SnapGrenade { id: number; kind: 0 | 1; x: number; y: number; z: number }
export interface SnapItem { id: number; kind: 0 | 1 | 2; weapon: number; x: number; y: number; z: number; yaw: number }
export interface SnapTarget { id: number; x: number; y: number; z: number; up: 0 | 1 }
export interface SnapLocal {
  id: number; alive: 0 | 1; hp: number; armor: number; helmet: 0 | 1; money: number; weapon: number; mag: number; reserve: number;
  primary: number; pistol: number; he: number; flash: number; selectedGrenade: 0 | 1; activeSlot: number;
  aimOffsetYaw: number; aimOffsetPitch: number; spreadDeg: number; crosshairTarget: 0 | 1 | 2; speed: number; grounded: 0 | 1; crouch: 0 | 1;
  scoped: 0 | 1 | 2; useAction: 0 | 1 | 2 | 3; useProgress: number; canBuy: 0 | 1; buyWindowRemaining: number; hasBomb: 0 | 1; hasKit: 0 | 1;
  eyeX: number; eyeY: number; eyeZ: number; x: number; z: number; throwHoldT: number;
  blindT: number; damageDirYaw: number; damageT: number; spectating: number; killerId: number;
  lastKill: { killer: number; victim: number; headshot: 0 | 1; weapon: number; t: number };
}
export interface RenderSnapshot {
  tick: number; time: number;
  playerCount: number; players: SnapPlayer[];
  grenadeCount: number; grenades: SnapGrenade[];
  itemCount: number; items: SnapItem[];
  targetCount: number; targets: SnapTarget[];
  bomb: { state: 0 | 1 | 2 | 3 | 4 | 5; x: number; y: number; z: number; remaining: number; carrier: number };
  round: { phase: number; remaining: number; roundNumber: number; scoreT: number; scoreCT: number; aliveT: number; aliveCT: number; suddenDeath: 0 | 1 };
  local: SnapLocal;
}
export const SNAPSHOT_CAPACITY = { players: 10, grenades: 16, items: 32, targets: 8 } as const;

function emptyPlayer(): SnapPlayer {
  return { id: 0, nameKey: '', team: 0, alive: 0, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, crouch: 0, weapon: -1, legPhase: 0, hp: 0, armor: 0, helmet: 0, reloadT: -1, scoped: 0, flinchT: -1, deathT: -1, hasBomb: 0, hasKit: 0, using: 0, kills: 0, deaths: 0, money: -1 };
}
/** Allocates every capacity once; writeSnapshot overwrites fields in place. */
export function createSnapshot(): RenderSnapshot {
  return {
    tick: 0, time: 0,
    playerCount: 0, players: Array.from({ length: SNAPSHOT_CAPACITY.players }, emptyPlayer),
    grenadeCount: 0, grenades: Array.from({ length: SNAPSHOT_CAPACITY.grenades }, () => ({ id: 0, kind: 0 as 0 | 1, x: 0, y: 0, z: 0 })),
    itemCount: 0, items: Array.from({ length: SNAPSHOT_CAPACITY.items }, () => ({ id: 0, kind: 0 as 0 | 1 | 2, weapon: -1, x: 0, y: 0, z: 0, yaw: 0 })),
    targetCount: 0, targets: Array.from({ length: SNAPSHOT_CAPACITY.targets }, () => ({ id: 0, x: 0, y: 0, z: 0, up: 1 as 0 | 1 })),
    bomb: { state: 0, x: 0, y: 0, z: 0, remaining: 0, carrier: 0 },
    round: { phase: 0, remaining: 0, roundNumber: 0, scoreT: 0, scoreCT: 0, aliveT: 0, aliveCT: 0, suddenDeath: 0 },
    local: {
      id: 0, alive: 0, hp: 0, armor: 0, helmet: 0, money: 0, weapon: -1, mag: 0, reserve: 0,
      primary: -1, pistol: -1, he: 0, flash: 0, selectedGrenade: 0, activeSlot: 2,
      aimOffsetYaw: 0, aimOffsetPitch: 0, spreadDeg: 0, crosshairTarget: 0, speed: 0, grounded: 1, crouch: 0,
      scoped: 0, useAction: 0, useProgress: 0, canBuy: 0, buyWindowRemaining: 0, hasBomb: 0, hasKit: 0,
      eyeX: 0, eyeY: 1.65, eyeZ: 0, x: 0, z: 0, throwHoldT: -1,
      blindT: 0, damageDirYaw: 0, damageT: -1, spectating: 0, killerId: 0,
      lastKill: { killer: 0, victim: 0, headshot: 0, weapon: -1, t: -1 },
    },
  };
}

// ───────── Body / eye constants shared by sim, hitscan, renderer (§0) ─────────
export const BODY = { halfWidth: 0.3, standHeight: 1.8, crouchHeight: 1.3, standEye: 1.65, crouchEye: 1.15, stepHeight: 0.5 } as const;
export const DT = 1 / 60;
export const TICKS_PER_SEC = 60;
export function eyeHeight(p: Pick<PlayerState, 'crouched'>): number { return p.crouched ? BODY.crouchEye : BODY.standEye; }
