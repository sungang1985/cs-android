/** Bot/auto-buy planner (§5.2). DAY-0 STUB: simple priority list; L4 implements the full table. */
import type { ItemId, Team, Inventory } from '../sim/state';
import { ITEM_PRICES } from '../weapons/defs';

export function buyPlan(money: number, team: Team, owned: Inventory & { armor: number; helmet: boolean; hasKit: boolean }, prefs: { sniper: boolean }, teamLossStreak: number, teamHasAwp: boolean, isLastRoundOfHalf: boolean): ItemId[] {
  void teamLossStreak; void isLastRoundOfHalf;
  const plan: ItemId[] = [];
  let m = money;
  const take = (item: ItemId) => { const price = ITEM_PRICES[item]; if (m >= price) { plan.push(item); m -= price; return true; } return false; };
  const rifle: ItemId = team === 'T' ? 'ak47' : 'm4a4';
  if (!owned.primary) {
    if (prefs.sniper && !teamHasAwp && m >= 5750) take('awp');
    else if (m >= 3900) take(rifle);
    else if (m >= 2100) take('mp5');
  }
  if (owned.armor < 100) { if (!take('kevlar_helmet')) take('kevlar'); }
  if (team === 'CT' && !owned.hasKit) take('defuse_kit');
  if (owned.he < 1) take('he');
  if (owned.flash < 2) take('flash');
  if (!owned.primary && owned.pistol.id !== 'deagle' && m >= 700 && money < 2100) take('deagle');
  return plan;
}
