/** Weapons through the real Simulation: determinism with firing/throwing, restore mid-flight, kills, training targets. */
import { describe, it, expect } from 'vitest';
import { v3, yawFromDir, pitchFromDir, v3sub } from '@/core/math';
import { Rng } from '@/core/rng';
import { Simulation } from '@/sim/sim';
import { createIdleBrain } from '@/ai/brain';
import { compileMap, buildStaticWorld } from '@/world/compile';
import { buildNavGraph } from '@/nav/navgraph';
import { DEPOT } from '@/maps/depot';
import { Btn, cloneCommand, IDLE_COMMAND, type InputCommand, type PlayerState } from '@/sim/state';
import type { SimEvents } from '@/sim/events';
import { giveWeapon } from '@/weapons/inventory';
import { chestPoint } from '@/weapons/hitscan';
import { eyePos } from '@/world/movement';
import { makeDeps, CFG, scriptedCommand } from '../sim/harness';

/** Harness script + grenade throws, slot switches, scope presses and drops. */
function weaponScript(t: number, rng: Rng, yaw: number): InputCommand {
  const c = scriptedCommand(t, rng, yaw);
  if (t % 420 >= 200 && t % 420 < 215) c.buttons |= Btn.THROW;
  if (t % 1300 === 650) c.buttons |= Btn.DROP;
  if (t % 333 === 100) c.buttons |= Btn.SCOPE;
  if (t % 1000 === 900) c.slot = 4;
  return c;
}
function arm(sim: Simulation): void {
  const h = sim.state.players[0];
  giveWeapon(h, 'ak47'); h.inv.he = 1; h.inv.flash = 2; h.armor = 100;
}
function counter(sim: Simulation) {
  const n: Partial<Record<keyof SimEvents, number>> = {};
  sim.events.onAny((e) => { n[e.type] = (n[e.type] ?? 0) + 1; });
  return n;
}

describe('weapons in the simulation', () => {
  const deps = makeDeps();
  it('two sims with the same seed and scripted firing/throwing have identical hashes after 2,000 ticks', () => {
    const a = new Simulation(deps, CFG), b = new Simulation(deps, CFG);
    arm(a); arm(b);
    const ca = counter(a);
    const ra = new Rng(5), rb = new Rng(5); const yaw = a.state.players[0].yaw;
    for (let t = 0; t < 2000; t++) { a.step(weaponScript(t, ra, yaw)); b.step(weaponScript(t, rb, yaw)); a.events.drain(); b.events.drain(); }
    expect(a.hash()).toBe(b.hash());
    expect(a.state.players[0].stats.shots).toBeGreaterThan(10);
    expect(ca.shot ?? 0).toBeGreaterThan(50); // bots fire too
    expect(ca.grenadeThrow ?? 0).toBeGreaterThan(0);
    expect(ca.reload ?? 0).toBeGreaterThan(0);
  }, 60000);

  it('restore(serialize()) with grenades in flight and weapon memory equals continuous play', () => {
    const a = new Simulation(deps, CFG); arm(a);
    const r = new Rng(9); const yaw = a.state.players[0].yaw;
    let t = 0;
    for (; t < 1500 && !(a.state.grenades.length > 0 && t > 400); t++) { a.step(weaponScript(t, r, yaw)); a.events.drain(); }
    expect(a.state.grenades.length).toBeGreaterThan(0);
    const b = Simulation.restore(a.serialize(), deps);
    expect(b.hash()).toBe(a.hash());
    const r2 = new Rng(77), r3 = new Rng(77);
    for (let k = 0; k < 600; k++, t++) { a.step(weaponScript(t, r2, yaw)); b.step(weaponScript(t, r3, yaw)); a.events.drain(); b.events.drain(); }
    expect(b.hash()).toBe(a.hash());
    expect(a.state.pendingDeaths).toEqual([]);
  }, 60000);

  it('a scoped AWP body shot kills through the death pipeline (kill credit, drop, death event)', () => {
    const sim = new Simulation({ ...deps, brains: createIdleBrain() }, { ...CFG, humanTeam: 'CT' });
    sim.freezeBots(true);
    const idle = (t: number) => cloneCommand(IDLE_COMMAND, t);
    let t = 0;
    while (sim.state.round.phase !== 'LIVE') sim.step(idle(t++));
    const s = sim.state; const me = s.players[0];
    const enemy = s.players.find((p) => p.team === 'T')!;
    giveWeapon(me, 'awp'); me.inv.active = 1;
    giveWeapon(enemy, 'ak47');
    place(me, 14, 11); place(enemy, 22, 11); // open Mid row (z 10–12)
    const look = aim(me, enemy);
    const deaths: SimEvents['death'][] = [];
    sim.events.on('death', (d) => { deaths.push(d); });
    const money0 = me.money;
    sim.step({ ...look(t++), buttons: Btn.SCOPE });
    sim.step(look(t++)); sim.step(look(t++));
    expect(me.scoped).toBe(1);
    sim.step({ ...look(t++), buttons: Btn.FIRE });
    sim.events.drain();
    expect(enemy.alive).toBe(false);
    expect(deaths).toHaveLength(1);
    expect(deaths[0]).toMatchObject({ victim: enemy.id, killer: me.id, weapon: 'awp' });
    expect(me.stats.kills).toBe(1); expect(me.money).toBe(money0 + 100);
    expect(s.items.some((i) => i.kind === 'weapon' && i.weapon!.id === 'ak47')).toBe(true);
  }, 60000);

  it('training: shooting a target drops it (targetHit)', () => {
    const map = compileMap(DEPOT, 'training'); const world = buildStaticWorld(map);
    const sim = new Simulation({ map, world, nav: buildNavGraph(map, world), brains: createIdleBrain() }, { ...CFG, mode: 'training', humanTeam: 'T' });
    let t = 0;
    sim.step(cloneCommand(IDLE_COMMAND, t++));
    const me = sim.state.players[0];
    giveWeapon(me, 'ak47'); me.inv.active = 1;
    const tg = sim.state.targets[0];
    place(me, tg.pos.x - 2.5, tg.pos.z); // Long, west of the first target
    const dir = v3sub(v3(tg.pos.x, tg.pos.y + 1.0, tg.pos.z), eyePos(me));
    const hits: number[] = [];
    sim.events.on('targetHit', (e) => { hits.push(e.id); });
    for (let k = 0; k < 3; k++) { const c = cloneCommand(IDLE_COMMAND, t++); c.yaw = yawFromDir(dir); c.pitch = pitchFromDir(dir); c.buttons = Btn.FIRE | Btn.CROUCH; sim.step(c); sim.events.drain(); }
    expect(hits).toContain(tg.id);
    expect(tg.up).toBe(false);
  }, 60000);
});

function place(p: PlayerState, x: number, z: number): void { p.pos = v3(x, 0, z); p.prevPos = v3(x, 0, z); p.vel = v3(); }
function aim(me: PlayerState, target: PlayerState): (t: number) => InputCommand {
  return (t: number) => {
    const d = v3sub(chestPoint(target), eyePos(me));
    const c = cloneCommand(IDLE_COMMAND, t); c.yaw = yawFromDir(d); c.pitch = pitchFromDir(d); return c;
  };
}
