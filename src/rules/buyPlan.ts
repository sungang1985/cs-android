/**
 * Shared buy planner (§5.2, used by bots and the 「自动 / Auto」 tile) and the quick-buy presets (§5.1). Pure.
 * Prices come from rules/loadout.itemCost, i.e. exactly what rules/economy.buy will charge.
 */
import type { ItemId, Team, Inventory } from '../sim/state';
import { ITEM_PRICES, WEAPONS, teamRifle } from '../weapons/defs';
import { itemCost, applyToHolder, holderFromOwned, isWeaponItem, type ItemHolder } from './loadout';

export type Owned = Inventory & { armor: number; helmet: boolean; hasKit: boolean };
export type PresetId = 'full' | 'force' | 'awp';

/** Quick-buy presets (§5.1); 「自动」 = buyPlan(), 「重买」 = planPurchase(lastBuy, …). */
export function presetItems(id: PresetId, team: Team): ItemId[] {
  switch (id) {
    case 'full': return team === 'CT' ? [teamRifle(team), 'kevlar_helmet', 'he', 'flash', 'defuse_kit'] : [teamRifle(team), 'kevlar_helmet', 'he', 'flash'];
    case 'force': return ['kevlar', 'deagle'];
    case 'awp': return ['awp', 'kevlar_helmet'];
  }
}

/** Accepts either buyPlan's `owned` shape (Inventory & armour) or a flat ItemHolder; always returns a fresh copy. */
function toHolder(o: Owned | ItemHolder): ItemHolder { return typeof o.pistol === 'string' ? { ...(o as ItemHolder) } : holderFromOwned(o as Owned); }
function cloneHolder(h: ItemHolder): ItemHolder { return { ...h }; }

/**
 * Buys `items` in order the way the buy menu does: items already owned (or team-locked / at max carry) are skipped,
 * the helmet is priced as the $350 upgrade once a vest is owned, and the list stops at the FIRST unaffordable item.
 * Returns the items that would actually be bought.
 */
export function planPurchase(items: readonly ItemId[], money: number, team: Team, owned: Owned | ItemHolder): ItemId[] {
  const h = toHolder(owned);
  const out: ItemId[] = [];
  let m = money;
  for (const it of items) {
    const c = itemCost(it, team, h);
    if (!c.ok) continue;
    if (c.price > m) break;
    m -= c.price; out.push(it); applyToHolder(it, h);
  }
  return out;
}

/** Total price of `items` bought in order from `owned` (skipping owned items), ignoring money. */
export function planCost(items: readonly ItemId[], team: Team, owned: Owned | ItemHolder): number {
  const plan = planPurchase(items, Number.POSITIVE_INFINITY, team, owned);
  const h = toHolder(owned);
  let total = 0;
  for (const it of plan) { const c = itemCost(it, team, h); if (c.ok) total += c.price; applyToHolder(it, h); }
  return total;
}

/**
 * One planner tier: the core items must all be affordable together (items already owned cost nothing, and a planned
 * primary is skipped when an equal-or-pricier primary is already owned); optional extras are then added in order while
 * the remaining money covers each of them. Returns null when the core is unaffordable.
 */
function tier(core: readonly ItemId[], extras: readonly ItemId[], money: number, team: Team, start: ItemHolder): ItemId[] | null {
  const h = cloneHolder(start);
  const plan: ItemId[] = [];
  let m = money;
  for (const it of core) {
    if (isWeaponItem(it) && WEAPONS[it].slot === 1 && h.primary && ITEM_PRICES[h.primary] >= ITEM_PRICES[it]) continue;
    const c = itemCost(it, team, h);
    if (!c.ok) { if (c.error === 'team') return null; continue; }
    if (c.price > m) return null;
    m -= c.price; plan.push(it); applyToHolder(it, h);
  }
  for (const it of extras) {
    const c = itemCost(it, team, h);
    if (!c.ok || c.price > m) continue;
    m -= c.price; plan.push(it); applyToHolder(it, h);
  }
  return plan;
}

/**
 * §5.2 table, top to bottom (thresholds are the core prices, so with nothing owned they are exactly 5,750 /
 * rifle + 1,000 / 2,500 / 1,350 / 650):
 *   sniper pref && !teamHasAwp && ≥ 5,750 → awp, kevlar_helmet (+ he, + flash)
 *   ≥ rifle + 1,000                       → rifle, kevlar_helmet (+ he, + flash, + kit for CT)
 *   ≥ 2,500                               → mp5, kevlar_helmet
 *   ≥ 1,350                               → deagle, kevlar
 *   ≥ 650 && (lossStreak ≥ 2 || last round of the half) → kevlar
 *   else                                  → [] (eco)
 * Owned items are skipped (helmet = $350 upgrade over an owned vest); the returned list is in purchase order.
 */
export function buyPlan(money: number, team: Team, owned: Owned, prefs: { sniper: boolean }, teamLossStreak: number, teamHasAwp: boolean, isLastRoundOfHalf: boolean): ItemId[] {
  const h = holderFromOwned(owned);
  const rifle = teamRifle(team);
  const tiers: { when: boolean; core: ItemId[]; extras: ItemId[] }[] = [
    { when: prefs.sniper && !teamHasAwp, core: ['awp', 'kevlar_helmet'], extras: ['he', 'flash'] },
    { when: true, core: [rifle, 'kevlar_helmet'], extras: ['he', 'flash', 'defuse_kit'] },
    { when: true, core: ['mp5', 'kevlar_helmet'], extras: [] },
    { when: true, core: ['deagle', 'kevlar'], extras: [] },
    { when: teamLossStreak >= 2 || isLastRoundOfHalf, core: ['kevlar'], extras: [] },
  ];
  for (const t of tiers) {
    if (!t.when) continue;
    const plan = tier(t.core, t.extras, money, team, h);
    if (plan) return plan;
  }
  return [];
}
