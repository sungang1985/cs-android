import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ItemId, Team } from '@/sim/state';
import { buyPlan } from '@/rules/buyPlan';
import { BuyMenu, buyCtxFromLocal, itemStatus, itemPrice, planPurchases, presetItems, presetSummary, ownedForPlan, readLoadout, BUY_SPACING_MS, type BuyCtx } from '@/ui/buyMenu';
import { setup, localWith, $, click } from './helpers';

const ctx = (over: Partial<BuyCtx> = {}): BuyCtx => ({ money: 800, team: 'T', primary: null, pistol: 'glock', he: 0, flash: 0, armor: 0, helmet: false, hasKit: false, free: false, ...over });

describe('buy menu affordability (pure)', () => {
  it('money decides affordability; the default pistol is owned', () => {
    const c = ctx();
    expect(itemStatus('ak47', c)).toMatchObject({ affordable: false, buyable: false, locked: false });
    expect(itemStatus('deagle', c)).toMatchObject({ affordable: true, buyable: true, price: 700 });
    expect(itemStatus('glock', c)).toMatchObject({ owned: true, buyable: false });
    expect(itemStatus('mp5', ctx({ money: 1500 })).buyable).toBe(true);
    expect(itemStatus('mp5', ctx({ money: 1499 })).buyable).toBe(false);
  });

  it('team locks: rifles, default pistols and the kit', () => {
    const t = ctx({ team: 'T', money: 16000 }), ct = ctx({ team: 'CT', pistol: 'usp', money: 16000 });
    expect(itemStatus('m4a4', t).locked).toBe(true); expect(itemStatus('ak47', t).locked).toBe(false);
    expect(itemStatus('ak47', ct).locked).toBe(true); expect(itemStatus('m4a4', ct).locked).toBe(false);
    expect(itemStatus('usp', t).locked).toBe(true); expect(itemStatus('glock', ct).locked).toBe(true);
    expect(itemStatus('defuse_kit', t).locked).toBe(true); expect(itemStatus('defuse_kit', ct)).toMatchObject({ locked: false, buyable: true, price: 400 });
    expect(itemStatus('awp', t).locked || itemStatus('awp', ct).locked).toBe(false);
    expect(itemStatus('defuse_kit', ctx({ team: 'CT', hasKit: true, money: 16000 })).owned).toBe(true);
  });

  it('max grenades: HE 1, flash 2', () => {
    expect(itemStatus('he', ctx({ he: 0 })).buyable).toBe(true);
    expect(itemStatus('he', ctx({ he: 1 }))).toMatchObject({ max: true, buyable: false });
    expect(itemStatus('flash', ctx({ flash: 1 })).buyable).toBe(true);
    expect(itemStatus('flash', ctx({ flash: 2 }))).toMatchObject({ max: true, buyable: false });
  });

  it('owned ✓ for primary / pistol / armor; helmet upgrade costs $350', () => {
    expect(itemStatus('ak47', ctx({ primary: 'ak47', money: 5000 })).owned).toBe(true);
    expect(itemStatus('deagle', ctx({ pistol: 'deagle' })).owned).toBe(true);
    expect(itemStatus('kevlar', ctx({ armor: 100 })).owned).toBe(true);
    expect(itemStatus('kevlar', ctx({ armor: 40 })).owned).toBe(false);           // partial armor: rebuy refills
    expect(itemPrice('kevlar_helmet', ctx({ armor: 0 }))).toBe(1000);
    expect(itemPrice('kevlar_helmet', ctx({ armor: 100 }))).toBe(350);
    expect(itemPrice('kevlar_helmet', ctx({ armor: 30 }))).toBe(350);
    expect(itemStatus('kevlar_helmet', ctx({ armor: 100, money: 350 }))).toMatchObject({ affordable: true, buyable: true, price: 350 });
    expect(itemStatus('kevlar_helmet', ctx({ armor: 100, helmet: true })).owned).toBe(true);
  });

  it('economy-free modes (TDM / training: buyWindowRemaining −1) price everything at 0', () => {
    const c = buyCtxFromLocal(localWith({ money: 0, buyWindowRemaining: -1 }), 'CT');
    expect(c.free).toBe(true);
    expect(itemStatus('awp', c)).toMatchObject({ price: 0, buyable: true });
  });

  it('reads owned items from the snapshot', () => {
    const c = buyCtxFromLocal(localWith({ primary: 5, pistol: 3, he: 1, flash: 2, armor: 100, helmet: 1, hasKit: 1, money: 4321 }), 'CT');
    expect(c).toMatchObject({ primary: 'ak47', pistol: 'deagle', he: 1, flash: 2, armor: 100, helmet: true, hasKit: true, money: 4321, team: 'CT' });
  });

  it('a preset buys in order, skips owned items and stops at the first unaffordable one', () => {
    const p = planPurchases(['ak47', 'kevlar_helmet', 'he', 'flash'], ctx({ money: 3000 }));
    expect(p.items).toEqual(['ak47']); expect(p.blockedBy).toBe('kevlar_helmet'); expect(p.total).toBe(2700);
    const q = planPurchases(['ak47', 'kevlar_helmet', 'he', 'flash'], ctx({ money: 2000, primary: 'ak47', armor: 100 }));
    expect(q.items).toEqual(['kevlar_helmet', 'he', 'flash']); expect(q.total).toBe(350 + 300 + 200); expect(q.blockedBy).toBeNull();
  });

  it('preset prices match §5.1', () => {
    expect(presetSummary('full', ctx({ team: 'T' }))).toMatchObject({ price: 4200, optional: 0, affordable: false });
    expect(presetSummary('full', ctx({ team: 'CT', pistol: 'usp' }))).toMatchObject({ price: 4600, optional: 400 });
    expect(presetSummary('full', ctx({ team: 'CT', pistol: 'usp', money: 4600 })).affordable).toBe(true);   // kit is optional
    expect(presetSummary('force', ctx()).price).toBe(1350);
    expect(presetSummary('awp', ctx()).price).toBe(5750);
    expect(presetItems('full', ctx({ team: 'T' }))).toEqual(['ak47', 'kevlar_helmet', 'he', 'flash']);
    expect(presetItems('full', ctx({ team: 'CT' }))).toEqual(['m4a4', 'kevlar_helmet', 'he', 'flash', 'defuse_kit']);
    expect(presetItems('force', ctx())).toEqual(['kevlar', 'deagle']);
    expect(presetItems('awp', ctx())).toEqual(['awp', 'kevlar_helmet']);
    expect(presetSummary('rebuy', ctx(), []).empty).toBe(true);
  });

  it('「自动」 is exactly rules/buyPlan(money, team, owned, { sniper: false }, 0, false, false)', () => {
    const cases: Array<Partial<BuyCtx>> = [{ money: 800 }, { money: 1400 }, { money: 2600 }, { money: 4200 }, { money: 16000 }, { money: 16000, team: 'CT', pistol: 'usp' }, { money: 3000, primary: 'mp5', armor: 100 }, { money: 6000, armor: 50, he: 1, flash: 2 }];
    for (const over of cases) {
      const c = ctx(over);
      expect(presetItems('auto', c)).toEqual(buyPlan(c.money, c.team, ownedForPlan(c), { sniper: false }, 0, false, false));
    }
  });
});

describe('BuyMenu DOM', () => {
  afterEach(() => { vi.useRealTimers(); });

  function open(team: Team = 'T', over = {}) {
    const env = setup();
    const menu = new BuyMenu(env.root, env.bus);
    const bought: ItemId[] = [];
    menu.onBuy((i) => bought.push(i));
    menu.open(localWith(over), team);
    return { ...env, menu, bought };
  }

  it('renders the 5 presets and 4 columns with owned ✓, team locks and 钱不够 states', () => {
    const { root, menu } = open('T');
    expect(menu.isOpen).toBe(true);
    for (const id of ['full', 'force', 'awp', 'auto', 'rebuy']) expect($(root, `buy-preset-${id}`)).not.toBeNull();
    for (const id of ['glock', 'usp', 'deagle', 'mp5', 'ak47', 'm4a4', 'awp', 'kevlar', 'kevlar_helmet', 'defuse_kit', 'he', 'flash']) expect($(root, `buy-${id}`)).not.toBeNull();
    expect($(root, 'buy-glock')!.classList.contains('is-owned')).toBe(true);
    expect($(root, 'buy-glock')!.textContent).toContain('✓');
    expect($(root, 'buy-usp')!.classList.contains('is-locked')).toBe(true);
    expect($(root, 'buy-m4a4')!.classList.contains('is-locked')).toBe(true);
    expect($(root, 'buy-ak47')!.classList.contains('is-poor')).toBe(true);
    expect($(root, 'buy-deagle')!.classList.contains('is-poor')).toBe(false);
    expect($(root, 'buy-preset-full')!.textContent).toContain('钱不够');
    expect($(root, 'buy-preset-auto')!.textContent).toContain('可负担');
    expect($(root, 'buy-money')!.textContent).toBe('$ 800');
    expect($(root, 'buy-preset-full')!.textContent).toContain('$4,200');
  });

  it('one tap buys and closes; 连续购买 keeps it open; locked tiles do nothing', () => {
    const { root, menu, bought } = open('T');
    click(root, 'buy-usp');
    expect(bought).toEqual([]);
    click(root, 'buy-deagle');
    expect(bought).toEqual(['deagle']); expect(menu.isOpen).toBe(false);
    menu.open(localWith(), 'T');
    click(root, 'buy-continuous');
    click(root, 'buy-kevlar');
    expect(bought).toEqual(['deagle', 'kevlar']); expect(menu.isOpen).toBe(true);
    expect(readLoadout().continuous).toBe(true);
  });

  it('an unaffordable tap is still sent (the sim denies it → toast) and the menu stays open', () => {
    const { root, menu, bought } = open('T');
    click(root, 'buy-ak47');
    expect(bought).toEqual(['ak47']); expect(menu.isOpen).toBe(true);
  });

  it('a preset sends its items one per tick in order', () => {
    vi.useFakeTimers();
    const { root, bought, menu } = open('T', { money: 16000 });
    click(root, 'buy-preset-full');
    expect(bought).toEqual(['ak47']);
    vi.advanceTimersByTime(BUY_SPACING_MS * 3 + 1);
    expect(bought).toEqual(['ak47', 'kevlar_helmet', 'he', 'flash']);
    expect(menu.isOpen).toBe(false);
  });

  it('auto-closes when the buy window ends (canBuy 1 → 0), not when opened outside it', () => {
    const { menu } = open('CT');
    menu.update(localWith({ canBuy: 1, buyWindowRemaining: 3 }));
    expect(menu.isOpen).toBe(true);
    menu.update(localWith({ canBuy: 0, buyWindowRemaining: 0 }));
    expect(menu.isOpen).toBe(false);
    menu.open(localWith({ canBuy: 0, buyWindowRemaining: 0 }), 'CT');
    menu.update(localWith({ canBuy: 0, buyWindowRemaining: 0 }));
    expect(menu.isOpen).toBe(true);
  });

  it('update(local) refreshes money and affordability in place', () => {
    const { root, menu } = open('T');
    menu.update(localWith({ money: 3000 }));
    expect($(root, 'buy-money')!.textContent).toBe('$ 3,000');
    expect($(root, 'buy-ak47')!.classList.contains('is-poor')).toBe(false);
  });

  it('「重买」 = last buy window\'s purchases (persisted in cs.v1.loadout)', () => {
    vi.useFakeTimers();
    const { root, menu, bought } = open('T', { money: 16000, buyWindowRemaining: 14 });
    click(root, 'buy-continuous');
    click(root, 'buy-ak47'); click(root, 'buy-he');
    vi.advanceTimersByTime(500);
    expect(readLoadout().items).toEqual(['ak47', 'he']);
    menu.update(localWith({ money: 16000, buyWindowRemaining: 1 }));
    menu.update(localWith({ money: 16000, buyWindowRemaining: 15 }));   // next round's window
    expect(menu.rebuyList()).toEqual(['ak47', 'he']);
    bought.length = 0;
    click(root, 'buy-preset-rebuy');
    vi.advanceTimersByTime(500);
    expect(bought).toEqual(['ak47', 'he']);
  });
});
