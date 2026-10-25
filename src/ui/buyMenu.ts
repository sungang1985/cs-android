/**
 * Buy menu (§8.4, §5.1): one screen, 5 quick-buy presets + 4 columns of tiles. Affordability is computed here
 * from SnapLocal (rules/economy.canBuy needs a PlayerState): ITEM_PRICES, the $350 helmet upgrade, max grenades
 * (HE 1 / flash 2), owned items and team locks; the sim stays authoritative and its denied `buy` events drive the
 * 「钱不够」 toast in the Hud. 「自动」 = rules/buyPlan. Purchases are sent one per ≥ 1 tick through onBuy because
 * InputCommand.buy carries a single item per tick.
 */
import type { EventBus } from '../core/events';
import { WEAPON_INDEX, type SnapLocal, type Team, type ItemId, type WeaponId, type Inventory } from '../sim/state';
import { WEAPONS, ITEM_PRICES, HELMET_UPGRADE_PRICE, teamRifle, teamPistol } from '../weapons/defs';
import { buyPlan } from '../rules/buyPlan';
import { persist } from '../platform/persist';
import { onLocaleChange } from '../i18n/i18n';
import type { UiEvents } from './dom';
import { el, elt, tr, fmtMoney, fmtPrice, fmtClock, TextCell, FlagCell, button } from './dom';
import { iconImg, type IconId } from './icons';
import { shared } from './context';

// ───────── pure affordability model (unit-tested) ─────────

export interface BuyCtx { money: number; team: Team; primary: WeaponId | null; pistol: WeaponId | null; he: number; flash: number; armor: number; helmet: boolean; hasKit: boolean; /** economy off (TDM / training): items are free */ free: boolean }

function weaponAt(i: number): WeaponId | null { return i >= 0 && i < WEAPON_INDEX.length ? WEAPON_INDEX[i] : null; }

/** TDM/training report buyWindowRemaining = −1 (buy anywhere, economy off). */
export function buyCtxFromLocal(local: SnapLocal, team: Team): BuyCtx {
  return { money: local.money, team, primary: weaponAt(local.primary), pistol: weaponAt(local.pistol), he: local.he, flash: local.flash, armor: local.armor, helmet: local.helmet === 1, hasKit: local.hasKit === 1, free: local.buyWindowRemaining < 0 };
}

export interface ItemStatus { item: ItemId; price: number; owned: boolean; locked: boolean; max: boolean; affordable: boolean; buyable: boolean }

/** Price for this player now: Kevlar+Helmet is the $350 upgrade when armor > 0 and no helmet (§4.1). */
export function itemPrice(item: ItemId, c: BuyCtx): number {
  if (c.free) return 0;
  if (item === 'kevlar_helmet' && c.armor > 0 && !c.helmet) return HELMET_UPGRADE_PRICE;
  return ITEM_PRICES[item];
}

export function itemStatus(item: ItemId, c: BuyCtx): ItemStatus {
  const price = itemPrice(item, c);
  let owned = false, locked = false, max = false;
  switch (item) {
    case 'kevlar': owned = c.armor >= 100; break;
    case 'kevlar_helmet': owned = c.armor >= 100 && c.helmet; break;
    case 'defuse_kit': locked = c.team !== 'CT'; owned = c.hasKit; break;
    case 'c4': case 'knife': owned = true; break;
    default: {
      const def = WEAPONS[item];
      locked = !!def.teams && !def.teams.includes(c.team);
      if (def.slot === 4) max = (item === 'he' ? c.he : c.flash) >= (def.maxCarry ?? 1);
      else if (def.slot === 1) owned = c.primary === item;
      else if (def.slot === 2) owned = c.pistol === item;
    }
  }
  const affordable = c.money >= price;
  return { item, price, owned, locked, max, affordable, buyable: !owned && !locked && !max && affordable };
}

/** The player's state after buying `item` (used to plan presets in order). */
export function applyBuy(c: BuyCtx, item: ItemId): BuyCtx {
  const n: BuyCtx = { ...c, money: c.money - itemPrice(item, c) };
  if (item === 'kevlar') n.armor = 100;
  else if (item === 'kevlar_helmet') { n.armor = 100; n.helmet = true; }
  else if (item === 'defuse_kit') n.hasKit = true;
  else if (item === 'he') n.he++;
  else if (item === 'flash') n.flash++;
  else if (item !== 'c4' && item !== 'knife') { const def = WEAPONS[item]; if (def.slot === 1) n.primary = item; else if (def.slot === 2) n.pistol = item; }
  return n;
}

export interface PurchasePlan { items: ItemId[]; total: number; blockedBy: ItemId | null; after: BuyCtx }

/** §5.1: buys in order, skipping what is owned / team-locked / at max, and stops at the first unaffordable item. */
export function planPurchases(list: readonly ItemId[], c0: BuyCtx): PurchasePlan {
  let c = c0, total = 0;
  const items: ItemId[] = [];
  for (const item of list) {
    const s = itemStatus(item, c);
    if (s.owned || s.locked || s.max) continue;
    if (!s.affordable) return { items, total, blockedBy: item, after: c };
    items.push(item); total += s.price; c = applyBuy(c, item);
  }
  return { items, total, blockedBy: null, after: c };
}

export type PresetId = 'full' | 'force' | 'awp' | 'auto' | 'rebuy';
export const PRESET_IDS: readonly PresetId[] = ['full', 'force', 'awp', 'auto', 'rebuy'];

/** `owned` argument of rules/buyPlan built from the snapshot. */
export function ownedForPlan(c: BuyCtx): Inventory & { armor: number; helmet: boolean; hasKit: boolean } {
  return {
    primary: c.primary ? { id: c.primary, mag: WEAPONS[c.primary].mag, reserve: WEAPONS[c.primary].reserve } : null,
    pistol: { id: c.pistol ?? teamPistol(c.team), mag: 0, reserve: 0 }, knife: true, he: c.he, flash: c.flash,
    selectedGrenade: 'he', active: 2, pendingSlot: 0, switchEndsTick: 0, armor: c.armor, helmet: c.helmet, hasKit: c.hasKit,
  };
}

/** Item list of a preset (§5.1 table). */
export function presetItems(id: PresetId, c: BuyCtx, rebuy: readonly ItemId[] = []): ItemId[] {
  switch (id) {
    case 'full': return c.team === 'CT' ? [teamRifle(c.team), 'kevlar_helmet', 'he', 'flash', 'defuse_kit'] : [teamRifle(c.team), 'kevlar_helmet', 'he', 'flash'];
    case 'force': return ['kevlar', 'deagle'];
    case 'awp': return ['awp', 'kevlar_helmet'];
    case 'auto': return buyPlan(c.money, c.team, ownedForPlan(c), { sniper: false }, 0, false, false);
    case 'rebuy': return [...rebuy];
  }
}

export interface PresetSummary { id: PresetId; plan: PurchasePlan; price: number; optional: number; affordable: boolean; empty: boolean }

/** Display state of a preset tile: required price (+ optional CT kit), 可负担 / 钱不够, nothing-to-buy. */
export function presetSummary(id: PresetId, c: BuyCtx, rebuy: readonly ItemId[] = []): PresetSummary {
  const list = presetItems(id, c, rebuy);
  const optionalItems: ItemId[] = id === 'full' && c.team === 'CT' ? ['defuse_kit'] : [];
  const required = list.filter((i) => !optionalItems.includes(i));
  const rich: BuyCtx = { ...c, money: Number.POSITIVE_INFINITY };
  const price = planPurchases(required, rich).total;
  const optional = planPurchases(list, rich).total - price;
  const plan = planPurchases(list, c);
  const reqPlan = planPurchases(required, c);
  const empty = planPurchases(list, rich).items.length === 0;
  return { id, plan, price, optional, affordable: !empty && reqPlan.blockedBy === null, empty };
}

export const BUY_COLUMNS: ReadonlyArray<{ key: string; items: readonly ItemId[] }> = [
  { key: 'ui.buy.col.pistols', items: ['glock', 'usp', 'deagle'] },
  { key: 'ui.buy.col.rifles', items: ['mp5', 'ak47', 'm4a4'] },
  { key: 'ui.buy.col.gear', items: ['awp', 'kevlar', 'kevlar_helmet', 'defuse_kit'] },
  { key: 'ui.buy.col.grenades', items: ['he', 'flash'] },
];

export function itemNameKey(item: ItemId): string { return item === 'kevlar' || item === 'kevlar_helmet' || item === 'defuse_kit' || item === 'c4' ? 'item.' + item : 'weapon.' + item; }
export function itemIcon(item: ItemId): IconId { return item === 'kevlar' ? 'kevlar' : item === 'kevlar_helmet' ? 'helmet' : item === 'defuse_kit' ? 'kit' : item === 'c4' ? 'bomb' : item; }

// ───────── persisted loadout (cs.v1.loadout): last purchases for 「重买」 + the 「连续购买」 toggle ─────────

export interface Loadout { items: ItemId[]; continuous: boolean }
const ALL_ITEMS = new Set<string>(Object.keys(ITEM_PRICES));
export function readLoadout(): Loadout {
  const v = persist.get<unknown>('loadout', null);
  const clean = (a: unknown): ItemId[] => (Array.isArray(a) ? a.filter((x): x is ItemId => typeof x === 'string' && ALL_ITEMS.has(x)) : []);
  if (Array.isArray(v)) return { items: clean(v), continuous: false };   // legacy ItemId[] value
  if (v && typeof v === 'object') { const o = v as Partial<Loadout>; return { items: clean(o.items), continuous: o.continuous === true }; }
  return { items: [], continuous: false };
}

/** Gap between queued purchases: ≥ 1 sim tick even at the 30 fps cap. */
export const BUY_SPACING_MS = 70;

interface TileCells { btn: HTMLButtonElement; price: TextCell; badge: TextCell; owned: FlagCell; locked: FlagCell; poor: FlagCell; max: FlagCell }
interface PresetCells { btn: HTMLButtonElement; price: TextCell; state: TextCell; poor: FlagCell; empty: FlagCell }

export class BuyMenu {
  private readonly root: HTMLElement;
  private handler: ((item: ItemId) => void) | null = null;
  private ctx: BuyCtx | null = null;
  private team: Team = 'CT';
  private canBuy = 0; private remaining = 0; private lastRemaining = -2;
  private opened = false;
  private continuous: boolean;
  private rebuy: ItemId[];
  private windowBuys: ItemId[] = [];
  private queue: ItemId[] = [];
  private queueTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly tiles = new Map<ItemId, TileCells>();
  private readonly presets = new Map<PresetId, PresetCells>();
  private built: Team | null = null;
  private moneyCell: TextCell | null = null; private timerCell: TextCell | null = null; private noteCell: TextCell | null = null; private contFlag: FlagCell | null = null;

  constructor(parent: HTMLElement, private readonly bus: EventBus<UiEvents>) {
    this.root = el('div', { class: 'buy is-hidden', 'data-testid': 'screen-buy', role: 'dialog' });
    this.root.addEventListener('pointerdown', (e) => e.stopPropagation());
    parent.append(this.root);
    const lo = readLoadout();
    this.rebuy = lo.items; this.continuous = lo.continuous;
    shared(bus).buyMenu = this;
    onLocaleChange(() => { if (this.built) { this.build(); this.refresh(); } });
  }

  open(local: SnapLocal, team: Team): void {
    this.team = team;
    this.ingest(local);
    if (this.built !== team) this.build();
    this.refresh();
    if (!this.opened) { this.opened = true; this.root.classList.remove('is-hidden'); this.bus.emit('screen', { name: 'buy', visible: true }); }
  }

  close(): void {
    if (!this.opened) return;
    this.opened = false; this.root.classList.add('is-hidden');
    this.bus.emit('screen', { name: 'buy', visible: false });
  }

  get isOpen(): boolean { return this.opened; }
  onBuy(fn: (item: ItemId) => void): void { this.handler = fn; }

  /** 20 Hz (the Hud forwards every snapshot; game.ts may also call it): refreshes affordability, auto-closes when the buy window ends. */
  update(local: SnapLocal, team?: Team): void {
    if (team && team !== this.team) { this.team = team; if (this.built) this.build(); }
    const was = this.canBuy;
    this.ingest(local);
    if (!this.opened) return;
    if (was === 1 && local.canBuy === 0) { this.close(); return; }
    this.refresh();
  }

  private ingest(local: SnapLocal): void {
    const rem = local.buyWindowRemaining;
    // a new buy window (next round's FREEZE): this window's purchases become 「重买」
    if (rem >= 0 && rem > this.lastRemaining + 0.5) { if (this.windowBuys.length) this.rebuy = this.windowBuys; this.windowBuys = []; }
    this.lastRemaining = rem; this.remaining = rem; this.canBuy = local.canBuy;
    this.ctx = buyCtxFromLocal(local, this.team);
  }

  private persistLoadout(): void { persist.set<Loadout>('loadout', { items: this.windowBuys.length ? this.windowBuys : this.rebuy, continuous: this.continuous }); }

  private build(): void {
    this.built = this.team;
    this.tiles.clear(); this.presets.clear();
    const money = el('span', { class: 'buy-money', 'data-testid': 'buy-money' });
    const timer = el('span', { class: 'buy-timer', 'data-testid': 'buy-timer' });
    const cont = button('ui.buy.continuous', 'buy-continuous', () => { this.continuous = !this.continuous; this.contFlag?.set(this.continuous); cont.setAttribute('aria-pressed', String(this.continuous)); this.persistLoadout(); }, 'btn-toggle buy-cont');
    cont.setAttribute('aria-pressed', String(this.continuous));
    this.moneyCell = new TextCell(money); this.timerCell = new TextCell(timer);
    this.contFlag = new FlagCell(cont, 'is-on'); this.contFlag.set(this.continuous);
    const head = el('div', { class: 'buy-head' }, [elt('h2', 'ui.buy.title'), timer, el('span', { class: 'spacer' }), cont, money]);
    const presets = el('div', { class: 'buy-presets' });
    for (const id of PRESET_IDS) presets.append(this.presetTile(id));
    const cols = el('div', { class: 'buy-cols' });
    for (const col of BUY_COLUMNS) {
      const c = el('div', { class: 'buy-col' }, [elt('h3', col.key)]);
      for (const item of col.items) c.append(this.itemTile(item));
      cols.append(c);
    }
    const note = el('div', { class: 'buy-note', 'data-testid': 'buy-note' });
    this.noteCell = new TextCell(note);
    const close = button('ui.buy.close', 'btn-closeBuy', () => { this.close(); this.bus.emit('action', { id: 'closeBuy' }); }, 'btn buy-close');
    this.root.replaceChildren(head, presets, cols, note, close);
  }

  private itemTile(item: ItemId): HTMLElement {
    const btn = el('button', { class: 'buy-tile', 'data-testid': `buy-${item}`, type: 'button' });
    const price = el('span', { class: 'tile-price' }), badge = el('span', { class: 'tile-badge' });
    btn.append(iconImg(itemIcon(item), 'tile-icon'), el('span', { class: 'tile-text' }, [elt('span', itemNameKey(item), { class: 'tile-name' }), price]), badge);
    btn.addEventListener('click', () => this.tapItem(item));
    this.tiles.set(item, { btn, price: new TextCell(price), badge: new TextCell(badge), owned: new FlagCell(btn, 'is-owned'), locked: new FlagCell(btn, 'is-locked'), poor: new FlagCell(btn, 'is-poor'), max: new FlagCell(btn, 'is-max') });
    return btn;
  }

  private presetTile(id: PresetId): HTMLElement {
    const btn = el('button', { class: `buy-preset preset-${id}`, 'data-testid': `buy-preset-${id}`, type: 'button' });
    const price = el('span', { class: 'preset-price' }), state = el('span', { class: 'preset-state' });
    btn.append(elt('span', `ui.buy.preset.${id}`, { class: 'preset-name' }), price, state);
    btn.addEventListener('click', () => this.tapPreset(id));
    this.presets.set(id, { btn, price: new TextCell(price), state: new TextCell(state), poor: new FlagCell(btn, 'is-poor'), empty: new FlagCell(btn, 'is-empty') });
    return btn;
  }

  private refresh(): void {
    const c = this.ctx; if (!c) return;
    this.moneyCell?.set(c.free ? tr('ui.buy.free') : fmtMoney(c.money));
    this.timerCell?.set(this.remaining < 0 ? tr('ui.buy.unlimited') : this.canBuy ? tr('ui.buy.timeLeft', { time: fmtClock(this.remaining) }) : '');
    this.noteCell?.set(this.canBuy ? '' : tr(this.remaining > 0 ? 'ui.buy.notInZone' : 'ui.buy.closed'));
    for (const [item, t] of this.tiles) {
      const s = itemStatus(item, c);
      t.price.set(s.locked ? '' : fmtPrice(s.price));
      t.owned.set(s.owned); t.locked.set(s.locked); t.max.set(s.max); t.poor.set(!s.owned && !s.locked && !s.max && !s.affordable);
      t.badge.set(s.owned ? '✓' : s.locked ? '🔒' : s.max ? tr('ui.buy.max') : '');
    }
    for (const [id, p] of this.presets) {
      const sum = presetSummary(id, c, this.rebuy);
      p.price.set(sum.empty ? '—' : fmtPrice(sum.price) + (sum.optional ? ` (+${fmtPrice(sum.optional)})` : ''));
      p.state.set(tr(sum.empty ? (id === 'rebuy' && this.rebuy.length === 0 ? 'ui.buy.noRebuy' : 'ui.buy.ownedAll') : sum.affordable ? 'ui.buy.affordable' : 'ui.buy.poor'));
      p.poor.set(!sum.empty && !sum.affordable); p.empty.set(sum.empty);
    }
  }

  private tapItem(item: ItemId): void {
    const c = this.ctx; if (!c) return;
    const s = itemStatus(item, c);
    if (s.owned || s.locked || s.max) return;
    this.dispatch([item]);                       // unaffordable → the sim denies → 「钱不够」 toast + denied sound
    if (s.affordable && this.canBuy && !this.continuous) this.close();
  }

  private tapPreset(id: PresetId): void {
    const c = this.ctx; if (!c) return;
    const sum = presetSummary(id, c, this.rebuy);
    if (sum.plan.items.length === 0) { if (sum.plan.blockedBy) this.dispatch([sum.plan.blockedBy]); return; }
    this.dispatch(sum.plan.items);
    if (this.canBuy && !this.continuous) this.close();
  }

  /** Optimistically applies the purchases, remembers them for 「重买」 and sends them one per tick. */
  private dispatch(items: ItemId[]): void {
    for (const it of items) {
      if (!this.ctx) break;
      const s = itemStatus(it, this.ctx);
      if (s.buyable && this.canBuy) { this.ctx = applyBuy(this.ctx, it); this.windowBuys.push(it); }
    }
    this.persistLoadout();
    this.queue.push(...items);
    this.pump();
    this.refresh();
  }

  private pump(): void {
    if (this.queueTimer || this.queue.length === 0) return;
    const item = this.queue.shift()!;
    this.handler?.(item);
    if (this.queue.length) this.queueTimer = setTimeout(() => { this.queueTimer = null; this.pump(); }, BUY_SPACING_MS);
  }

  /** Test/diagnostic view of what 「重买」 would buy. */
  rebuyList(): readonly ItemId[] { return this.rebuy; }
}
