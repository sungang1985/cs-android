/** Economy (§5): buy validation, rewards, loss ladder. Basic DAY-0 version; L4 completes and tests. */
import type { PlayerState, ItemId, WorldState, Team, WinReason, MoneyDelta, WeaponId } from '../sim/state';
import type { SimEventSink, SimEvents } from '../sim/events';
import type { CompiledMap } from '../world/types';
import { rectContains } from '../world/types';
import { WEAPONS, ITEM_PRICES, HELMET_UPGRADE_PRICE, type WeaponDef } from '../weapons/defs';
import { giveWeapon } from '../weapons/inventory';
import { MODES } from './modes';

export const ECON = { start: 800, max: 16000, winElim: 3250, winObjective: 3500, lossLadder: [1400, 1900, 2400, 2900, 3400], plantedLossBonus: 800, plantBonus: 300, defuseBonus: 300 } as const;

export function killReward(def: WeaponDef | null): number { return def ? def.killReward : 0; }

export function addMoney(state: WorldState, p: PlayerState, delta: number, reason: MoneyDelta['reason'], out: SimEventSink): number {
  const before = p.money;
  p.money = Math.max(0, Math.min(ECON.max, p.money + delta));
  const applied = p.money - before;
  if (applied !== 0) out.emit('money', { player: p.id, delta: applied, reason });
  return applied;
}

export function onKill(state: WorldState, killer: PlayerState, weapon: WeaponId | 'fall' | 'bomb', out: SimEventSink): void {
  if (!MODES[state.cfg.mode].economy) return;
  const def = weapon === 'fall' || weapon === 'bomb' ? null : WEAPONS[weapon];
  const r = killReward(def);
  if (r > 0) addMoney(state, killer, r, 'kill', out);
}

export function canBuyNow(p: PlayerState, state: WorldState, map: CompiledMap): boolean {
  const mode = MODES[state.cfg.mode];
  if (mode.buyAnywhere) return p.alive;
  if (!p.alive) return false;
  if (state.tick > state.round.buyWindowEndsTick) return false;
  const zone = map.areas.find((a) => a.id === (p.team === 'T' ? 't_spawn' : 'ct_spawn'));
  return !!zone && rectContains(zone.rect, p.pos.x, p.pos.z);
}

export function canBuy(p: PlayerState, item: ItemId, state: WorldState, map: CompiledMap): { ok: true; price: number } | { ok: false; error: NonNullable<SimEvents['buy']['error']> } {
  const mode = MODES[state.cfg.mode];
  if (!mode.buyAnywhere) {
    if (state.tick > state.round.buyWindowEndsTick) return { ok: false, error: 'window' };
    if (!canBuyNow(p, state, map)) return { ok: false, error: 'zone' };
  }
  let price = mode.economy ? ITEM_PRICES[item] : 0;
  if (item === 'c4' || item === 'knife') return { ok: false, error: 'owned' };
  if (item === 'kevlar') { if (p.armor >= 100) return { ok: false, error: 'owned' }; }
  else if (item === 'kevlar_helmet') { if (p.armor >= 100 && p.helmet) return { ok: false, error: 'owned' }; if (p.armor > 0 && !p.helmet && mode.economy) price = p.armor >= 100 ? HELMET_UPGRADE_PRICE : ITEM_PRICES.kevlar_helmet; }
  else if (item === 'defuse_kit') { if (p.team !== 'CT') return { ok: false, error: 'team' }; if (p.hasKit) return { ok: false, error: 'owned' }; }
  else {
    const def = WEAPONS[item];
    if (def.teams && !def.teams.includes(p.team)) return { ok: false, error: 'team' };
    if (def.slot === 4) { const n = item === 'he' ? p.inv.he : p.inv.flash; if (n >= (def.maxCarry ?? 1)) return { ok: false, error: 'max' }; }
    else if (def.slot === 1 && p.inv.primary?.id === item) return { ok: false, error: 'owned' };
    else if (def.slot === 2 && p.inv.pistol.id === item) return { ok: false, error: 'owned' };
  }
  if (p.money < price) return { ok: false, error: 'money' };
  return { ok: true, price };
}

export function buy(p: PlayerState, item: ItemId, state: WorldState, map: CompiledMap, out: SimEventSink): boolean {
  const r = canBuy(p, item, state, map);
  if (!r.ok) { out.emit('buy', { player: p.id, item, ok: false, error: r.error }); return false; }
  if (r.price > 0) addMoney(state, p, -r.price, 'buy', out);
  if (item === 'kevlar') p.armor = 100;
  else if (item === 'kevlar_helmet') { p.armor = 100; p.helmet = true; }
  else if (item === 'defuse_kit') p.hasKit = true;
  else {
    giveWeapon(p, item as WeaponId);
    const def = WEAPONS[item as WeaponId];
    if (def.slot === 1 || def.slot === 2) { p.inv.active = def.slot; p.inv.pendingSlot = 0; }
  }
  p.lastBuy.push(item);
  out.emit('buy', { player: p.id, item, ok: true });
  return true;
}

/** Round-end money (§5): called once on entering ROUND_END. Returns the applied deltas. */
export function awardRoundEnd(state: WorldState, winner: Team | null, reason: WinReason, out: SimEventSink): MoneyDelta[] {
  const deltas: MoneyDelta[] = [];
  if (!MODES[state.cfg.mode].economy || state.round.suddenDeath) return deltas;
  const winAmount = reason === 'bomb' || reason === 'defuse' ? ECON.winObjective : ECON.winElim;
  const planted = state.bomb.state === 'planted' || state.bomb.state === 'exploded' || state.bomb.state === 'defused';
  for (const team of ['T', 'CT'] as const) {
    const won = winner === team;
    const streakKey = team === 'T' ? 'lossStreakT' : 'lossStreakCT';
    if (won) state.round[streakKey] = Math.max(0, state.round[streakKey] - 1);
    else if (winner !== null) state.round[streakKey] += 1;
    const lossBonus = ECON.lossLadder[Math.min(ECON.lossLadder.length, Math.max(1, state.round[streakKey])) - 1];
    for (const p of state.players) {
      if (p.team !== team) continue;
      let delta = 0, r: MoneyDelta['reason'] = 'loss';
      if (won) { delta = winAmount; r = 'win'; }
      else if (winner !== null) {
        delta = lossBonus;
        if (team === 'T' && reason === 'time' && p.alive) delta = 0;
        if (team === 'T' && planted) { delta += ECON.plantedLossBonus; r = 'plantedLoss'; }
      }
      if (delta !== 0) { const applied = addMoney(state, p, delta, r, out); deltas.push({ player: p.id, delta: applied, reason: r }); }
    }
  }
  return deltas;
}
