/**
 * Item ownership, pricing and granting (§4.1 gear rules, §5), shared by economy.ts (buying), buyPlan.ts (planner and
 * presets), modes/tdm.ts (respawn loadout) and round.ts (sudden-death loadout). Pure; imports no other rules module so
 * there are no import cycles.
 */
import { v3 } from '../core/math';
import type { PlayerState, ItemId, WeaponId, Team, Inventory } from '../sim/state';
import { WEAPONS, ITEM_PRICES, HELMET_UPGRADE_PRICE, teamRifle } from '../weapons/defs';
import { giveWeapon } from '../weapons/inventory';
import { defaultInventory } from '../sim/entities';

/** Deploy time after a purchase (§4.1 "deploy after purchase 1.0 s"). */
export const DEPLOY_TICKS = 60;

/** What the buyer currently owns, flattened (built from a PlayerState or from buyPlan's `owned`). */
export interface ItemHolder { primary: WeaponId | null; pistol: WeaponId; he: number; flash: number; armor: number; helmet: boolean; hasKit: boolean }

export type CostResult = { ok: true; price: number } | { ok: false; error: 'owned' | 'team' | 'max' };

export function isWeaponItem(item: ItemId): item is WeaponId { return Object.prototype.hasOwnProperty.call(WEAPONS, item); }

export function holderOf(p: Pick<PlayerState, 'inv' | 'armor' | 'helmet' | 'hasKit'>): ItemHolder {
  return { primary: p.inv.primary ? p.inv.primary.id : null, pistol: p.inv.pistol.id, he: p.inv.he, flash: p.inv.flash, armor: p.armor, helmet: p.helmet, hasKit: p.hasKit };
}

export function holderFromOwned(o: Inventory & { armor: number; helmet: boolean; hasKit: boolean }): ItemHolder {
  return { primary: o.primary ? o.primary.id : null, pistol: o.pistol.id, he: o.he, flash: o.flash, armor: o.armor, helmet: o.helmet, hasKit: o.hasKit };
}

/**
 * Kevlar+Helmet purchase case (§4.1): `owned` (full vest + helmet), `refill` (helmet kept, vest < 100 → $650, vest
 * refilled), `upgrade` (vest > 0 without helmet → $350, adds the helmet only; the vest value is unchanged — refill it
 * with Kevlar), `full` (no vest → $1,000, vest 100 + helmet).
 */
export function kevlarHelmetCase(armor: number, helmet: boolean): 'owned' | 'refill' | 'upgrade' | 'full' {
  if (helmet && armor >= 100) return 'owned';
  if (helmet && armor > 0) return 'refill';
  if (!helmet && armor > 0) return 'upgrade';
  return 'full';
}

/** Economy price of `item` for a buyer of `team` owning `h` (no window/zone/money checks). */
export function itemCost(item: ItemId, team: Team, h: ItemHolder): CostResult {
  switch (item) {
    case 'c4': case 'knife': return { ok: false, error: 'owned' };
    case 'kevlar': return h.armor >= 100 ? { ok: false, error: 'owned' } : { ok: true, price: ITEM_PRICES.kevlar };
    case 'kevlar_helmet': {
      const c = kevlarHelmetCase(h.armor, h.helmet);
      if (c === 'owned') return { ok: false, error: 'owned' };
      return { ok: true, price: c === 'refill' ? ITEM_PRICES.kevlar : c === 'upgrade' ? HELMET_UPGRADE_PRICE : ITEM_PRICES.kevlar_helmet };
    }
    case 'defuse_kit':
      if (team !== 'CT') return { ok: false, error: 'team' };
      return h.hasKit ? { ok: false, error: 'owned' } : { ok: true, price: ITEM_PRICES.defuse_kit };
    default: {
      const def = WEAPONS[item];
      if (def.teams && !def.teams.includes(team)) return { ok: false, error: 'team' };
      if (def.slot === 4) {
        const n = item === 'he' ? h.he : h.flash;
        if (n >= (def.maxCarry ?? 1)) return { ok: false, error: 'max' };
      } else if (def.slot === 1 && h.primary === item) return { ok: false, error: 'owned' };
      else if (def.slot === 2 && h.pistol === item) return { ok: false, error: 'owned' };
      return { ok: true, price: ITEM_PRICES[item] };
    }
  }
}

/** Applies a purchase to a simulated holder (planner). `upgrade` keeps the vest value, like the real purchase. */
export function applyToHolder(item: ItemId, h: ItemHolder): void {
  switch (item) {
    case 'kevlar': h.armor = 100; break;
    case 'kevlar_helmet': if (kevlarHelmetCase(h.armor, h.helmet) !== 'upgrade') h.armor = 100; h.helmet = true; break;
    case 'defuse_kit': h.hasKit = true; break;
    case 'c4': case 'knife': break;
    default: {
      const def = WEAPONS[item];
      if (def.slot === 1) h.primary = item; else if (def.slot === 2) h.pistol = item;
      else if (item === 'he') h.he = Math.min(def.maxCarry ?? 1, h.he + 1);
      else if (item === 'flash') h.flash = Math.min(def.maxCarry ?? 2, h.flash + 1);
    }
  }
}

/**
 * Grants `item` to `p` without money or validation. `paid` selects the economy semantics of Kevlar+Helmet (an
 * upgrade adds only the helmet); free grants (TDM, training, sudden death) always give vest 100 + helmet.
 * Returns the weapon slot to equip (1 or 2) or 0 when nothing should be equipped.
 */
export function grantItem(p: PlayerState, item: ItemId, paid: boolean): 0 | 1 | 2 {
  switch (item) {
    case 'kevlar': p.armor = 100; return 0;
    case 'kevlar_helmet':
      if (!paid || kevlarHelmetCase(p.armor, p.helmet) !== 'upgrade') p.armor = 100;
      p.helmet = true; return 0;
    case 'defuse_kit': p.hasKit = true; return 0;
    case 'c4': case 'knife': return 0;
    default: {
      giveWeapon(p, item);
      const slot = WEAPONS[item].slot;
      return slot === 1 || slot === 2 ? slot : 0;
    }
  }
}

/** Equips slot 1/2 with the purchase deploy delay (§4.1: 1.0 s); the weapons lane respects switchEndsTick. */
export function equipSlot(p: PlayerState, slot: 1 | 2, tick: number, deployTicks = DEPLOY_TICKS): void {
  p.inv.active = slot; p.inv.pendingSlot = 0; p.inv.switchEndsTick = tick + deployTicks;
  p.reload = null; p.scoped = 0;
}

type BuyGroup = 'primary' | 'pistol' | 'armor' | 'kit' | 'he' | 'flash' | 'none';
function buyGroup(item: ItemId): BuyGroup {
  switch (item) {
    case 'kevlar': case 'kevlar_helmet': return 'armor';
    case 'defuse_kit': return 'kit';
    case 'c4': case 'knife': return 'none';
    case 'he': return 'he';
    case 'flash': return 'flash';
    default: return WEAPONS[item].slot === 1 ? 'primary' : 'pistol';
  }
}

/**
 * Records a purchase in `p.lastBuy` (defusal: this round's purchases, reset at round start; TDM: the remembered
 * respawn loadout). Kept as a valid, bounded loadout: a newer primary/pistol/kit replaces the older one, Kevlar never
 * downgrades an earlier Kevlar+Helmet, grenades are capped at their carry limit.
 */
export function rememberBuy(p: PlayerState, item: ItemId): void {
  const g = buyGroup(item);
  if (g === 'none') return;
  const list = p.lastBuy;
  if (g === 'he' || g === 'flash') {
    const n = list.filter((i) => i === item).length;
    if (n < (WEAPONS[item as WeaponId].maxCarry ?? 1)) list.push(item);
    return;
  }
  if (g === 'armor' && item === 'kevlar' && list.includes('kevlar_helmet')) return;
  for (let i = list.length - 1; i >= 0; i--) if (buyGroup(list[i]) === g) list.splice(i, 1);
  list.push(item);
}

/** Resets everything owned to the team default (default pistol + knife, no armor, no kit, no bomb). */
export function resetLoadout(p: PlayerState): void {
  p.inv = defaultInventory(p.team);
  p.armor = 0; p.helmet = false; p.hasKit = false; p.hasBomb = false;
}

/** Default loadout + `items` granted for free (TDM respawn loadout). Equips the primary if any, without deploy delay. */
export function applyFreeLoadout(p: PlayerState, items: readonly ItemId[]): void {
  resetLoadout(p);
  for (const it of items) grantItem(p, it, false);
  p.inv.active = p.inv.primary ? 1 : 2; p.inv.pendingSlot = 0; p.inv.switchEndsTick = 0;
}

/** §2.2 sudden death: team rifle + Kevlar+Helmet + default pistol, rifle in hand. */
export function suddenDeathLoadout(p: PlayerState): void {
  resetLoadout(p);
  giveWeapon(p, teamRifle(p.team));
  p.armor = 100; p.helmet = true;
  p.inv.active = 1; p.inv.pendingSlot = 0; p.inv.switchEndsTick = 0;
}

/**
 * Puts `p` alive at `pos`/`yaw` with every transient field reset (round start, TDM/training respawn). Does not touch
 * the inventory, money, stats or team.
 */
export function placeAtSpawn(p: PlayerState, pos: { x: number; y: number; z: number }, yaw: number): void {
  p.pos = v3(pos.x, pos.y, pos.z); p.prevPos = v3(pos.x, pos.y, pos.z); p.vel = v3();
  p.yaw = yaw; p.pitch = 0; p.prevYaw = yaw; p.prevPitch = 0;
  p.hp = 100; p.alive = true; p.grounded = true; p.crouched = false; p.wantCrouch = false; p.scoped = 0;
  p.deathTick = -1; p.reload = null; p.throwing = null; p.triggerHeld = false;
  p.use = { action: 'none', startTick: 0, endTick: 0, itemId: 0 };
  p.spectating = 0; p.blindUntilTick = 0; p.invulnerableUntilTick = 0;
  p.aimOffset.yaw = 0; p.aimOffset.pitch = 0; p.heat = 0; p.shotIndex = 0;
  p.lastDamage = { tick: -1000, from: v3(), amount: 0 };
}
