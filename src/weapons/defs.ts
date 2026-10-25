/** Weapon and item data, DESIGN.md §4.1 and §5. Display names come from i18n ('weapon.<id>'). */
import { v3, type Vec3 } from '../core/math';
import type { WeaponId, ItemId, Slot, Team, HitZone, PlayerState } from '../sim/state';
import { WEAPON_INDEX } from '../sim/state';
import { P_AK, P_M4, P_SMG, P_PISTOL, P_DEAGLE, P_AWP, P_NONE, type Pattern } from './patterns';

export { WEAPON_INDEX };

export interface WeaponDef {
  id: WeaponId; slot: Slot; type: 'melee' | 'pistol' | 'smg' | 'rifle' | 'sniper' | 'grenade';
  price: number; teams?: Team[];
  /** body damage (knife: slash) */
  dmg: number; melee?: { stab: number; stabRpm: number; backstabMult: number };
  headMult: 4; rpm: number; auto: boolean; mag: number; reserve: number; reloadSec: number;
  spread: { stand: number; move: number; crouch: number; scoped?: number; scopedMove?: number };
  perShot: number; heatRecover: number; pattern: Pattern; patternRecovery: number;
  speed: number; scopedSpeed?: number; falloff: number; ap: number;
  /** damage factor when continuing through a penetrable prop; null = never penetrates */
  penetration: number | null; penetratesTallCrate: boolean;
  killReward: number; switchSec: number; maxCarry?: number;
}

export const WEAPONS: Record<WeaponId, WeaponDef> = {
  knife: { id: 'knife', slot: 3, type: 'melee', price: 0, dmg: 40, melee: { stab: 65, stabRpm: 60, backstabMult: 3 }, headMult: 4, rpm: 120, auto: true, mag: 0, reserve: 0, reloadSec: 0, spread: { stand: 0, move: 0, crouch: 0 }, perShot: 0, heatRecover: 10, pattern: P_NONE, patternRecovery: 10, speed: 5.0, falloff: 1, ap: 0.85, penetration: null, penetratesTallCrate: false, killReward: 1500, switchSec: 0.25 },
  glock: { id: 'glock', slot: 2, type: 'pistol', price: 200, teams: ['T'], dmg: 30, headMult: 4, rpm: 400, auto: false, mag: 20, reserve: 120, reloadSec: 2.2, spread: { stand: 1.2, move: 4.0, crouch: 0.85 }, perShot: 0.35, heatRecover: 10, pattern: P_PISTOL, patternRecovery: 10, speed: 4.8, falloff: 0.90, ap: 0.47, penetration: null, penetratesTallCrate: false, killReward: 300, switchSec: 0.5 },
  usp: { id: 'usp', slot: 2, type: 'pistol', price: 200, teams: ['CT'], dmg: 35, headMult: 4, rpm: 350, auto: false, mag: 12, reserve: 24, reloadSec: 2.2, spread: { stand: 0.9, move: 3.5, crouch: 0.65 }, perShot: 0.35, heatRecover: 10, pattern: P_PISTOL, patternRecovery: 10, speed: 4.8, falloff: 0.91, ap: 0.50, penetration: null, penetratesTallCrate: false, killReward: 300, switchSec: 0.5 },
  deagle: { id: 'deagle', slot: 2, type: 'pistol', price: 700, dmg: 53, headMult: 4, rpm: 267, auto: false, mag: 7, reserve: 35, reloadSec: 2.2, spread: { stand: 1.0, move: 5.0, crouch: 0.7 }, perShot: 2.5, heatRecover: 5, pattern: P_DEAGLE, patternRecovery: 10, speed: 4.6, falloff: 0.87, ap: 0.93, penetration: 0.5, penetratesTallCrate: false, killReward: 300, switchSec: 0.5 },
  mp5: { id: 'mp5', slot: 1, type: 'smg', price: 1500, dmg: 27, headMult: 4, rpm: 750, auto: true, mag: 30, reserve: 120, reloadSec: 2.6, spread: { stand: 1.0, move: 2.0, crouch: 0.7 }, perShot: 0.25, heatRecover: 9, pattern: P_SMG, patternRecovery: 9, speed: 4.7, falloff: 0.85, ap: 0.62, penetration: null, penetratesTallCrate: false, killReward: 600, switchSec: 0.5 },
  ak47: { id: 'ak47', slot: 1, type: 'rifle', price: 2700, teams: ['T'], dmg: 36, headMult: 4, rpm: 600, auto: true, mag: 30, reserve: 90, reloadSec: 2.5, spread: { stand: 0.8, move: 5.5, crouch: 0.55 }, perShot: 0.45, heatRecover: 6, pattern: P_AK, patternRecovery: 6, speed: 4.3, falloff: 0.98, ap: 0.77, penetration: 0.6, penetratesTallCrate: false, killReward: 300, switchSec: 0.5 },
  m4a4: { id: 'm4a4', slot: 1, type: 'rifle', price: 3100, teams: ['CT'], dmg: 33, headMult: 4, rpm: 666, auto: true, mag: 30, reserve: 90, reloadSec: 3.1, spread: { stand: 0.6, move: 5.0, crouch: 0.45 }, perShot: 0.35, heatRecover: 7, pattern: P_M4, patternRecovery: 7, speed: 4.4, falloff: 0.97, ap: 0.70, penetration: 0.6, penetratesTallCrate: false, killReward: 300, switchSec: 0.5 },
  awp: { id: 'awp', slot: 1, type: 'sniper', price: 4750, dmg: 115, headMult: 4, rpm: 41, auto: false, mag: 5, reserve: 30, reloadSec: 3.6, spread: { stand: 8.0, move: 12, crouch: 7, scoped: 0.05, scopedMove: 6.0 }, perShot: 0, heatRecover: 10, pattern: P_AWP, patternRecovery: 10, speed: 4.0, scopedSpeed: 3.3, falloff: 0.99, ap: 0.97, penetration: 0.6, penetratesTallCrate: true, killReward: 100, switchSec: 0.5 },
  he: { id: 'he', slot: 4, type: 'grenade', price: 300, dmg: 98, headMult: 4, rpm: 60, auto: false, mag: 1, reserve: 0, reloadSec: 0, spread: { stand: 0, move: 0, crouch: 0 }, perShot: 0, heatRecover: 10, pattern: P_NONE, patternRecovery: 10, speed: 4.9, falloff: 1, ap: 0.5, penetration: null, penetratesTallCrate: false, killReward: 300, switchSec: 0.5, maxCarry: 1 },
  flash: { id: 'flash', slot: 4, type: 'grenade', price: 200, dmg: 0, headMult: 4, rpm: 60, auto: false, mag: 1, reserve: 0, reloadSec: 0, spread: { stand: 0, move: 0, crouch: 0 }, perShot: 0, heatRecover: 10, pattern: P_NONE, patternRecovery: 10, speed: 4.9, falloff: 1, ap: 0, penetration: null, penetratesTallCrate: false, killReward: 0, switchSec: 0.5, maxCarry: 2 },
};

export const ITEM_PRICES: Record<ItemId, number> = {
  knife: 0, glock: 200, usp: 200, deagle: 700, mp5: 1500, ak47: 2700, m4a4: 3100, awp: 4750, he: 300, flash: 200,
  kevlar: 650, kevlar_helmet: 1000, defuse_kit: 400, c4: 0,
};
export const HELMET_UPGRADE_PRICE = 350;
export const ZONE_MULT = { head: 4.0, chest: 1.0, stomach: 1.25, legs: 0.75 } as const;
export const AWP_LEG_DAMAGE = 85;
export const SWITCH_SEC = 0.5;
export const DEPLOY_SEC = 1.0;
export const AWP_BOLT_SEC = 1.46;
export const AWP_FOV = [75, 20, 10] as const;
export const HE = { radius: 3.5, dmg: 98, fuseSec: 2.0, ap: 0.5 } as const;
export const FLASH = { maxSec: 3.0, range: 20, fuseSec: 1.5 } as const;
/** friction = tangential speed kept per bounce; restitution = normal speed kept (§4.4). */
export const GRENADE = { speed: 12, shortSpeed: 7, shortHoldTicks: 18, radius: 0.07, gravity: 20, restitution: 0.45, friction: 0.7, pitchUp: 10 } as const;

export function isPrimary(id: WeaponId): boolean { return WEAPONS[id].slot === 1; }
export function isGrenade(id: WeaponId): boolean { return WEAPONS[id].slot === 4; }
export function teamRifle(team: Team): WeaponId { return team === 'T' ? 'ak47' : 'm4a4'; }
export function teamPistol(team: Team): WeaponId { return team === 'T' ? 'glock' : 'usp'; }

/** Hitbox geometry (§4.4), metres above the feet, in the victim's yaw-local frame (x = right, z = back). */
export const HITBOX = {
  headRadius: 0.16, headY: 1.6, headYCrouch: 1.1,
  halfX: 0.25, halfZ: 0.15,
  torso: { y0: 0.9, y1: 1.5 }, torsoCrouch: { y0: 0.6, y1: 1.1 },
  /** chest = upper 55 % of the torso box, stomach = lower 45 % */ chestFrac: 0.55,
} as const;
/** Training target: box 0.5 (x) × 1.8 (y) × 0.3 (z), feet at `pos`, axis-aligned. */
export const TARGET_BOX = { halfX: 0.25, height: 1.8, halfZ: 0.15 } as const;

export interface HitBox { zone: HitZone; min: Vec3; max: Vec3 }
export interface PlayerHitboxes { origin: Vec3; yaw: number; head: { center: Vec3; radius: number }; boxes: HitBox[] }

/** Hitboxes of a player: `origin` = feet, `yaw` = body yaw; `head.center` and `boxes` are yaw-local. `inflate` grows the outer
 * faces (knife sphere-cast). */
export function hitboxesFor(p: Pick<PlayerState, 'pos' | 'yaw' | 'crouched'>, inflate = 0): PlayerHitboxes {
  const t = p.crouched ? HITBOX.torsoCrouch : HITBOX.torso;
  const split = t.y1 - (t.y1 - t.y0) * HITBOX.chestFrac;
  const hx = HITBOX.halfX + inflate, hz = HITBOX.halfZ + inflate;
  const box = (zone: HitZone, y0: number, y1: number): HitBox => ({ zone, min: v3(-hx, y0 - (zone === 'legs' ? inflate : 0), -hz), max: v3(hx, y1 + (zone === 'chest' ? inflate : 0), hz) });
  return {
    origin: v3(p.pos.x, p.pos.y, p.pos.z), yaw: p.yaw,
    head: { center: v3(0, p.crouched ? HITBOX.headYCrouch : HITBOX.headY, 0), radius: HITBOX.headRadius + inflate },
    boxes: [box('chest', split, t.y1), box('stomach', t.y0, split), box('legs', 0, t.y0)],
  };
}
