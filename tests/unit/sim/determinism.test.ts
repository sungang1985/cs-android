/**
 * Determinism (§11.10, §12.1 sim row): same seed + same commands → identical hashes; restore(serialize()) + N steps
 * equals continuous play; writeSnapshot allocates nothing. The golden hash test lives in golden.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { Simulation } from '@/sim/sim';
import { createSnapshot, cloneCommand, IDLE_COMMAND } from '@/sim/state';
import { Rng } from '@/core/rng';
import { makeDeps, CFG, scriptedCommand } from './harness';

describe('simulation determinism', () => {
  const deps = makeDeps();
  it('two sims with the same seed and commands have identical hashes after 2,000 ticks', () => {
    const a = new Simulation(deps, CFG), b = new Simulation(deps, CFG);
    const ra = new Rng(5), rb = new Rng(5);
    const yaw = a.state.players[0].yaw;
    for (let t = 0; t < 2000; t++) { a.step(scriptedCommand(t, ra, yaw)); b.step(scriptedCommand(t, rb, yaw)); }
    expect(a.hash()).toBe(b.hash());
    expect(a.state.tick).toBe(2000);
  }, 60000);
  it('restore(serialize()) followed by 600 ticks equals continuous play', () => {
    const a = new Simulation(deps, CFG);
    const r = new Rng(9); const yaw = a.state.players[0].yaw;
    for (let t = 0; t < 700; t++) a.step(scriptedCommand(t, r, yaw));
    const json = a.serialize();
    const b = Simulation.restore(json, deps);
    expect(b.hash()).toBe(a.hash());
    const r2 = new Rng(77), r3 = new Rng(77);
    for (let t = 700; t < 1300; t++) { a.step(scriptedCommand(t, r2, yaw)); b.step(scriptedCommand(t, r3, yaw)); }
    expect(b.hash()).toBe(a.hash());
    expect(a.state.pendingDeaths).toEqual([]);
  }, 60000);
  it('writeSnapshot reuses every nested object (allocation-free)', () => {
    const sim = new Simulation(deps, CFG);
    const snap = createSnapshot();
    const refs = [snap.players, ...snap.players, snap.grenades, snap.items, snap.targets, snap.bomb, snap.round, snap.local, snap.local.lastKill];
    const keys = JSON.stringify(Object.keys(snap.local).sort());
    const r = new Rng(1);
    for (let i = 0; i < 600; i++) { sim.step(scriptedCommand(i, r, 0)); sim.writeSnapshot(snap); }
    const after = [snap.players, ...snap.players, snap.grenades, snap.items, snap.targets, snap.bomb, snap.round, snap.local, snap.local.lastKill];
    after.forEach((o, i) => expect(Object.is(o, refs[i])).toBe(true));
    expect(JSON.stringify(Object.keys(snap.local).sort())).toBe(keys);
    expect(snap.playerCount).toBe(10);
  }, 60000);
  it('freezeBots makes bots idle; serialisation round-trips bots and rng', () => {
    const sim = new Simulation(deps, CFG);
    sim.freezeBots(true);
    const p0 = sim.state.players.map((p) => ({ ...p.pos }));
    for (let i = 0; i < 400; i++) sim.step(cloneCommand(IDLE_COMMAND, i));
    sim.state.players.forEach((p, i) => { if (p.isBot) { expect(p.pos.x).toBeCloseTo(p0[i].x, 3); expect(p.pos.z).toBeCloseTo(p0[i].z, 3); } });
    const s = JSON.parse(sim.serialize());
    expect(Object.keys(s.rng).sort()).toEqual(['ai', 'fire', 'misc', 'spawn', 'spread'].filter((k) => k in s.rng).sort());
    expect(s.bots.length).toBe(9);
  }, 60000);
});
