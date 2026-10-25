/** §12.1 ai/brain + combat rows: FSM table (stubbed perception), plant, defuse, ninja defuse, retreat, stuck recovery, Hard time-to-first-shot, fuzz. */
import { describe, it, expect } from 'vitest';
import { createBotBrain, decide, ecoDecision, nextBuy } from '@/ai/brain';
import { planTeam } from '@/ai/strategy';
import { DIFFICULTY } from '@/ai/difficulty';
import { THROW, burstTicks } from '@/ai/combat';
import { v3, DEG } from '@/core/math';
import { Rng } from '@/core/rng';
import { Btn, type BotStateId, type BotMemory, type PlayerState, type InputCommand } from '@/sim/state';
import type { SimEnvelope } from '@/sim/events';
import { makeFixture, botsOf, playersOf, place, setLive, setTick, parkOthers, lookAt, stubPer, finiteCommand, nextDecisionTick, depot, type Fixture } from './helpers';

const brainOf = (d: 'easy' | 'normal' | 'hard' = 'normal') => createBotBrain()(d);
function setup(o: Parameters<typeof makeFixture>[0] = {}) {
  const f = makeFixture(o); setTick(f, 1000); setLive(f, 10);
  const ct = botsOf(f, 'CT')[0], t = botsOf(f, 'T')[0];
  return { f, ct, t };
}
/** Runs think() for n ticks; optionally integrates the yaw (no movement physics). Returns the commands. */
function run(f: Fixture, self: PlayerState, mem: BotMemory, n: number, d: 'easy' | 'normal' | 'hard' = 'normal', applyLook = true): InputCommand[] {
  const b = brainOf(d); const out: InputCommand[] = [];
  for (let i = 0; i < n; i++) {
    setTick(f, f.ctx.tick + 1);
    const c = b.think(f.ctx, self, mem); out.push(c);
    if (applyLook) { self.yaw = c.yaw; self.pitch = c.pitch; }
  }
  return out;
}

describe('FSM table (stubbed perception)', () => {
  type Case = { name: string; from: BotStateId; to: BotStateId | BotStateId[]; prep?: (x: ReturnType<typeof setup>) => void; per?: (x: ReturnType<typeof setup>) => ReturnType<typeof stubPer> };
  const cases: Case[] = [
    { name: 'BUY after FREEZE → PLAN → MOVE', from: 'BUY', to: 'MOVE' },
    { name: 'PLAN → MOVE (goal assigned, path computed)', from: 'PLAN', to: 'MOVE' },
    { name: 'PLAN + enemy seen → ENGAGE', from: 'PLAN', to: 'ENGAGE', per: (x) => stubPer(x.t.p.id) },
    { name: 'MOVE + enemy seen → ENGAGE', from: 'MOVE', to: 'ENGAGE', per: (x) => stubPer(x.t.p.id) },
    { name: 'MOVE + heard & aggression > 0.5 → INVESTIGATE', from: 'MOVE', to: 'INVESTIGATE', prep: (x) => { x.ct.mem.profile.aggression = 0.8; x.f.state.teams.CT.lastEnemySeen.push({ id: x.t.p.id, pos: v3(30, 0, 17), tick: x.f.ctx.tick, confidence: 0.5, by: x.ct.p.id }); } },
    { name: 'MOVE + heard & aggression ≤ 0.5 → stays MOVE', from: 'MOVE', to: 'MOVE', prep: (x) => { x.ct.mem.profile.aggression = 0.3; x.f.state.teams.CT.lastEnemySeen.push({ id: x.t.p.id, pos: v3(30, 0, 17), tick: x.f.ctx.tick, confidence: 0.5, by: x.ct.p.id }); } },
    { name: 'MOVE at hold goal → HOLD', from: 'MOVE', to: 'HOLD', prep: (x) => { const g = x.f.state.teams.CT.assignments[x.ct.p.id]; place(x.ct.p, g.pos.x, g.pos.y, g.pos.z); x.ct.mem.corners = []; x.ct.mem.pathIdx = 0; } },
    { name: 'HOLD + enemy seen → ENGAGE', from: 'HOLD', to: 'ENGAGE', per: (x) => stubPer(x.t.p.id) },
    { name: 'HOLD timer expired → PLAN → MOVE', from: 'HOLD', to: 'MOVE', prep: (x) => { x.ct.mem.holdUntilTick = 0; } },
    { name: 'INVESTIGATE arrived → PLAN → MOVE', from: 'INVESTIGATE', to: 'MOVE', prep: (x) => { x.ct.mem.goal = { kind: 'investigate', pos: v3(x.ct.p.pos.x, 0, x.ct.p.pos.z) }; x.ct.mem.corners = []; } },
    { name: 'INVESTIGATE + enemy → ENGAGE', from: 'INVESTIGATE', to: 'ENGAGE', prep: (x) => { x.ct.mem.goal = { kind: 'investigate', pos: v3(30, 0, 17) }; }, per: (x) => stubPer(x.t.p.id) },
    { name: 'ENGAGE target dead → PLAN → MOVE', from: 'ENGAGE', to: 'MOVE', prep: (x) => { x.ct.mem.target = x.t.p.id; x.t.p.alive = false; } },
    { name: 'ENGAGE LOS lost > 2 s → HUNT', from: 'ENGAGE', to: 'HUNT', prep: (x) => { x.ct.mem.target = x.t.p.id; x.ct.mem.targetLastSeenTick = x.f.ctx.tick - 121; x.ct.mem.lastKnown = v3(30, 0, 17); } },
    { name: 'ENGAGE LOS lost < 2 s → stays ENGAGE', from: 'ENGAGE', to: 'ENGAGE', prep: (x) => { x.ct.mem.target = x.t.p.id; x.ct.mem.targetLastSeenTick = x.f.ctx.tick - 60; x.ct.mem.lastKnown = v3(30, 0, 17); } },
    { name: 'ENGAGE hp < retreatHp, cover ≤ 10 m, not last alive → RETREAT', from: 'ENGAGE', to: 'RETREAT', prep: (x) => { place(x.ct.p, 34, 0, 17); place(x.t.p, 22, 0, 17); x.ct.mem.target = x.t.p.id; x.ct.p.hp = 20; x.ct.p.lastDamage.tick = x.f.ctx.tick; x.ct.mem.stateSinceTick = x.f.ctx.tick - 30; }, per: (x) => stubPer(x.t.p.id) },
    { name: 'HUNT + enemy → ENGAGE', from: 'HUNT', to: 'ENGAGE', prep: (x) => { x.ct.mem.goal = { kind: 'investigate', pos: v3(30, 0, 17) }; }, per: (x) => stubPer(x.t.p.id) },
    { name: 'HUNT reached last known → PLAN → MOVE', from: 'HUNT', to: 'MOVE', prep: (x) => { x.ct.mem.goal = { kind: 'investigate', pos: v3(x.ct.p.pos.x, 0, x.ct.p.pos.z) }; x.ct.mem.corners = []; x.ct.mem.lastKnown = v3(x.ct.p.pos.x, 0, x.ct.p.pos.z); x.ct.mem.targetLastSeenTick = x.f.ctx.tick - 200; } },
    { name: 'RETREAT at cover 2 s → HOLD', from: 'RETREAT', to: 'HOLD', prep: (x) => { x.ct.mem.goal = { kind: 'roam', pos: v3(x.ct.p.pos.x, 0, x.ct.p.pos.z), holdSpot: '' }; x.ct.mem.corners = []; x.ct.mem.holdUntilTick = x.f.ctx.tick - 1; } },
    { name: 'DEAD → respawn → PLAN → MOVE', from: 'DEAD', to: 'MOVE' },
  ];
  for (const c of cases) {
    it(c.name, () => {
      const x = setup();
      x.f.state.round.roundNumber = 1;
      planTeam('CT', x.f.ctx);
      const { p, mem } = x.ct;
      place(p, 43, 0, 13); place(x.t.p, 36, 0, 13);              // the stub enemy stands 7 m away (inside every engage range)
      mem.goal = { ...x.f.state.teams.CT.assignments[p.id] };
      mem.state = c.from; mem.stateSinceTick = x.f.ctx.tick - 1; mem.holdUntilTick = 1e9;
      c.prep?.(x);
      decide(x.f.ctx, p, mem, DIFFICULTY.normal, c.per ? c.per(x) : stubPer());
      expect(Array.isArray(c.to) ? c.to : [c.to]).toContain(mem.state);
    });
  }
  it('emits botState on every transition', () => {
    const x = setup(); planTeam('CT', x.f.ctx);
    x.ct.mem.state = 'PLAN';
    decide(x.f.ctx, x.ct.p, x.ct.mem, DIFFICULTY.normal, stubPer());
    expect(x.f.events.filter((e) => e.type === 'botState').map((e) => (e.data as { state: string }).state)).toContain('MOVE');
  });
  it('TDM bots never INVESTIGATE / RETREAT', () => {
    const x = setup({ mode: 'tdm' }); planTeam('CT', x.f.ctx);
    const { p, mem } = x.ct;
    mem.profile.aggression = 0.9; mem.state = 'MOVE'; mem.goal = { ...x.f.state.teams.CT.assignments[p.id] };
    x.f.state.teams.CT.lastEnemySeen.push({ id: x.t.p.id, pos: v3(30, 0, 17), tick: x.f.ctx.tick, confidence: 0.5, by: p.id });
    decide(x.f.ctx, p, mem, DIFFICULTY.normal, stubPer());
    expect(mem.state).toBe('MOVE');
    place(x.t.p, p.pos.x - 6, p.pos.y, p.pos.z);
    mem.state = 'ENGAGE'; mem.target = x.t.p.id; p.hp = 5; p.lastDamage.tick = x.f.ctx.tick;
    decide(x.f.ctx, p, mem, DIFFICULTY.normal, stubPer(x.t.p.id));
    expect(mem.state).toBe('ENGAGE');
  });
});

describe('bomb behaviour', () => {
  it('carrier alone at the plant spot after 20 s of LIVE plants within 1.5 s (USE held)', () => {
    const f = makeFixture(); setTick(f, 2000); setLive(f, 21);
    const t = botsOf(f, 'T')[0];
    parkOthers(f, [t.p]);
    t.p.hasBomb = true; f.state.bomb.state = 'carried'; f.state.bomb.carrier = t.p.id;
    f.state.teams.T.plannedSite = 'a';
    const spot = f.ctx.map.plantSpots.a;
    place(t.p, spot.x, spot.y, spot.z, 90);
    planTeam('T', f.ctx);
    t.mem.state = 'PLAN'; t.mem.stateSinceTick = f.ctx.tick;
    const cmds = run(f, t.p, t.mem, 90);
    const first = cmds.findIndex((c) => (c.buttons & Btn.USE) !== 0);
    expect(t.mem.state).toBe('PLANT');
    expect(first).toBeGreaterThanOrEqual(0); expect(first).toBeLessThan(90);
    expect(cmds.slice(first).every((c) => c.moveX === 0 && c.moveZ === 0)).toBe(true);
  });
  it('carrier at the spot before 20 s and without a teammate waits', () => {
    const f = makeFixture(); setTick(f, 2000); setLive(f, 8);
    const t = botsOf(f, 'T')[0]; parkOthers(f, [t.p]);
    t.p.hasBomb = true; f.state.bomb.state = 'carried'; f.state.bomb.carrier = t.p.id; f.state.teams.T.plannedSite = 'a';
    const spot = f.ctx.map.plantSpots.a; place(t.p, spot.x, spot.y, spot.z, 90);
    planTeam('T', f.ctx); t.mem.state = 'PLAN';
    run(f, t.p, t.mem, 60);
    expect(t.mem.state).toBe('MOVE');
  });
  it('carrier aborts the plant on > 20 damage (Normal)', () => {
    const f = makeFixture(); setTick(f, 2000); setLive(f, 25);
    const t = botsOf(f, 'T')[0]; parkOthers(f, [t.p]);
    t.p.hasBomb = true; f.state.bomb.state = 'carried'; f.state.bomb.carrier = t.p.id; f.state.teams.T.plannedSite = 'a';
    const spot = f.ctx.map.plantSpots.a; place(t.p, spot.x, spot.y, spot.z, 90);
    planTeam('T', f.ctx); t.mem.state = 'PLANT'; t.mem.burstLeft = 100; t.mem.stateSinceTick = f.ctx.tick; t.p.hp = 70;
    decide(f.ctx, t.p, t.mem, DIFFICULTY.normal, stubPer());
    expect(t.mem.state).not.toBe('PLANT');
  });

  function plantedB(f: Fixture, secondsLeft: number) {
    const b = f.state.bomb; const pos = v3(41, 0, 31);
    b.state = 'planted'; b.pos = pos; b.site = 'b'; b.plantedTick = f.ctx.tick - 60; b.explodeTick = f.ctx.tick + Math.round(secondsLeft * 60); b.carrier = 0;
    f.state.round.phase = 'PLANTED'; f.state.round.phaseEndsTick = b.explodeTick;
    f.state.teams.CT.bombPos = v3(41, 0, 31);
    return pos;
  }
  it('CT next to a live bomb with no enemy in sight defuses (USE held, standing still)', () => {
    const f = makeFixture(); setTick(f, 3000);
    const ct = botsOf(f, 'CT')[0]; parkOthers(f, [ct.p]);
    plantedB(f, 30);
    place(ct.p, 41.8, 0, 31, 90); ct.p.hasKit = true;
    planTeam('CT', f.ctx);
    expect(f.state.teams.CT.assignments[ct.p.id].kind).toBe('bomb');
    ct.mem.state = 'PLAN';
    const cmds = run(f, ct.p, ct.mem, 120);
    expect(ct.mem.state).toBe('DEFUSE');
    expect(cmds.slice(-20).some((c) => (c.buttons & Btn.USE) !== 0)).toBe(true);
    expect(cmds.slice(-20).every((c) => c.moveX === 0 && c.moveZ === 0)).toBe(true);
  });
  it('ninja rule: with < 12 s left the CT defuses despite a visible enemy; with 30 s left it fights', () => {
    for (const [left, expectDefuse] of [[11, true], [30, false]] as const) {
      const f = makeFixture(); setTick(f, 3000);
      const ct = botsOf(f, 'CT')[0]; const enemy = playersOf(f, 'T')[0];
      parkOthers(f, [ct.p, enemy]);
      plantedB(f, left);
      place(ct.p, 41.8, 0, 31, 90); ct.p.hasKit = true;
      place(enemy, 37, 0, 31);                                      // 5 m away on B, in plain sight
      planTeam('CT', f.ctx);
      ct.mem.state = 'DEFUSE'; ct.mem.stateSinceTick = f.ctx.tick; ct.mem.goal = { kind: 'bomb', pos: v3(41, 0, 31) };
      ct.mem.corners = []; ct.mem.pathIdx = 0;
      const cmds = run(f, ct.p, ct.mem, 60);
      if (expectDefuse) { expect(ct.mem.state).toBe('DEFUSE'); expect(cmds.slice(-10).some((c) => (c.buttons & Btn.USE) !== 0)).toBe(true); }
      else expect(ct.mem.state).toBe('ENGAGE');
    }
  });
  it('post-plant: Ts take postplant_* holds and the lurker the connector; CTs designate one defuser', () => {
    const f = makeFixture({ humanTeam: 'CT' }); setTick(f, 3000);
    plantedB(f, 30);
    planTeam('T', f.ctx); planTeam('CT', f.ctx);
    const tGoals = Object.values(f.state.teams.T.assignments);
    expect(tGoals.map((g) => g.holdSpot).filter(Boolean).sort()).toEqual(expect.arrayContaining(['lurk_b_connector', 'postplant_b_n', 'postplant_b_s']));
    expect(Object.values(f.state.teams.CT.assignments).filter((g) => g.kind === 'bomb').length).toBe(1);
  });
  it('dropped bomb: the nearest T bot is sent to retrieve it', () => {
    const f = makeFixture({ humanTeam: 'CT' }); setTick(f, 3000); setLive(f, 20);
    const ts = botsOf(f, 'T');
    f.state.bomb.state = 'dropped'; f.state.bomb.pos = v3(20, 0, 17); f.state.bomb.carrier = 0;
    place(ts[2].p, 22, 0, 17);
    planTeam('T', f.ctx);
    expect(f.state.teams.T.assignments[ts[2].p.id].kind).toBe('bomb');
    expect(Object.values(f.state.teams.T.assignments).filter((g) => g.kind === 'bomb').length).toBe(1);
  });
});

describe('strategy', () => {
  it('CT default split 2 A / 2 B / 1 mid on CT hold spots; T site picked with the lurker on the connector', () => {
    const f = makeFixture({ humanTeam: 'T', seed: 4 });
    // FREEZE start of round 1
    f.state.round.phase = 'FREEZE'; f.state.round.roundNumber = 1; setTick(f, 1); f.state.round.phaseEndsTick = 301;
    planTeam('CT', f.ctx); planTeam('T', f.ctx);
    const spots = Object.values(f.state.teams.CT.assignments).map((g) => g.holdSpot!);
    const area = (id: string) => { const h = f.ctx.map.holdSpots.find((s) => s.id === id)!; expect(h.team).not.toBe('T'); return f.ctx.map.areaAt(h.pos.x, h.pos.z); };
    const areas = spots.map(area);
    expect(areas.filter((a) => a === 'site_a').length).toBe(2);
    expect(areas.filter((a) => a === 'site_b').length).toBe(2);
    expect(areas.filter((a) => a === 'mid' || a === 'ct_spawn').length).toBe(1);
    expect(['a', 'b']).toContain(f.state.teams.T.plannedSite);
    const lurk = Object.values(f.state.teams.T.assignments).filter((g) => g.holdSpot?.startsWith('lurk_'));
    expect(lurk.length).toBe(1);
    expect(lurk[0].holdSpot).toBe(`lurk_${f.state.teams.T.plannedSite}_connector`);
    for (const g of Object.values(f.state.teams.T.assignments)) expect(g.untilTick).toBe(301 + 4 * 60);   // Normal waits 4 s at the spawn exit
  });
  it('site pick: A ≈ 55 % over seeds; after a lost round the site flips 30 %', () => {
    let a = 0, flips = 0; const N = 400;
    for (let s = 1; s <= N; s++) {
      const f = makeFixture({ seed: s, teamSize: 2 });
      f.state.round.phase = 'FREEZE'; setTick(f, 1); f.state.round.phaseEndsTick = 301;
      planTeam('T', f.ctx);
      if (f.state.teams.T.plannedSite === 'a') a++;
      const prev = f.state.teams.T.plannedSite;
      setTick(f, 5000); f.state.round.phaseEndsTick = 5300; planTeam('T', f.ctx);    // plannedSite kept ⇒ "lost"
      if (f.state.teams.T.plannedSite !== prev) flips++;
    }
    expect(a / N).toBeGreaterThan(0.47); expect(a / N).toBeLessThan(0.63);
    expect(flips / N).toBeGreaterThan(0.22); expect(flips / N).toBeLessThan(0.38);
  });
  it('a confidence-1 sighting on a site rotates every CT there (Normal), never on Easy', () => {
    for (const [difficulty, rotates] of [['normal', true], ['easy', false]] as const) {
      const f = makeFixture({ humanTeam: 'T', difficulty }); setTick(f, 1000); setLive(f, 15);
      planTeam('CT', f.ctx);
      const brain = brainOf(difficulty);
      f.state.teams.CT.lastEnemySeen.push({ id: playersOf(f, 'T')[0].id, pos: v3(40, 0, 30), tick: 1000, confidence: 1, by: botsOf(f, 'CT')[0].p.id });
      brain.teamThink('CT', f.ctx);
      const sites = Object.values(f.state.teams.CT.assignments).map((g) => g.site);
      if (rotates) { expect(f.state.teams.CT.plannedSite).toBe('b'); expect(sites.every((s) => s === 'b')).toBe(true); }
      else expect(sites.filter((s) => s === 'b').length).toBeLessThan(sites.length);
    }
  });
  it('after 45 s of LIVE without contact CTs push toward T spawn through mid', () => {
    const f = makeFixture({ humanTeam: 'T' }); setTick(f, 5000); setLive(f, 46);
    f.state.teams.CT.rotateCalledTick = -1;
    planTeam('CT', f.ctx);
    for (const g of Object.values(f.state.teams.CT.assignments)) { expect(g.kind).toBe('roam'); expect(f.ctx.map.areaAt(g.pos.x, g.pos.z)).toBe('mid'); }
  });
});

describe('buying', () => {
  it('one item per tick from buyPlan during FREEZE; team eco saves; loss streak ≥ 2 forces Kevlar + Deagle', () => {
    const f = makeFixture({ humanTeam: 'T' });
    const ct = botsOf(f, 'CT')[0];
    for (const p of playersOf(f, 'CT')) p.money = 5000;
    f.state.round.phase = 'FREEZE'; setTick(f, 10); f.state.round.phaseEndsTick = 310;
    ct.mem.state = 'BUY'; ct.mem.stateSinceTick = 10;
    const c = brainOf().think(f.ctx, ct.p, ct.mem);
    expect(c.buy).toBe('m4a4');
    for (const p of playersOf(f, 'CT')) p.money = 1200;
    expect(ecoDecision(f.ctx, 'CT')).toBe(101);
    ct.mem.burstLeft = 101; expect(nextBuy(f.ctx, ct.p, ct.mem)).toBeNull();
    f.state.round.lossStreakCT = 2;
    expect(ecoDecision(f.ctx, 'CT')).toBe(102);
    ct.mem.burstLeft = 102; expect(nextBuy(f.ctx, ct.p, ct.mem)).toBe('kevlar');
    ct.p.armor = 100; expect(nextBuy(f.ctx, ct.p, ct.mem)).toBe('deagle');
  });
});

describe('combat', () => {
  it('Hard time-to-first-shot ≈ recognition 0.18 s + reaction 0.12 s (±1 tick; enemy appears on a stagger tick)', () => {
    const delays: number[] = [];
    for (let seed = 1; seed <= 24; seed++) {
      const f = makeFixture({ seed, difficulty: 'hard', humanTeam: 'T' });
      const ct = botsOf(f, 'CT')[0]; const enemy = playersOf(f, 'T')[0];
      parkOthers(f, [ct.p, enemy]);
      const T0 = nextDecisionTick(f, ct.mem, 1200);
      setTick(f, T0 - 1); setLive(f, 20);
      place(ct.p, 17, 0, 5, -90); place(enemy, 37, 0, 5);           // Long, 20 m apart
      ct.p.inv.primary = { id: 'm4a4', mag: 30, reserve: 90 }; ct.p.inv.active = 1;
      lookAt(ct.p, ct.mem, 37, 1.2, 5);
      ct.mem.state = 'HOLD'; ct.mem.holdUntilTick = 1e9; ct.mem.goal = { kind: 'hold', pos: v3(17, 0, 5), holdSpot: '' };
      const cmds = run(f, ct.p, ct.mem, 60, 'hard', false);         // cmds[0] is tick T0
      const first = cmds.findIndex((c) => (c.buttons & Btn.FIRE) !== 0);
      expect(first).toBeGreaterThan(0);
      const expected = Math.max(12, ct.mem.reactionUntilTick - T0);  // recognition is observed on the T0+12 pass
      expect(Math.abs(first - expected)).toBeLessThanOrEqual(1);
      delays.push(first);
    }
    const mean = delays.reduce((s, d) => s + d, 0) / delays.length;
    expect(Math.abs(mean - (0.18 + 0.12) * 60)).toBeLessThanOrEqual(1.5);
  });

  it('bursts: automatics hold FIRE for the burst then pause; pistols tap with release ticks', () => {
    expect(burstTicks(5, 600)).toBe(25);
    const f = makeFixture({ humanTeam: 'T' }); setTick(f, 1199); setLive(f, 20);
    const ct = botsOf(f, 'CT')[0]; const enemy = playersOf(f, 'T')[0];
    parkOthers(f, [ct.p, enemy]);
    place(ct.p, 17, 0, 5, -90); place(enemy, 30, 0, 5); lookAt(ct.p, ct.mem, 30, 1.2, 5);
    ct.mem.state = 'HOLD'; ct.mem.holdUntilTick = 1e9; ct.mem.goal = { kind: 'hold', pos: v3(17, 0, 5), holdSpot: '' };
    const cmds = run(f, ct.p, ct.mem, 240);                      // USP: semi-auto
    const fire = cmds.map((c) => (c.buttons & Btn.FIRE) !== 0);
    for (let i = 1; i < fire.length; i++) expect(fire[i] && fire[i - 1]).toBe(false);   // never two ticks in a row
    expect(fire.filter(Boolean).length).toBeGreaterThan(5);
    ct.p.inv.primary = { id: 'ak47', mag: 30, reserve: 90 }; ct.p.inv.active = 1;
    const auto = run(f, ct.p, ct.mem, 240).map((c) => (c.buttons & Btn.FIRE) !== 0);
    let runs = 0; for (let i = 1; i < auto.length; i++) if (auto[i] && !auto[i - 1]) runs++;
    expect(runs).toBeGreaterThan(1);
  });

  it('retreats to a cover node at low HP and reloads there', () => {
    const f = makeFixture({ humanTeam: 'T' }); setTick(f, 1000); setLive(f, 20);
    const ct = botsOf(f, 'CT')[0]; const enemy = playersOf(f, 'T')[0];
    place(ct.p, 34, 0, 17, 90); place(enemy, 22, 0, 17);
    ct.mem.state = 'ENGAGE'; ct.mem.stateSinceTick = 990; ct.mem.target = enemy.id; ct.mem.lastKnown = v3(22, 0, 17);
    ct.p.hp = 20; ct.p.lastDamage.tick = 995;
    decide(f.ctx, ct.p, ct.mem, DIFFICULTY.normal, stubPer(enemy.id));
    expect(ct.mem.state).toBe('RETREAT');
    const cover = ct.mem.goal!.pos;
    expect(Math.hypot(cover.x - 34, cover.z - 17)).toBeLessThanOrEqual(10);
    expect(f.ctx.world.lineOfSight(v3(cover.x, cover.y + 1.0, cover.z), v3(22, 1.2, 17))).toBe(false);
    // last alive never retreats
    for (const p of playersOf(f, 'CT')) if (p !== ct.p) p.alive = false;
    ct.mem.state = 'ENGAGE';
    decide(f.ctx, ct.p, ct.mem, DIFFICULTY.normal, stubPer(enemy.id));
    expect(ct.mem.state).toBe('ENGAGE');
  });

  it('grenades: Normal throws an HE at a heard-but-unseen group ≥ 2 within 15 m (select + THROW then release)', () => {
    const f = makeFixture({ humanTeam: 'T' }); setTick(f, 1000); setLive(f, 20);
    const ct = botsOf(f, 'CT')[0]; const ts = playersOf(f, 'T');
    parkOthers(f, [ct.p]);
    place(ct.p, 34, 0, 17, 90); ct.p.inv.he = 1;
    planTeam('CT', f.ctx);
    ct.mem.state = 'HOLD'; ct.mem.holdUntilTick = 1e9; ct.mem.goal = { ...f.state.teams.CT.assignments[ct.p.id] };
    place(ct.p, ct.mem.goal.pos.x, ct.mem.goal.pos.y, ct.mem.goal.pos.z, 90);
    for (const e of ts.slice(0, 2)) f.state.teams.CT.lastEnemySeen.push({ id: e.id, pos: v3(ct.p.pos.x - 10, 0, ct.p.pos.z + (e.id % 2)), tick: 1000, confidence: 0.5, by: ct.p.id });
    const cmds = run(f, ct.p, ct.mem, 90);
    const throwTicks = cmds.filter((c) => (c.buttons & Btn.THROW) !== 0).length;
    expect(throwTicks).toBeGreaterThanOrEqual(1);
    expect(cmds.some((c) => c.grenade === 1)).toBe(true);
    const lastThrow = cmds.map((c) => (c.buttons & Btn.THROW) !== 0).lastIndexOf(true);
    expect(lastThrow).toBeLessThan(cmds.length - 1);              // released
    expect([THROW.after, THROW.used]).toContain(ct.mem.burstLeft);
  });
});

describe('steering', () => {
  it('converts the desired world direction into body-local moves and follows the path', () => {
    const f = makeFixture({ humanTeam: 'T' }); setTick(f, 1000); setLive(f, 20);
    const ct = botsOf(f, 'CT')[0]; parkOthers(f, [ct.p]);
    place(ct.p, 40, 0, 17, 90);
    planTeam('CT', f.ctx);
    ct.mem.state = 'PLAN';
    const cmds = run(f, ct.p, ct.mem, 30);
    const moving = cmds.filter((c) => c.moveX !== 0 || c.moveZ !== 0);
    expect(moving.length).toBeGreaterThan(10);
    for (const c of moving) expect(Math.hypot(c.moveX, c.moveZ)).toBeCloseTo(1, 5);      // sprint
    const c = moving[moving.length - 1];
    // body-local → world must point at the next corner
    const fx = -Math.sin(c.yaw), fz = -Math.cos(c.yaw), rx = Math.cos(c.yaw), rz = -Math.sin(c.yaw);
    const wx = fx * c.moveZ + rx * c.moveX, wz = fz * c.moveZ + rz * c.moveX;
    const corner = ct.mem.corners[ct.mem.pathIdx] ?? ct.mem.goal!.pos;
    const dx = corner.x - ct.p.pos.x, dz = corner.z - ct.p.pos.z, l = Math.hypot(dx, dz);
    expect((wx * dx + wz * dz) / l).toBeGreaterThan(0.9);
  });

  it('stuck → jump once → still stuck → block the next path node 5 s and re-plan', () => {
    const f = makeFixture({ humanTeam: 'T' }); setTick(f, 1000); setLive(f, 20);
    const ct = botsOf(f, 'CT')[0]; parkOthers(f, [ct.p]);
    ct.mem.profile.aggression = 0.8;
    place(ct.p, 26, 0, 17, 90);
    ct.mem.state = 'MOVE'; ct.mem.goal = { kind: 'roam', pos: v3(10, 0, 17), holdSpot: '' };
    const brain = brainOf();
    setTick(f, 1001); brain.think(f.ctx, ct.p, ct.mem);
    // first think computed nothing yet (no corners) → force a path like PLAN would
    ct.mem.corners = []; decide(f.ctx, ct.p, ct.mem, DIFFICULTY.normal, stubPer());
    const original = ct.mem.path.slice();
    expect(original.length).toBeGreaterThan(5);
    const cmds = run(f, ct.p, ct.mem, 130);                       // position never changes: the bot is stuck
    const jumps = cmds.map((c, i) => ((c.buttons & Btn.JUMP) !== 0 ? i : -1)).filter((i) => i >= 0);
    expect(jumps.length).toBe(1);
    expect(jumps[0]).toBeGreaterThanOrEqual(55); expect(jumps[0]).toBeLessThanOrEqual(66);
    expect(ct.mem.blockedNode).toBeGreaterThanOrEqual(0);
    expect(ct.mem.blockedUntilTick).toBeGreaterThan(f.ctx.tick);
    expect(ct.mem.blockedUntilTick - f.ctx.tick).toBeLessThanOrEqual(300);
    expect(original).toContain(ct.mem.blockedNode);
    expect(ct.mem.path).not.toContain(ct.mem.blockedNode);
    expect(ct.mem.path).not.toEqual(original);
  });
});

describe('fuzz', () => {
  it('no NaN / out-of-range commands over 10^4 fuzzed ticks', () => {
    const f = makeFixture({ seed: 9, difficulty: 'hard' });
    const { nav, map } = depot();
    const rng = new Rng(12345);
    const brains = { easy: brainOf('easy'), normal: brainOf('normal'), hard: brainOf('hard') };
    const states: BotStateId[] = ['DEAD', 'BUY', 'PLAN', 'MOVE', 'HOLD', 'INVESTIGATE', 'ENGAGE', 'HUNT', 'RETREAT', 'PLANT', 'DEFUSE'];
    const phases = ['FREEZE', 'LIVE', 'LIVE', 'PLANTED', 'SUDDEN_DEATH'] as const;
    let bad = 0, calls = 0;
    for (let t = 0; t < 10000; t++) {
      setTick(f, t);
      if (t % 40 === 0) {
        const st = f.state;
        st.round.phase = rng.pick(phases); st.round.phaseEndsTick = t + rng.int(1, 4000); st.round.roundNumber = rng.int(1, 10);
        const bs = rng.int(0, 4); st.bomb.state = (['none', 'carried', 'dropped', 'planted', 'planted'] as const)[bs];
        st.bomb.pos = v3(rng.range(0, 48), 0, rng.range(0, 36)); st.bomb.explodeTick = t + rng.int(0, 2100); st.bomb.plantedTick = t - rng.int(0, 600); st.bomb.site = rng.chance(0.5) ? 'a' : 'b';
        st.bomb.carrier = st.bomb.state === 'carried' ? rng.pick(st.players.filter((p) => p.team === 'T')).id : 0;
        for (const p of st.players) {
          const n = rng.chance(0.9) ? nav.nodes[rng.int(0, nav.nodes.length - 1)].pos : v3(rng.range(-5, 53), rng.range(0, 3), rng.range(-5, 41));
          place(p, n.x, n.y, n.z, rng.range(-180, 180));
          p.alive = rng.chance(0.85); p.hp = rng.int(1, 100); p.crouched = rng.chance(0.2); p.hasBomb = st.bomb.carrier === p.id;
          p.blindUntilTick = rng.chance(0.1) ? t + rng.int(1, 200) : 0; p.vel = v3(rng.range(-5, 5), 0, rng.range(-5, 5));
          p.lastDamage.tick = rng.chance(0.3) ? t : -1000; p.money = rng.int(0, 16000); p.hasKit = rng.chance(0.3);
          p.inv.he = rng.int(0, 1); p.inv.flash = rng.int(0, 2); p.scoped = rng.chance(0.1) ? 1 : 0;
          if (rng.chance(0.5)) { p.inv.primary = { id: rng.pick(['ak47', 'm4a4', 'awp', 'mp5'] as const), mag: rng.int(0, 30), reserve: rng.int(0, 90) }; p.inv.active = 1; }
          else { p.inv.primary = null; p.inv.active = rng.pick([2, 3] as const); }
          p.inv.pistol.mag = rng.int(0, 12);
        }
        for (const m of st.bots) {
          if (rng.chance(0.5)) { m.state = rng.pick(states); m.stateSinceTick = t - rng.int(0, 600); }
          if (rng.chance(0.2)) m.goal = null;
          if (rng.chance(0.2)) { m.target = rng.pick(st.players).id; m.lastKnown = rng.chance(0.5) ? v3(rng.range(0, 48), 0, rng.range(0, 36)) : null; }
          if (rng.chance(0.1)) { m.corners = []; m.path = []; }
        }
        if (rng.chance(0.3)) st.teams.T.lastEnemySeen.push({ id: rng.pick(st.players).id, pos: map.plantSpots.a, tick: t, confidence: rng.chance(0.5) ? 1 : 0.5, by: st.bots[0].id });
      }
      for (const team of ['T', 'CT'] as const) brains.normal.teamThink(team, f.ctx);
      for (const m of f.state.bots) {
        const p = f.state.players.find((q) => q.id === m.id)!;
        if (!p.alive) continue;
        const c = brains[m.profile.difficulty].think(f.ctx, p, m); calls++;
        if (!finiteCommand(c)) bad++;
        p.yaw = c.yaw; p.pitch = c.pitch;
        if (rng.chance(0.05)) {
          const src = rng.pick(f.state.players);
          const env: SimEnvelope = { type: 'sound', data: { id: 'fire_ak', pos: v3(src.pos.x, src.pos.y, src.pos.z), loudness: rng.pick([10, 30, 40, 60, 1000]), player: rng.chance(0.2) ? 0 : src.id }, tick: t };
          brains.normal.onEvent(env, m, p, f.ctx);
        }
      }
    }
    expect(calls).toBeGreaterThan(50000);
    expect(bad).toBe(0);
  }, 60000);
});

describe('determinism', () => {
  it('two identical contexts produce identical commands and memory', () => {
    const mk = () => { const f = makeFixture({ seed: 21 }); setTick(f, 1000); setLive(f, 20); planTeam('CT', f.ctx); planTeam('T', f.ctx); return f; };
    const a = mk(), b = mk();
    const ba = brainOf(), bb = brainOf();
    for (let t = 0; t < 600; t++) {
      for (const [f, br] of [[a, ba], [b, bb]] as const) {
        setTick(f, 1000 + t);
        for (const team of ['T', 'CT'] as const) br.teamThink(team, f.ctx);
        for (const m of f.state.bots) { const p = f.state.players.find((q) => q.id === m.id)!; const c = br.think(f.ctx, p, m); p.yaw = c.yaw; p.pitch = c.pitch; p.pos.x += c.moveZ * 0.01; }
      }
    }
    expect(JSON.stringify(a.state.bots)).toBe(JSON.stringify(b.state.bots));
    expect(JSON.stringify(a.state.teams)).toBe(JSON.stringify(b.state.teams));
  });
  void DEG;
});
