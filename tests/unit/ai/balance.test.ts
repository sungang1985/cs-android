/**
 * Short bot-only match per difficulty (§12.1 ai/balance, CI-sized; the full 20-seed batch is tools/balance-sim.mjs).
 * The human idles at spawn. Kill assertions are conditional: until the weapons lane lands, tickWeapon is a stub and
 * no `shot` event is ever emitted.
 */
import { describe, it, expect } from 'vitest';
import { runMatch } from '../../../tools/balance-sim';

describe('balance smoke (teamSize 3, first to 2)', () => {
  for (const difficulty of ['easy', 'normal', 'hard'] as const) {
    it(`${difficulty}: no exceptions, no NaN, every bot moves > 5 m in round 1`, () => {
      const m = runMatch({ seed: 7, difficulty, teamSize: 3, roundsToWin: 2, tickCap: 3 * 60 * 75 });
      expect(m.exceptions).toEqual([]);
      expect(m.badCommands).toBe(0);
      expect(m.nanStates).toBe(0);
      const moves = Object.entries(m.firstRoundMove);
      expect(moves.length).toBe(5);                                     // 3v3 with one idle human = 5 bots
      for (const [id, d] of moves) expect(d, `bot ${id} moved ${d.toFixed(1)} m`).toBeGreaterThan(5);
      expect(m.rounds.length).toBeGreaterThanOrEqual(1);
      if (m.shots > 0) expect(m.kills).toBeGreaterThan(0);
    }, 60000);
  }
});
