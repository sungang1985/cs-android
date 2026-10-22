/**
 * Golden hash (§11.10): 3 rounds worth of ticks with seed 42 and a scripted command log must hash to the stored
 * value. Regenerate deliberately with `npm run golden:update` when gameplay changes (same PR). Only required to
 * match on the pinned Node version (.nvmrc).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Simulation } from '@/sim/sim';
import { Rng } from '@/core/rng';
import { makeDeps, CFG, scriptedCommand } from './harness';

const GOLDEN = fileURLToPath(new URL('../../golden/depot-seed42.json', import.meta.url));
const TICKS = 3 * 60 * 80; // ≈ 3 rounds of 80 s incl. freeze

describe('golden determinism', () => {
  it(`hash after ${TICKS} ticks matches tests/golden/depot-seed42.json`, () => {
    const sim = new Simulation(makeDeps(), { ...CFG, seed: 42 });
    const r = new Rng(42); const yaw = sim.state.players[0].yaw;
    const checkpoints: Record<string, number> = {};
    for (let t = 0; t < TICKS; t++) { sim.step(scriptedCommand(t, r, yaw)); if ((t + 1) % 3600 === 0) checkpoints[String(t + 1)] = sim.hash(); }
    const result = { ticks: TICKS, hash: sim.hash(), checkpoints, round: sim.state.round.roundNumber, scoreT: sim.state.round.scoreT, scoreCT: sim.state.round.scoreCT };
    if (process.env.GOLDEN_UPDATE === '1' || !fs.existsSync(GOLDEN)) {
      fs.mkdirSync(new URL('../../golden/', import.meta.url), { recursive: true });
      fs.writeFileSync(GOLDEN, JSON.stringify(result, null, 2) + '\n');
      console.log(`[golden] wrote ${GOLDEN}: ${JSON.stringify(result)}`);
      return;
    }
    const stored = JSON.parse(fs.readFileSync(GOLDEN, 'utf8')) as typeof result;
    expect(result.ticks).toBe(stored.ticks);
    expect(result.checkpoints).toEqual(stored.checkpoints);
    expect(result.hash).toBe(stored.hash);
  }, 120000);
});
