/** Bench gate (§12.3): 10,000 ticks of 5v5 Hard must run in < 2.5 s (≈ 0.25 ms/tick). */
import { bench, describe } from 'vitest';
import { Simulation } from '@/sim/sim';
import { Rng } from '@/core/rng';
import { makeDeps, CFG, scriptedCommand } from '../unit/sim/harness';

const deps = makeDeps();
describe('sim throughput', () => {
  bench('10,000 ticks 5v5 hard', () => {
    const sim = new Simulation(deps, { ...CFG, difficulty: 'hard', seed: 3 });
    const r = new Rng(3); const yaw = sim.state.players[0].yaw;
    for (let t = 0; t < 10000; t++) sim.step(scriptedCommand(t, r, yaw));
  }, { iterations: 2, warmupIterations: 1, time: 0 });
});
