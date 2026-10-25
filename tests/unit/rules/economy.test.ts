/** §5 economy: ladder, half-step rule, planted-loss, time-win survivors, cap, kill rewards, buy validation. */
import { describe, it, expect } from 'vitest';
import { ECON, lossBonus, addMoney, awardRoundEnd, onKill, killReward, canBuy, canBuyNow, buy, inBuyWindow } from '@/rules/economy';
import { WEAPONS } from '@/weapons/defs';
import { harness, step, stepTo, teleport, kill, ofType, recordingSink, type Harness } from './helpers';

/** LIVE tick 400 (inside the buy window), everyone in their spawn. */
function live(over = {}): Harness { const h = harness(over); stepTo(h, 400); return h; }

describe('rules/economy — round-end money', () => {
  it('loss ladder 1,400 / 1,900 / 2,400 / 2,900 / 3,400 (5+)', () => {
    expect([1, 2, 3, 4, 5, 6, 9].map(lossBonus)).toEqual([1400, 1900, 2400, 2900, 3400, 3400, 3400]);
    const h = live();
    const s = h.sim.state; const { sink } = recordingSink();
    const t = h.p(2); // dead T: no time-win exception
    t.alive = false;
    const got: number[] = [];
    for (let i = 0; i < 6; i++) { t.money = 0; awardRoundEnd(s, 'CT', 'time', sink); got.push(t.money); }
    expect(got).toEqual([1400, 1900, 2400, 2900, 3400, 3400]);
    expect(s.round.lossStreakT).toBe(6);
  });

  it('half-step rule: a win sets streak = max(0, streak − 1)', () => {
    const h = live(); const s = h.sim.state; const { sink } = recordingSink();
    s.round.lossStreakT = 3; s.round.lossStreakCT = 0;
    awardRoundEnd(s, 'T', 'elimination', sink);
    expect([s.round.lossStreakT, s.round.lossStreakCT]).toEqual([2, 1]);
    awardRoundEnd(s, 'T', 'elimination', sink);
    awardRoundEnd(s, 'T', 'elimination', sink);
    awardRoundEnd(s, 'T', 'elimination', sink);
    expect(s.round.lossStreakT).toBe(0);
    for (const p of s.players) if (p.team === 'CT') p.money = 0;
    awardRoundEnd(s, 'T', 'elimination', sink); // CT streak 5 → 3,400
    expect(h.p(3).money).toBe(3400);
  });

  it('win rewards: $3,250 elimination/time, $3,500 bomb/defuse', () => {
    const h = live(); const s = h.sim.state; const { sink } = recordingSink();
    const t = h.p(1), ct = h.p(3);
    t.money = 0; ct.money = 0;
    awardRoundEnd(s, 'T', 'elimination', sink); expect(t.money).toBe(3250);
    t.money = 0; awardRoundEnd(s, 'T', 'bomb', sink); expect(t.money).toBe(3500);
    ct.money = 0; awardRoundEnd(s, 'CT', 'time', sink); expect(ct.money).toBe(3250);
    ct.money = 0; awardRoundEnd(s, 'CT', 'defuse', sink); expect(ct.money).toBe(3500);
  });

  it('T loss after a plant: loss bonus + a separate +$800 `plantedLoss` delta for every T', () => {
    const h = live(); const s = h.sim.state; const { sink } = recordingSink();
    s.bomb.state = 'defused';
    for (const p of s.players) p.money = 0;
    h.p(1).alive = false;
    const deltas = awardRoundEnd(s, 'CT', 'defuse', sink);
    expect(deltas.filter((d) => d.player === 1)).toEqual([{ player: 1, delta: 1400, reason: 'loss' }, { player: 1, delta: 800, reason: 'plantedLoss' }]);
    expect(deltas.filter((d) => d.player === 2)).toEqual([{ player: 2, delta: 1400, reason: 'loss' }, { player: 2, delta: 800, reason: 'plantedLoss' }]);
    expect(deltas.filter((d) => d.player === 3)).toEqual([{ player: 3, delta: 3500, reason: 'win' }]);
    expect(h.p(1).money).toBe(2200);
  });

  it('Ts alive when the timer expires get $0 loss bonus; dead Ts get the ladder', () => {
    const h = harness();
    stepTo(h, 400);
    kill(h, 2); // dead T (suicide-like: no kill credit)
    for (const p of h.sim.state.players) p.money = 0;
    stepTo(h, 4801);
    expect(h.sim.state.round.reason).toBe('time');
    expect(h.p(1).money).toBe(0);
    expect(h.p(2).money).toBe(1400);
    expect(h.p(3).money).toBe(3250);
    const ends = ofType(h, 'roundEnd');
    expect(ends[0].deltas.find((d) => d.player === 1)).toBeUndefined();
    expect(ends[0].deltas.find((d) => d.player === 3)).toEqual({ player: 3, delta: 3250, reason: 'win' });
  });

  it('money is capped at $16,000 (applied delta reported); draws and sudden death change nothing', () => {
    const h = live(); const s = h.sim.state; const { sink, events } = recordingSink();
    const t = h.p(1); t.money = 15000;
    const deltas = awardRoundEnd(s, 'T', 'elimination', sink);
    expect(t.money).toBe(ECON.max);
    expect(deltas.find((d) => d.player === 1)).toEqual({ player: 1, delta: 1000, reason: 'win' });
    expect(addMoney(s, t, 500, 'kill', sink)).toBe(0);
    expect(events.filter((e) => e.type === 'money' && (e.data as { player: number }).player === 1)).toHaveLength(1);
    expect(awardRoundEnd(s, null, 'draw', sink)).toEqual([]);
    s.round.suddenDeath = true;
    expect(awardRoundEnd(s, 'CT', 'elimination', sink)).toEqual([]);
  });

  it('round-end money is applied on entering ROUND_END and listed in the roundEnd event', () => {
    const h = harness();
    stepTo(h, 4801);
    const end = ofType(h, 'roundEnd')[0];
    const moneyEvents = ofType(h, 'money');
    expect(end.deltas.length).toBe(moneyEvents.length);
    expect(moneyEvents.every((m) => m.tick === 4800)).toBe(true);
  });
});

describe('rules/economy — kill rewards', () => {
  it('by weapon: knife 1,500 · pistols 300 · MP5 600 · AK/M4 300 · AWP 100 · HE 300 · bomb/fall 0', () => {
    expect((['knife', 'glock', 'usp', 'deagle', 'mp5', 'ak47', 'm4a4', 'awp', 'he'] as const).map((w) => killReward(WEAPONS[w]))).toEqual([1500, 300, 300, 300, 600, 300, 300, 100, 300]);
    expect(killReward(null)).toBe(0);
    const h = live(); const s = h.sim.state; const { sink } = recordingSink();
    const k = h.p(1); k.money = 0;
    onKill(s, k, 'knife', sink); onKill(s, k, 'mp5', sink); onKill(s, k, 'awp', sink); onKill(s, k, 'bomb', sink); onKill(s, k, 'fall', sink);
    expect(k.money).toBe(2200);
  });

  it('the death pipeline credits the killer with a `kill` money event', () => {
    const h = live();
    const k = h.p(1); const before = k.money;
    kill(h, 3, 1, 'he');
    expect(k.money).toBe(before + 300);
    expect(ofType(h, 'money')).toContainEqual(expect.objectContaining({ player: 1, delta: 300, reason: 'kill' }));
    kill(h, 4, 0, 'bomb');
    expect(k.money).toBe(before + 300);
  });

  it('no kill rewards outside the economy mode', () => {
    const h = harness({ mode: 'tdm' });
    stepTo(h, 200);
    const k = h.p(1); const before = k.money;
    onKill(h.sim.state, k, 'knife', h.sim.events);
    expect(k.money).toBe(before);
  });
});

describe('rules/economy — buying', () => {
  it('rejects outside the window, outside the own spawn zone, without money, team-locked and over max carry', () => {
    const h = harness();
    step(h);
    const me = h.human(); const s = h.sim.state; const map = h.deps.map;
    me.money = 800;
    expect(inBuyWindow(s)).toBe(true);
    expect(canBuy(me, 'ak47', s, map)).toEqual({ ok: false, error: 'money' });
    expect(canBuy(me, 'm4a4', s, map)).toEqual({ ok: false, error: 'team' });
    expect(canBuy(me, 'defuse_kit', s, map)).toEqual({ ok: false, error: 'team' });
    expect(canBuy(me, 'glock', s, map)).toEqual({ ok: false, error: 'owned' });
    me.inv.he = 1; me.inv.flash = 2;
    expect(canBuy(me, 'he', s, map)).toEqual({ ok: false, error: 'max' });
    expect(canBuy(me, 'flash', s, map)).toEqual({ ok: false, error: 'max' });
    me.inv.flash = 1;
    expect(canBuy(me, 'flash', s, map)).toEqual({ ok: true, price: 200 });
    teleport(me, 9, 0, 9); // CT spawn
    expect(canBuy(me, 'flash', s, map)).toEqual({ ok: false, error: 'zone' });
    expect(canBuyNow(me, s, map)).toBe(false);
    teleport(me, 3, 0, 3);
    expect(canBuyNow(me, s, map)).toBe(true);
    stepTo(h, 900);
    expect(canBuy(me, 'flash', s, map)).toEqual({ ok: false, error: 'window' });
    expect(canBuyNow(me, s, map)).toBe(false);
    me.alive = false;
    expect(canBuy(me, 'flash', s, map)).toEqual({ ok: false, error: 'window' });
  });

  it('armor: Kevlar $650 (refill when < 100), Kevlar+Helmet $1,000, helmet upgrade $350 when a vest is owned', () => {
    const h = harness();
    step(h);
    const me = h.human(); const s = h.sim.state; const map = h.deps.map;
    me.money = 16000;
    expect(canBuy(me, 'kevlar_helmet', s, map)).toEqual({ ok: true, price: 1000 });
    expect(canBuy(me, 'kevlar', s, map)).toEqual({ ok: true, price: 650 });
    me.armor = 100;
    expect(canBuy(me, 'kevlar', s, map)).toEqual({ ok: false, error: 'owned' });
    expect(canBuy(me, 'kevlar_helmet', s, map)).toEqual({ ok: true, price: 350 });
    me.armor = 40;
    expect(canBuy(me, 'kevlar', s, map)).toEqual({ ok: true, price: 650 });
    expect(canBuy(me, 'kevlar_helmet', s, map)).toEqual({ ok: true, price: 350 });
    expect(buy(me, 'kevlar_helmet', s, map, h.sim.events)).toBe(true);
    expect([me.armor, me.helmet, me.money]).toEqual([40, true, 16000 - 350]);
    expect(canBuy(me, 'kevlar_helmet', s, map)).toEqual({ ok: true, price: 650 });
    buy(me, 'kevlar', s, map, h.sim.events);
    expect([me.armor, me.helmet]).toEqual([100, true]);
    expect(canBuy(me, 'kevlar_helmet', s, map)).toEqual({ ok: false, error: 'owned' });
  });

  it('buy() pays, equips with the 1.0 s deploy, records lastBuy, emits money + buy; a replaced primary is dropped', () => {
    const h = harness();
    step(h);
    const me = h.human(); const s = h.sim.state; const map = h.deps.map;
    me.money = 10000;
    h.events.length = 0;
    expect(buy(me, 'mp5', s, map, h.sim.events)).toBe(true);
    expect([me.inv.primary?.id, me.inv.active, me.inv.pendingSlot, me.inv.switchEndsTick]).toEqual(['mp5', 1, 0, s.tick + 60]);
    expect(me.money).toBe(8500);
    expect(ofType(h, 'money')).toEqual([expect.objectContaining({ player: 1, delta: -1500, reason: 'buy' })]);
    expect(ofType(h, 'buy')).toEqual([expect.objectContaining({ player: 1, item: 'mp5', ok: true })]);
    buy(me, 'ak47', s, map, h.sim.events);
    expect(me.inv.primary?.id).toBe('ak47');
    expect(s.items.filter((i) => i.kind === 'weapon').map((i) => i.weapon?.id)).toEqual(['mp5']);
    buy(me, 'deagle', s, map, h.sim.events);
    expect([me.inv.pistol.id, me.inv.active]).toEqual(['deagle', 2]);
    buy(me, 'he', s, map, h.sim.events);
    expect([me.inv.he, me.inv.active]).toEqual([1, 2]);
    expect(me.lastBuy).toEqual(['ak47', 'deagle', 'he']);
    expect(buy(me, 'he', s, map, h.sim.events)).toBe(false);
    expect(ofType(h, 'buy').at(-1)).toEqual(expect.objectContaining({ ok: false, error: 'max' }));
  });

  it('TDM and training: buy anywhere, any time, free; canBuyNow = alive', () => {
    for (const mode of ['tdm', 'training'] as const) {
      const h = harness({ mode });
      stepTo(h, 400);
      const me = h.human(); const s = h.sim.state; const map = h.deps.map;
      teleport(me, 9, 0, 9);
      const money = me.money;
      expect(canBuyNow(me, s, map)).toBe(true);
      expect(canBuy(me, 'awp', s, map)).toEqual({ ok: true, price: 0 });
      expect(buy(me, 'awp', s, map, h.sim.events)).toBe(true);
      expect(me.money).toBe(money);
      expect(s.items).toHaveLength(0);
    }
  });
});
