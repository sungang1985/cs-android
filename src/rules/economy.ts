/**
 * Economy (§5): buy validation and purchases, kill rewards, plant/defuse bonuses (paid by bomb.ts via addMoney) and
 * the round-end win/loss resolution. Money changes always go through addMoney (clamped to [0, 16,000], emits `money`).
 */
import type { PlayerState, ItemId, WorldState, Team, WinReason, MoneyDelta, WeaponId } from '../sim/state';
import type { SimEventSink, SimEvents } from '../sim/events';
import type { CompiledMap, WorldRect } from '../world/types';
import { rectContains } from '../world/types';
import { WEAPONS, type WeaponDef } from '../weapons/defs';
import { dropItem } from '../weapons/items';
import { MODES } from './modes';
import { itemCost, holderOf, grantItem, equipSlot, rememberBuy, isWeaponItem } from './loadout';

export { isWeaponItem } from './loadout';

export const ECON = { start: 800, max: 16000, winElim: 3250, winObjective: 3500, lossLadder: [1400, 1900, 2400, 2900, 3400], plantedLossBonus: 800, plantBonus: 300, defuseBonus: 300 } as const;

export type BuyError = NonNullable<SimEvents['buy']['error']>;

export function killReward(def: WeaponDef | null): number { return def ? def.killReward : 0; }

/** Loss bonus for a team whose streak (after counting this loss) is `streak` (1 … 5+). */
export function lossBonus(streak: number): number {
  const ladder = ECON.lossLadder;
  return ladder[Math.min(ladder.length, Math.max(1, streak)) - 1];
}

export function addMoney(state: WorldState, p: PlayerState, delta: number, reason: MoneyDelta['reason'], out: SimEventSink): number {
  void state;
  const before = p.money;
  p.money = Math.max(0, Math.min(ECON.max, p.money + delta));
  const applied = p.money - before;
  if (applied !== 0) out.emit('money', { player: p.id, delta: applied, reason });
  return applied;
}

/** Kill reward by weapon (§4.1); nothing outside the economy mode, in sudden death, or for bomb/fall kills. */
export function onKill(state: WorldState, killer: PlayerState, weapon: WeaponId | 'fall' | 'bomb', out: SimEventSink): void {
  if (!MODES[state.cfg.mode].economy || state.round.suddenDeath) return;
  const def = weapon === 'fall' || weapon === 'bomb' ? null : WEAPONS[weapon];
  const r = killReward(def);
  if (r > 0) addMoney(state, killer, r, 'kill', out);
}

/** The player's own spawn area rect (`t_spawn` / `ct_spawn`). */
export function buyZone(team: Team, map: CompiledMap): WorldRect | null {
  const id = team === 'T' ? 't_spawn' : 'ct_spawn';
  const a = map.areas.find((x) => x.id === id);
  return a ? a.rect : null;
}

/** Buy window (§2.2): FREEZE + the first 10 s of LIVE, i.e. `tick < round.buyWindowEndsTick` (−1 in sudden death). */
export function inBuyWindow(state: WorldState): boolean {
  const r = state.round;
  return (r.phase === 'FREEZE' || r.phase === 'LIVE') && state.tick < r.buyWindowEndsTick;
}

/** Window AND zone (TDM/training: anywhere, any time — alive only). Used by writeSnapshot and the Buy pill. */
export function canBuyNow(p: PlayerState, state: WorldState, map: CompiledMap): boolean {
  if (!p.alive) return false;
  if (MODES[state.cfg.mode].buyAnywhere) return true;
  if (!inBuyWindow(state)) return false;
  const zone = buyZone(p.team, map);
  return !!zone && rectContains(zone, p.pos.x, p.pos.z);
}

/**
 * Validation order: window → zone → team lock → owned → max carry → money. Prices: §4.1/§5 incl. the $350 helmet
 * upgrade (vest > 0, no helmet) and the $650 Kevlar refill (vest < 100); every price is 0 when the mode has no economy.
 */
export function canBuy(p: PlayerState, item: ItemId, state: WorldState, map: CompiledMap): { ok: true; price: number } | { ok: false; error: BuyError } {
  const mode = MODES[state.cfg.mode];
  if (!p.alive) return { ok: false, error: 'window' };
  if (!mode.buyAnywhere) {
    if (!inBuyWindow(state)) return { ok: false, error: 'window' };
    const zone = buyZone(p.team, map);
    if (!zone || !rectContains(zone, p.pos.x, p.pos.z)) return { ok: false, error: 'zone' };
  }
  const c = itemCost(item, p.team, holderOf(p));
  if (!c.ok) return c;
  const price = mode.economy ? c.price : 0;
  if (p.money < price) return { ok: false, error: 'money' };
  return { ok: true, price };
}

/**
 * Buys `item`: pays, grants, auto-equips a bought primary/pistol with the 1.0 s deploy (inv.active = slot,
 * pendingSlot = 0, switchEndsTick = tick + 60) and records it in lastBuy. In the economy mode a replaced primary is
 * dropped as a world item (CS rule); in free modes it is simply replaced. Emits `money` (reason `buy`) and `buy`.
 */
export function buy(p: PlayerState, item: ItemId, state: WorldState, map: CompiledMap, out: SimEventSink): boolean {
  const r = canBuy(p, item, state, map);
  if (!r.ok) { out.emit('buy', { player: p.id, item, ok: false, error: r.error }); return false; }
  const economy = MODES[state.cfg.mode].economy;
  if (r.price > 0) addMoney(state, p, -r.price, 'buy', out);
  if (economy && p.inv.primary && isWeaponItem(item) && WEAPONS[item].slot === 1) dropItem(state, p, 'weapon', out);
  const slot = grantItem(p, item, economy);
  if (slot) {
    equipSlot(p, slot, state.tick);
    out.emit('weaponSwitch', { player: p.id, weapon: item as WeaponId });
  }
  rememberBuy(p, item);
  out.emit('buy', { player: p.id, item, ok: true });
  return true;
}

/**
 * Round-end money (§5), called once on entering ROUND_END; returns the applied deltas (zero deltas are omitted).
 * Winner: $3,250 (elimination/time) or $3,500 (bomb/defuse) each, streak = max(0, streak − 1). Loser: streak += 1,
 * loss bonus from the ladder (reason `loss`) except Ts alive at a CT `time` win ($0); if the bomb was planted this
 * round and T lost, every T additionally gets +$800 as a separate `plantedLoss` delta. Draws and sudden death change
 * nothing; neither does a mode without economy.
 */
export function awardRoundEnd(state: WorldState, winner: Team | null, reason: WinReason, out: SimEventSink): MoneyDelta[] {
  const deltas: MoneyDelta[] = [];
  if (!MODES[state.cfg.mode].economy || state.round.suddenDeath || winner === null) return deltas;
  const winAmount = reason === 'bomb' || reason === 'defuse' ? ECON.winObjective : ECON.winElim;
  const b = state.bomb.state;
  const planted = b === 'planted' || b === 'exploded' || b === 'defused';
  const r = state.round;
  const pay = (p: PlayerState, amount: number, why: MoneyDelta['reason']) => {
    const applied = addMoney(state, p, amount, why, out);
    if (applied !== 0) deltas.push({ player: p.id, delta: applied, reason: why });
  };
  for (const team of ['T', 'CT'] as const) {
    const won = winner === team;
    if (team === 'T') r.lossStreakT = won ? Math.max(0, r.lossStreakT - 1) : r.lossStreakT + 1;
    else r.lossStreakCT = won ? Math.max(0, r.lossStreakCT - 1) : r.lossStreakCT + 1;
    const bonus = lossBonus(team === 'T' ? r.lossStreakT : r.lossStreakCT);
    for (const p of state.players) {
      if (p.team !== team) continue;
      if (won) { pay(p, winAmount, 'win'); continue; }
      if (!(team === 'T' && reason === 'time' && p.alive)) pay(p, bonus, 'loss');
      if (team === 'T' && planted) pay(p, ECON.plantedLossBonus, 'plantedLoss');
    }
  }
  return deltas;
}
