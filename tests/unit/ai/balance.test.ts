/**
 * Short bot-only match per difficulty (§12.1 ai/balance, CI-sized; the full batch is `npm run balance`).
 * The human slot is bot-driven (full 3v3); `idleHuman` keeps the old idle-human harness available.
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
      expect(moves.length).toBe(6);                                     // 3v3, the human slot bot-driven
      for (const [id, d] of moves) expect(d, `bot ${id} moved ${d.toFixed(1)} m`).toBeGreaterThan(5);
      expect(m.rounds.length).toBeGreaterThanOrEqual(1);
      expect(m.shots).toBeGreaterThan(0); expect(m.kills).toBeGreaterThan(0);
    }, 60000);
  }
  it('idle-human harness: the human slot stays an idle human (5 bots)', () => {
    const m = runMatch({ seed: 7, difficulty: 'normal', teamSize: 3, roundsToWin: 1, tickCap: 60 * 40, idleHuman: true });
    expect(m.exceptions).toEqual([]);
    expect(Object.keys(m.firstRoundMove).length).toBe(5);
  }, 60000);
});
