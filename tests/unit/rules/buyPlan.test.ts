/** §5.2 buy planner rows and §5.1 presets ("stop at the first unaffordable item"). */
import { describe, it, expect } from 'vitest';
import { buyPlan, planPurchase, presetItems, planCost, type Owned } from '@/rules/buyPlan';
import { defaultInventory } from '@/sim/entities';
import type { Team } from '@/sim/state';

function owned(team: Team, over: Partial<Owned> = {}): Owned {
  return { ...defaultInventory(team), armor: 0, helmet: false, hasKit: false, ...over };
}
const plan = (money: number, team: Team, o: Partial<Owned> = {}, sniper = false, streak = 0, teamAwp = false, last = false) =>
  buyPlan(money, team, owned(team, o), { sniper }, streak, teamAwp, last);

describe('rules/buyPlan — §5.2 table rows', () => {
  it('row 1: sniper preference, no team AWP, ≥ 5,750 → AWP + Kevlar+Helmet (+ HE at +300, + flash at +200)', () => {
    expect(plan(5750, 'T', {}, true)).toEqual(['awp', 'kevlar_helmet']);
    expect(plan(6050, 'T', {}, true)).toEqual(['awp', 'kevlar_helmet', 'he']);
    expect(plan(6250, 'CT', {}, true)).toEqual(['awp', 'kevlar_helmet', 'he', 'flash']);
    expect(plan(5749, 'T', {}, true)).toEqual(['ak47', 'kevlar_helmet', 'he', 'flash']);
    expect(plan(6250, 'T', {}, true, 0, true)).toEqual(['ak47', 'kevlar_helmet', 'he', 'flash']); // team already has one
  });

  it('row 2: ≥ rifle + 1,000 → team rifle + Kevlar+Helmet (+ HE, + flash, + kit for CT)', () => {
    expect(plan(3700, 'T')).toEqual(['ak47', 'kevlar_helmet']);
    expect(plan(4000, 'T')).toEqual(['ak47', 'kevlar_helmet', 'he']);
    expect(plan(4200, 'T')).toEqual(['ak47', 'kevlar_helmet', 'he', 'flash']);
    expect(plan(9000, 'T')).toEqual(['ak47', 'kevlar_helmet', 'he', 'flash']); // never a kit for T
    expect(plan(4100, 'CT')).toEqual(['m4a4', 'kevlar_helmet']);
    expect(plan(4600, 'CT')).toEqual(['m4a4', 'kevlar_helmet', 'he', 'flash']);
    expect(plan(5000, 'CT')).toEqual(['m4a4', 'kevlar_helmet', 'he', 'flash', 'defuse_kit']);
    expect(plan(4300, 'CT')).toEqual(['m4a4', 'kevlar_helmet', 'flash']); // +200 left after a missed HE still buys a flash
  });

  it('row 3: ≥ 2,500 → MP5 + Kevlar+Helmet', () => {
    expect(plan(2500, 'T')).toEqual(['mp5', 'kevlar_helmet']);
    expect(plan(3699, 'T')).toEqual(['mp5', 'kevlar_helmet']);
    expect(plan(4099, 'CT')).toEqual(['mp5', 'kevlar_helmet']);
  });

  it('row 4: ≥ 1,350 → Deagle + Kevlar', () => {
    expect(plan(1350, 'T')).toEqual(['deagle', 'kevlar']);
    expect(plan(2499, 'CT')).toEqual(['deagle', 'kevlar']);
  });

  it('row 5: ≥ 650 and (loss streak ≥ 2 or last round of the half) → Kevlar; else eco', () => {
    expect(plan(650, 'T', {}, false, 2)).toEqual(['kevlar']);
    expect(plan(1349, 'CT', {}, false, 0, false, true)).toEqual(['kevlar']);
    expect(plan(1349, 'T', {}, false, 1)).toEqual([]);
    expect(plan(649, 'T', {}, false, 4, false, true)).toEqual([]);
  });

  it('row 6: eco → []', () => {
    expect(plan(800, 'T')).toEqual([]);
    expect(plan(0, 'CT', {}, true, 5, false, true)).toEqual([]);
  });

  it('owned items are skipped; the helmet is the $350 upgrade over an owned vest; a better primary is kept', () => {
    expect(plan(3050, 'T', { armor: 100 })).toEqual(['ak47', 'kevlar_helmet']); // 2,700 + 350
    expect(plan(1000, 'T', { primary: { id: 'ak47', mag: 30, reserve: 90 } })).toEqual(['kevlar_helmet']);
    expect(plan(500, 'T', { primary: { id: 'ak47', mag: 30, reserve: 90 }, armor: 100, helmet: true })).toEqual(['he', 'flash']);
    expect(plan(4200, 'T', { primary: { id: 'awp', mag: 5, reserve: 30 } })).toEqual(['kevlar_helmet', 'he', 'flash']); // AWP kept
    expect(plan(4200, 'T', { primary: { id: 'mp5', mag: 30, reserve: 120 } })).toEqual(['ak47', 'kevlar_helmet', 'he', 'flash']);
    expect(plan(1000, 'CT', { he: 1, flash: 2, armor: 100, helmet: true, hasKit: true, primary: { id: 'm4a4', mag: 30, reserve: 90 } })).toEqual([]);
    expect(plan(1400, 'T', { pistol: { id: 'deagle', mag: 7, reserve: 35 } })).toEqual(['kevlar']);
  });
});

describe('rules/buyPlan — presets', () => {
  it('preset contents (§5.1) and prices: Full $4,200 / $4,600 (+400 kit), Force $1,350, AWP $5,750', () => {
    expect(presetItems('full', 'T')).toEqual(['ak47', 'kevlar_helmet', 'he', 'flash']);
    expect(presetItems('full', 'CT')).toEqual(['m4a4', 'kevlar_helmet', 'he', 'flash', 'defuse_kit']);
    expect(planCost(presetItems('full', 'T'), 'T', owned('T'))).toBe(4200);
    expect(planCost(presetItems('full', 'CT'), 'CT', owned('CT'))).toBe(5000);
    expect(planCost(presetItems('force', 'T'), 'T', owned('T'))).toBe(1350);
    expect(planCost(presetItems('awp', 'CT'), 'CT', owned('CT'))).toBe(5750);
  });

  it('presets buy in order and stop at the first unaffordable item', () => {
    expect(planPurchase(presetItems('full', 'T'), 3000, 'T', owned('T'))).toEqual(['ak47']); // HE would fit, but the helmet does not
    expect(planPurchase(presetItems('full', 'CT'), 4600, 'CT', owned('CT'))).toEqual(['m4a4', 'kevlar_helmet', 'he', 'flash']); // kit only if affordable
    expect(planPurchase(presetItems('force', 'T'), 1000, 'T', owned('T'))).toEqual(['kevlar']);
    expect(planPurchase(presetItems('awp', 'T'), 4000, 'T', owned('T'))).toEqual([]);
    expect(planPurchase(['kevlar', 'kevlar_helmet'], 1000, 'T', owned('T'))).toEqual(['kevlar', 'kevlar_helmet']); // 650 + 350 upgrade
  });

  it('presets skip owned items (Rebuy = planPurchase(lastBuy))', () => {
    const o = owned('T', { primary: { id: 'ak47', mag: 30, reserve: 90 }, armor: 100, helmet: true });
    expect(planPurchase(presetItems('full', 'T'), 500, 'T', o)).toEqual(['he', 'flash']);
    expect(planPurchase(['ak47', 'he', 'he', 'flash', 'flash'], 1000, 'T', owned('T', { primary: { id: 'ak47', mag: 1, reserve: 0 } }))).toEqual(['he', 'flash', 'flash']);
    expect(planPurchase(['m4a4', 'kevlar'], 5000, 'T', owned('T'))).toEqual(['kevlar']); // team-locked skipped
  });
});
