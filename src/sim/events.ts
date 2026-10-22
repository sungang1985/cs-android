/**
 * Simulation events (frozen day 0). Payloads are plain data. Imports only sim/state and core types. DESIGN.md §11.5.
 */
import type { Vec3 } from '../core/math';
import type { EventBus, EventEnvelope } from '../core/events';
import type { EntityId, Team, WeaponId, HitZone, SurfaceId, RoundPhase, WinReason, MoneyDelta, MoneyReason, ItemId, ItemState, BotStateId } from './state';

export type SoundId =
  | 'fire_glock' | 'fire_usp' | 'fire_deagle' | 'fire_mp5' | 'fire_ak' | 'fire_m4' | 'fire_awp'
  | 'knife_swing' | 'knife_hit' | 'knife_stab' | 'reload_out' | 'reload_in' | 'reload_bolt' | 'switch_weapon' | 'dryfire'
  | 'footstep_concrete' | 'footstep_metal' | 'footstep_wood' | 'footstep_sand' | 'jump' | 'land'
  | 'impact_concrete' | 'impact_wood' | 'impact_metal' | 'impact_sand' | 'bullet_whiz' | 'death'
  | 'he_pin' | 'he_bounce' | 'he_explode' | 'flash_explode'
  | 'bomb_plant' | 'bomb_defuse_tick' | 'bomb_defused' | 'bomb_explode' | 'bomb_pickup';

export interface SimEvents {
  roundPhase: { phase: RoundPhase; round: number; endsTick: number };
  roundEnd: { winner: Team | null; reason: WinReason; mvp: EntityId; deltas: MoneyDelta[] };
  matchEnd: { result: Team | 'draw'; scoreT: number; scoreCT: number };
  respawn: { player: EntityId; pos: Vec3 };
  shot: { shooter: EntityId; weapon: WeaponId; origin: Vec3; dir: Vec3; end: Vec3; hitPlayer: EntityId | 0 };
  hit: { attacker: EntityId; victim: EntityId; weapon: WeaponId; zone: HitZone; damage: number; armored: boolean; point: Vec3 };
  impact: { point: Vec3; normal: Vec3; surface: SurfaceId };
  nearMiss: { listener: EntityId; point: Vec3 };
  damageTaken: { victim: EntityId; from: Vec3; amount: number; hpLeft: number };
  death: { victim: EntityId; killer: EntityId | 0; weapon: WeaponId | 'fall' | 'bomb'; headshot: boolean; pos: Vec3; dir: Vec3 };
  footstep: { player: EntityId; pos: Vec3; surface: SurfaceId; walking: boolean };
  jump: { player: EntityId; pos: Vec3 };
  land: { player: EntityId; pos: Vec3; impact: number };
  reload: { player: EntityId; weapon: WeaponId; phase: 'start' | 'mid' | 'end' };
  weaponSwitch: { player: EntityId; weapon: WeaponId };
  dryFire: { player: EntityId; pos: Vec3 };
  knife: { player: EntityId; pos: Vec3; hit: boolean; stab: boolean };
  grenadeThrow: { id: EntityId; kind: 'he' | 'flash'; owner: EntityId; pos: Vec3 };
  grenadeBounce: { id: EntityId; pos: Vec3; surface: SurfaceId };
  grenadeExplode: { id: EntityId; kind: 'he' | 'flash'; pos: Vec3 };
  blinded: { player: EntityId; seconds: number };
  bombPickup: { player: EntityId };
  bombDrop: { pos: Vec3 };
  bombPlantStart: { player: EntityId };
  bombPlantStop: { player: EntityId };
  bombPlanted: { player: EntityId; pos: Vec3; site: 'a' | 'b' };
  bombDefuseStart: { player: EntityId; kit: boolean };
  bombDefuseStop: { player: EntityId };
  bombDefused: { player: EntityId };
  bombExploded: { pos: Vec3 };
  itemDrop: { id: EntityId; kind: ItemState['kind']; pos: Vec3 };
  itemPickup: { id: EntityId; player: EntityId; kind: ItemState['kind'] };
  money: { player: EntityId; delta: number; reason: MoneyReason };
  buy: { player: EntityId; item: ItemId; ok: boolean; error?: 'money' | 'window' | 'zone' | 'owned' | 'team' | 'max' };
  /** The ONLY source of world audio (§9.3) AND of bot hearing (§6.3). loudness = hearing radius in metres. */
  sound: { id: SoundId; pos: Vec3; loudness: number; player: EntityId | 0 };
  /** Radar; emitted by brains (ctx.out) and by sim/candidates.ts for the human. */
  spotted: { team: Team; enemy: EntityId; pos: Vec3; by: EntityId };
  targetHit: { id: EntityId };
  targetReset: { id: EntityId };
  /** Debug overlay only. */
  botState: { bot: EntityId; state: BotStateId };
}

export type SimEventSink = { emit<K extends keyof SimEvents>(k: K, e: SimEvents[K]): void };
export type SimEventBus = EventBus<SimEvents>;
export type SimEnvelope = EventEnvelope<SimEvents>;

/** Loudness table (§11.5): callers pass these so the emission table lives in one place. */
export const LOUDNESS = {
  fire_pistol: 30, fire_smg: 40, fire_rifle: 40, fire_awp: 60,
  knife: 8, dryfire: 3, switch: 3, reload: 8, impact: 10, whiz: 5,
  footstep: 10, jump: 8, land: 10,
  he_pin: 5, he_bounce: 15, he_explode: 60, flash_explode: 60,
  bomb_plant: 25, bomb_defuse_tick: 15, bomb_defused: 30, bomb_explode: 1000, bomb_pickup: 5,
  death: 15,
} as const;
