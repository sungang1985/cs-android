/** §12.1 rules/round: phases, timers, wins, half swap, sudden death, match end, MVP. */
import { describe, it, expect } from 'vitest';
import { canBuy } from '@/rules/economy';
import { ROUND, NEVER, computeMvp, swapSides, isLastRoundOfHalf } from '@/rules/round';
import { harness, step, stepTo, stepUntilPhase, kill, giveBomb, teleport, ofType, recordingSink, BOX_SITE_A, Btn } from './helpers';

describe('rules/round — defusal timers', () => {
  it('WARMUP → FREEZE at tick 0; FREEZE lasts exactly 300 ticks, LIVE starts at tick 300 and lasts 75 s', () => {
    const h = harness();
    step(h);
    expect(h.sim.state.round.phase).toBe('FREEZE');
    expect(h.sim.state.round.roundNumber).toBe(1);
    expect(h.sim.state.round.phaseEndsTick).toBe(300);
    let frozen = 1;
    while (h.sim.state.round.phase === 'FREEZE') { step(h); if (h.sim.state.round.phase === 'FREEZE') frozen++; }
    expect(frozen).toBe(300);
    expect(h.sim.state.tick).toBe(301); // the step that processed tick 300 switched to LIVE
    expect(h.sim.state.round.phase).toBe('LIVE');
    expect(h.sim.state.round.phaseEndsTick).toBe(300 + 75 * 60);
    const phases = ofType(h, 'roundPhase');
    expect(phases.map((e) => [e.phase, e.tick, e.endsTick])).toEqual([['FREEZE', 0, 300], ['LIVE', 300, 4800]]);
  });

  it('buy window ends at tick 900 (FREEZE 5 s + 10 s of LIVE)', () => {
    const h = harness();
    step(h);
    expect(h.sim.state.round.buyWindowEndsTick).toBe(900);
    stepTo(h, 899);
    const me = h.human(); me.money = 5000;
    expect(canBuy(me, 'deagle', h.sim.state, h.deps.map)).toEqual({ ok: true, price: 700 });
    step(h, 1, { buy: 'deagle' });
    expect(me.inv.pistol.id).toBe('deagle');
    expect(h.sim.state.tick).toBe(900);
    expect(canBuy(me, 'mp5', h.sim.state, h.deps.map)).toEqual({ ok: false, error: 'window' });
    step(h, 1, { buy: 'mp5' });
    expect(me.inv.primary).toBeNull();
    expect(ofType(h, 'buy').map((b) => [b.item, b.ok, b.error])).toEqual([['deagle', true, undefined], ['mp5', false, 'window']]);
  });

  it('timer expiry without a plant → CT `time` win, ROUND_END 4 s, then round 2 FREEZE', () => {
    const h = harness();
    stepTo(h, 4800);
    expect(h.sim.state.round.phase).toBe('LIVE');
    step(h);
    const r = h.sim.state.round;
    expect(r.phase).toBe('ROUND_END');
    expect([r.winner, r.reason, r.scoreCT, r.scoreT]).toEqual(['CT', 'time', 1, 0]);
    const ends = ofType(h, 'roundEnd');
    expect(ends).toHaveLength(1);
    expect(ends[0].winner).toBe('CT'); expect(ends[0].reason).toBe('time'); expect(ends[0].tick).toBe(4800);
    expect(r.phaseEndsTick).toBe(4800 + ROUND.roundEndTicks);
    stepTo(h, 5040);
    expect(h.sim.state.round.phase).toBe('ROUND_END');
    step(h);
    expect(h.sim.state.round.phase).toBe('FREEZE');
    expect(h.sim.state.round.roundNumber).toBe(2);
  });

  it('all CT dead → T `elimination` at the next tickRound; all T dead (no plant) → CT `elimination`', () => {
    const h = harness();
    stepTo(h, 400);
    kill(h, 3, 1); kill(h, 4, 2); // deaths between ticks 399 and 400
    step(h);
    expect(h.sim.state.round.phase).toBe('ROUND_END');
    expect([h.sim.state.round.winner, h.sim.state.round.reason]).toEqual(['T', 'elimination']);
    expect(ofType(h, 'roundEnd')[0].tick).toBe(400);

    const g = harness();
    stepTo(g, 400);
    kill(g, 1, 3); kill(g, 2, 4);
    step(g);
    expect([g.sim.state.round.winner, g.sim.state.round.reason]).toEqual(['CT', 'elimination']);
  });

  it('plant at 70 s of LIVE → PLANTED → explosion at 105 s = T `bomb`', () => {
    const h = harness();
    stepTo(h, 300 + 67 * 60);
    giveBomb(h, 1); teleport(h.human(), BOX_SITE_A.x, BOX_SITE_A.y, BOX_SITE_A.z);
    stepTo(h, 300 + 70 * 60 + 1, { buttons: Btn.USE });
    const planted = ofType(h, 'bombPlanted');
    expect(planted).toHaveLength(1);
    expect(planted[0].tick).toBe(300 + 70 * 60);
    expect(h.sim.state.bomb.explodeTick).toBe(300 + 105 * 60);
    step(h);
    expect(h.sim.state.round.phase).toBe('PLANTED');
    expect(h.sim.state.round.phaseEndsTick).toBe(300 + 105 * 60);
    stepTo(h, 300 + 105 * 60 + 1);
    expect(ofType(h, 'bombExploded')[0].tick).toBe(300 + 105 * 60);
    expect(h.sim.state.round.phase).toBe('PLANTED'); // the round ends on the next tick
    step(h);
    expect(h.sim.state.round.phase).toBe('ROUND_END');
    expect([h.sim.state.round.winner, h.sim.state.round.reason, h.sim.state.round.scoreT]).toEqual(['T', 'bomb', 1]);
  });

  it('the LIVE timer does not end a round once the bomb is planted; last T dead after the plant → round continues', () => {
    const h = harness();
    stepTo(h, 4500);
    giveBomb(h, 1); teleport(h.human(), BOX_SITE_A.x, 0, BOX_SITE_A.z);
    stepTo(h, 4681, { buttons: Btn.USE });
    expect(h.sim.state.bomb.state).toBe('planted');
    kill(h, 1, 3); kill(h, 2, 4);
    stepTo(h, 4900);
    expect(h.sim.state.round.phase).toBe('PLANTED');
    expect(h.sim.state.players.filter((p) => p.team === 'T' && p.alive)).toHaveLength(0);
    stepUntilPhase(h, 'ROUND_END');
    expect([h.sim.state.round.winner, h.sim.state.round.reason]).toEqual(['T', 'bomb']);
  });

  it('all CT dead after the plant → T `elimination` immediately', () => {
    const h = harness();
    stepTo(h, 400);
    giveBomb(h, 1); teleport(h.human(), BOX_SITE_A.x, 0, BOX_SITE_A.z);
    stepTo(h, 581, { buttons: Btn.USE });
    expect(h.sim.state.bomb.state).toBe('planted');
    kill(h, 3, 1); kill(h, 4, 1);
    step(h);
    expect([h.sim.state.round.phase, h.sim.state.round.winner, h.sim.state.round.reason]).toEqual(['ROUND_END', 'T', 'elimination']);
  });
});

describe('rules/round — half, sudden death, match end', () => {
  it('half swap after round roundsToWin − 1 = 5: teams swapped, money 800, streaks 0, scores follow the teams', () => {
    const h = harness({ roundsToWin: 6 });
    const startTeams = h.sim.state.players.map((p) => p.team);
    for (let round = 1; round <= 5; round++) {
      stepUntilPhase(h, 'ROUND_END');
      expect(h.sim.state.round.roundNumber).toBe(round);
      if (round < 5) stepUntilPhase(h, 'FREEZE');
    }
    const r = h.sim.state.round;
    expect([r.scoreT, r.scoreCT, r.lossStreakT, r.half]).toEqual([0, 5, 5, 1]);
    for (const p of h.sim.state.players) p.money = 12345;
    h.human().armor = 100; h.human().inv.primary = { id: 'ak47', mag: 30, reserve: 90 };
    h.events.length = 0;
    stepUntilPhase(h, 'FREEZE');
    expect(r.roundNumber).toBe(6);
    expect(r.half).toBe(2);
    expect(h.sim.state.players.map((p) => p.team)).toEqual(startTeams.map((t) => (t === 'T' ? 'CT' : 'T')));
    expect(h.sim.state.cfg.humanTeam).toBe('CT');
    expect(h.sim.state.players.every((p) => p.money === 800)).toBe(true);
    expect([r.lossStreakT, r.lossStreakCT]).toEqual([0, 0]);
    expect([r.scoreT, r.scoreCT]).toEqual([5, 0]); // the team that won 5 rounds as CT is now T
    const me = h.human();
    expect(me.inv.pistol.id).toBe('usp'); expect(me.inv.primary).toBeNull(); expect(me.armor).toBe(0);
    expect(ofType(h, 'money').filter((m) => m.reason === 'halfReset')).toHaveLength(4);
    // humans spawn in the new team's spawn area
    expect(me.pos).toEqual(h.deps.map.spawns.CT[0].pos);
    expect(isLastRoundOfHalf(h.sim.state)).toBe(false);
  });

  it('swapSides is a pure function of the state (callable directly)', () => {
    const h = harness();
    const { sink, events } = recordingSink();
    h.sim.state.round.scoreT = 2; h.sim.state.round.scoreCT = 1; h.sim.state.round.lossStreakT = 3;
    swapSides(h.sim.state, sink);
    expect([h.sim.state.round.scoreT, h.sim.state.round.scoreCT, h.sim.state.round.lossStreakT]).toEqual([1, 2, 0]);
    expect(events.filter((e) => e.type === 'money')).toHaveLength(0); // everyone already had $800
  });

  it('(n−1):(n−1) → SUDDEN_DEATH: 60 s, no buy, no bomb, rifle + Kevlar+Helmet + pistol; expiry = draw → MATCH_END draw', () => {
    const h = harness({ roundsToWin: 4 });
    stepUntilPhase(h, 'ROUND_END');
    h.sim.state.round.scoreT = 3; h.sim.state.round.scoreCT = 3; h.sim.state.round.half = 2;
    stepUntilPhase(h, 'FREEZE');
    const r = h.sim.state.round;
    expect(r.suddenDeath).toBe(true);
    expect(r.buyWindowEndsTick).toBe(-1);
    expect(h.sim.state.bomb.state).toBe('none');
    expect(h.sim.state.players.some((p) => p.hasBomb)).toBe(false);
    for (const p of h.sim.state.players) {
      expect(p.inv.primary?.id).toBe(p.team === 'T' ? 'ak47' : 'm4a4');
      expect(p.inv.pistol.id).toBe(p.team === 'T' ? 'glock' : 'usp');
      expect([p.armor, p.helmet, p.inv.active]).toEqual([100, true, 1]);
    }
    const me = h.human(); me.money = 9000;
    expect(canBuy(me, 'he', h.sim.state, h.deps.map)).toEqual({ ok: false, error: 'window' });
    const moneyBefore = h.sim.state.players.map((p) => p.money);
    stepUntilPhase(h, 'SUDDEN_DEATH');
    expect(r.phaseEndsTick - h.sim.state.tick + 1).toBe(ROUND.suddenDeathTicks);
    stepUntilPhase(h, 'ROUND_END');
    expect([r.winner, r.reason]).toEqual([null, 'draw']);
    expect(h.sim.state.players.map((p) => p.money)).toEqual(moneyBefore);
    stepUntilPhase(h, 'MATCH_END');
    expect(ofType(h, 'matchEnd')).toEqual([expect.objectContaining({ result: 'draw', scoreT: 3, scoreCT: 3 })]);
    expect(r.phaseEndsTick).toBe(NEVER);
  });

  it('sudden death elimination decides the match; no kill money in sudden death', () => {
    const h = harness({ roundsToWin: 4 });
    stepUntilPhase(h, 'ROUND_END');
    h.sim.state.round.scoreT = 3; h.sim.state.round.scoreCT = 3;
    stepUntilPhase(h, 'SUDDEN_DEATH');
    const killerMoney = h.p(1).money;
    kill(h, 3, 1); kill(h, 4, 1);
    step(h);
    expect([h.sim.state.round.phase, h.sim.state.round.winner, h.sim.state.round.reason, h.sim.state.round.scoreT]).toEqual(['ROUND_END', 'T', 'elimination', 4]);
    expect(h.p(1).money).toBe(killerMoney);
    stepUntilPhase(h, 'MATCH_END');
    expect(ofType(h, 'matchEnd')[0]).toMatchObject({ result: 'T', scoreT: 4, scoreCT: 3 });
  });

  it('MATCH_END when a team reaches roundsToWin (after the 4 s ROUND_END)', () => {
    const h = harness({ roundsToWin: 4 });
    stepUntilPhase(h, 'LIVE');
    h.sim.state.round.scoreCT = 3; h.sim.state.round.half = 2;
    stepUntilPhase(h, 'ROUND_END');
    expect(h.sim.state.round.scoreCT).toBe(4);
    const endTick = h.sim.state.round.phaseEndsTick;
    stepUntilPhase(h, 'MATCH_END');
    expect(h.sim.state.tick - 1).toBe(endTick);
    expect(ofType(h, 'matchEnd')[0]).toMatchObject({ result: 'CT', scoreT: 0, scoreCT: 4 });
    const t = h.sim.state.tick; step(h, 5);
    expect(h.sim.state.tick).toBe(t); // the sim stops at MATCH_END
  });

  it('MVP = alive winner with the most kills (ties: lowest id); counted in stats.mvps and the roundEnd event', () => {
    const h = harness();
    stepTo(h, 400);
    h.p(2).stats.kills = 3; h.p(1).stats.kills = 3;
    kill(h, 3, 2); kill(h, 4, 2);
    step(h);
    expect(h.sim.state.round.mvp).toBe(2); // id 2 now has 5 kills
    expect(ofType(h, 'roundEnd')[0].mvp).toBe(2);
    expect(h.p(2).stats.mvps).toBe(1);
    const s = h.sim.state;
    s.players[1].stats.kills = 0; s.players[0].stats.kills = 0;
    expect(computeMvp(s, 'T')).toBe(1);
    s.players[0].alive = false; s.players[0].stats.kills = 9;
    expect(computeMvp(s, 'T')).toBe(2);
    expect(computeMvp(s, null)).toBe(0);
  });

  it('survivors keep their weapons and armor; dead players restart with the default pistol', () => {
    const h = harness();
    stepTo(h, 400);
    const me = h.human(); me.inv.primary = { id: 'ak47', mag: 12, reserve: 60 }; me.armor = 70; me.helmet = true;
    const mate = h.p(2); mate.inv.primary = { id: 'mp5', mag: 30, reserve: 120 }; mate.armor = 100;
    kill(h, 2, 3);
    stepUntilPhase(h, 'FREEZE');
    expect(me.inv.primary).toEqual({ id: 'ak47', mag: 12, reserve: 60 });
    expect([me.armor, me.helmet, me.inv.active]).toEqual([70, true, 1]);
    expect(mate.inv.primary).toBeNull(); expect(mate.armor).toBe(0); expect(mate.inv.pistol.id).toBe('glock');
  });
});
