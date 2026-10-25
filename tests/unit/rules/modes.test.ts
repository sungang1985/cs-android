/** §2.3 TDM and §2.4 training. */
import { describe, it, expect } from 'vitest';
import { RngStreams } from '@/core/rng';
import { v3 } from '@/core/math';
import { createMatch } from '@/rules/match';
import { MODES, chooseTdmSpawn, TDM } from '@/rules/modes';
import { NEVER } from '@/rules/round';
import { canBuy } from '@/rules/economy';
import { harness, step, stepTo, stepUntilPhase, kill, teleport, ofType, cfg, makeDeps } from './helpers';

describe('rules/modes — TDM', () => {
  it('FREEZE 3 s → LIVE for cfg.tdmSeconds; no bomb; money 0; buy anywhere for free', () => {
    const h = harness({ mode: 'tdm', tdmSeconds: 240 });
    step(h);
    expect([h.sim.state.round.phase, h.sim.state.round.phaseEndsTick]).toEqual(['FREEZE', 180]);
    expect(h.sim.state.bomb.state).toBe('none');
    expect(h.sim.state.players.every((p) => p.money === 0 && !p.hasBomb)).toBe(true);
    stepTo(h, 181);
    expect([h.sim.state.round.phase, h.sim.state.round.phaseEndsTick]).toEqual(['LIVE', 180 + 240 * 60]);
    expect(canBuy(h.human(), 'ak47', h.sim.state, h.deps.map)).toEqual({ ok: true, price: 0 });
  });

  it('respawn 2 s after death with the remembered loadout and 2 s spawn protection; kills counted per team', () => {
    const h = harness({ mode: 'tdm' });
    stepTo(h, 300);
    const victim = h.p(3);
    victim.lastBuy = ['m4a4', 'kevlar_helmet', 'he'];
    kill(h, 3, 1, 'glock');
    expect(h.sim.state.round.tdmKillsT).toBe(1);
    const deathTick = victim.deathTick;
    expect(deathTick).toBe(300);
    stepTo(h, deathTick + TDM.respawnTicks);
    expect(victim.alive).toBe(false);
    expect(victim.respawnTick).toBe(deathTick + 120);
    step(h);
    expect(victim.alive).toBe(true);
    expect(ofType(h, 'respawn')).toEqual([expect.objectContaining({ player: 3, tick: deathTick + 120 })]);
    expect(victim.invulnerableUntilTick).toBe(deathTick + 240);
    expect([victim.inv.primary?.id, victim.inv.active, victim.armor, victim.helmet, victim.inv.he, victim.hp]).toEqual(['m4a4', 1, 100, true, 1, 100]);
    expect(h.deps.map.spawns.CT.some((s) => s.pos.x === victim.pos.x && s.pos.z === victim.pos.z)).toBe(true);
    expect(h.sim.state.round.scoreT).toBe(1); // TDM kills mirrored into the score (HUD)
  });

  it(`first to cfg.tdmKills (30) ends the match: roundEnd + MATCH_END + matchEnd`, () => {
    const h = harness({ mode: 'tdm' });
    stepTo(h, 300);
    h.sim.state.round.tdmKillsT = 29;
    kill(h, 3, 1);
    step(h);
    expect(h.sim.state.round.phase).toBe('MATCH_END');
    expect(ofType(h, 'roundEnd')[0]).toMatchObject({ winner: 'T', reason: 'elimination', mvp: 1 });
    expect(ofType(h, 'matchEnd')).toEqual([expect.objectContaining({ result: 'T', scoreT: 30, scoreCT: 0 })]);
  });

  it('time expiry: most kills wins (`time`), equal kills = draw', () => {
    const h = harness({ mode: 'tdm', tdmSeconds: 5 });
    stepTo(h, 200);
    kill(h, 1, 3); kill(h, 2, 4);
    stepUntilPhase(h, 'MATCH_END');
    expect(ofType(h, 'roundEnd')[0]).toMatchObject({ winner: 'CT', reason: 'time' });
    expect(ofType(h, 'matchEnd')[0]).toMatchObject({ result: 'CT', scoreT: 0, scoreCT: 2 });
    const g = harness({ mode: 'tdm', tdmSeconds: 5 });
    stepUntilPhase(g, 'MATCH_END');
    expect(ofType(g, 'roundEnd')[0]).toMatchObject({ winner: null, reason: 'draw' });
    expect(ofType(g, 'matchEnd')[0]).toMatchObject({ result: 'draw' });
    expect(g.sim.state.tick).toBe(180 + 5 * 60 + 1);
  });

  it('spawn choice: random among spawns ≥ 12 m from every enemy (not occupied), else the farthest (ties lowest index)', () => {
    const deps = makeDeps('depot');
    const c = cfg({ mode: 'tdm', teamSize: 5, humanTeam: 'T' });
    const streams = new RngStreams(3);
    const s = createMatch(c, deps.map, undefined, streams);
    const me = s.players[0];
    const ct = s.players.filter((p) => p.team === 'CT');
    const tSpawns = deps.map.spawns.T;
    // every enemy far away (CT spawn) → all 5 qualify; teammates stand on spawns 1..4 → spawn 0 is the only free one
    s.players.filter((p) => p.team === 'T' && p !== me).forEach((p, i) => { p.pos = v3(tSpawns[i + 1].pos.x, 0, tSpawns[i + 1].pos.z); });
    for (let i = 0; i < 10; i++) expect(chooseTdmSpawn(s, me, deps.map, streams.get('spawn'))).toBe(0);
    // nobody occupies: picks vary but are all qualifying
    s.players.filter((p) => p.team === 'T' && p !== me).forEach((p) => { p.pos = v3(20, 0, 30); });
    const picks = new Set<number>();
    for (let i = 0; i < 40; i++) picks.add(chooseTdmSpawn(s, me, deps.map, streams.get('spawn')));
    expect(picks.size).toBeGreaterThan(1);
    // an enemy in the T spawn: nothing is ≥ 12 m away → farthest from it
    for (const p of ct) p.pos = v3(40, 0, 18);
    ct[0].pos = v3(tSpawns[0].pos.x, 0, tSpawns[0].pos.z);
    expect(chooseTdmSpawn(s, me, deps.map, streams.get('spawn'))).toBe(4);
    // determinism: same stream state → same choice
    const a = new RngStreams(9), b = new RngStreams(9);
    for (const p of ct) p.pos = v3(40, 0, 18);
    const seqA = Array.from({ length: 8 }, () => chooseTdmSpawn(s, me, deps.map, a.get('spawn')));
    const seqB = Array.from({ length: 8 }, () => chooseTdmSpawn(s, me, deps.map, b.get('spawn')));
    expect(seqA).toEqual(seqB);
  });

  it('bots respawn too (scheduled by tickRound, placed by MODES.tdm.respawn)', () => {
    const h = harness({ mode: 'tdm' });
    stepTo(h, 300);
    kill(h, 4, 2);
    step(h, 121);
    expect(h.p(4).alive).toBe(true);
    expect(h.sim.state.bots.find((m) => m.id === 4)?.state).toBe('PLAN');
    expect(MODES.tdm.respawnTicks).toBe(120);
  });
});

describe('rules/modes — training', () => {
  it('only the human + the map targets; no timer; $16,000 and free buying anywhere', () => {
    const h = harness({ mode: 'training' }, 'depot');
    const s = h.sim.state;
    expect(s.players).toHaveLength(1);
    expect(s.players[0].id).toBe(1);
    expect(s.targets.map((t) => t.id)).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
    expect(s.bots).toHaveLength(0);
    step(h);
    expect([s.round.phase, s.round.phaseEndsTick]).toEqual(['LIVE', NEVER]);
    expect(s.players[0].money).toBe(16000);
    teleport(h.human(), 20, 0, 4);
    expect(canBuy(h.human(), 'awp', s, h.deps.map)).toEqual({ ok: true, price: 0 });
    step(h, 2000);
    expect(s.round.phase).toBe('LIVE');
  });

  it('a downed target pops back up at downUntilTick (targetReset); no randomness', () => {
    const h = harness({ mode: 'training' }, 'depot');
    step(h, 10);
    const t = h.sim.state.targets[2];
    t.up = false; t.downUntilTick = h.sim.state.tick + 120;
    const due = t.downUntilTick;
    stepTo(h, due);
    expect(t.up).toBe(false);
    step(h);
    expect(t.up).toBe(true);
    expect(ofType(h, 'targetReset')).toEqual([{ id: t.id, tick: due }]);
  });

  it('the human respawns 2 s after dying (e.g. own HE)', () => {
    const h = harness({ mode: 'training' }, 'depot');
    step(h, 10);
    kill(h, 1, 1, 'he');
    step(h, 121);
    expect(h.human().alive).toBe(true);
    expect(h.human().pos).toEqual(h.deps.map.spawns.T[0].pos);
  });
});
