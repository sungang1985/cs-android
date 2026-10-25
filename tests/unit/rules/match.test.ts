/** createMatch/defaultProfiles, a full idle defusal match, and restore(serialize()) across a round transition. */
import { describe, it, expect } from 'vitest';
import { RngStreams } from '@/core/rng';
import { createMatch, defaultProfiles, BOT_NAME_KEYS, HUMAN_NAME_KEY } from '@/rules/match';
import { BOT_NAME_KEYS as AI_NAME_KEYS } from '@/ai/names';
import { Simulation } from '@/sim/sim';
import { harness, step, stepUntilPhase, ofType, cfg, makeDeps, humanCmd } from './helpers';

describe('rules/match — createMatch', () => {
  it('defusal 5v5: human id 1, friendly bots 2…5, enemies 6…10, $800 each, slot spawns, one C4 carrier after round start', () => {
    const deps = makeDeps('depot');
    const s = createMatch(cfg({ teamSize: 5, humanTeam: 'CT' }), deps.map, undefined, new RngStreams(1));
    expect(s.players.map((p) => p.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(s.players.map((p) => p.team)).toEqual(['CT', 'CT', 'CT', 'CT', 'CT', 'T', 'T', 'T', 'T', 'T']);
    expect(s.players[0]).toMatchObject({ isBot: false, nameKey: HUMAN_NAME_KEY });
    expect(s.players.slice(1).every((p) => p.isBot && p.nameKey.startsWith('bot.'))).toBe(true);
    expect(s.bots.map((m) => m.id)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(s.players.every((p) => p.money === 800)).toBe(true);
    expect(s.players[0].pos).toEqual(deps.map.spawns.CT[0].pos);
    expect(s.nextId).toBe(11);
    expect(s.round.phase).toBe('WARMUP');
  });

  it('team sizes 3 and 2; TDM starts with $0; training creates only the human + targets', () => {
    const deps = makeDeps('depot');
    expect(createMatch(cfg({ teamSize: 3 }), deps.map, undefined, new RngStreams(1)).players).toHaveLength(6);
    expect(createMatch(cfg({ teamSize: 2 }), deps.map, undefined, new RngStreams(1)).players.map((p) => p.team)).toEqual(['T', 'T', 'CT', 'CT']);
    expect(createMatch(cfg({ mode: 'tdm', teamSize: 5 }), deps.map, undefined, new RngStreams(1)).players.every((p) => p.money === 0)).toBe(true);
    const tr = makeDeps('depot', 'training');
    const t = createMatch(cfg({ mode: 'training', teamSize: 5 }), tr.map, undefined, new RngStreams(1));
    expect(t.players).toHaveLength(1);
    expect(t.targets).toHaveLength(tr.map.training!.targets.length);
    expect(t.targets.every((x) => x.up)).toBe(true);
  });

  it('defaultProfiles: §6.1 matrix (Easy → friendlies Normal), name keys from BOT_NAME_KEYS', () => {
    expect(BOT_NAME_KEYS).toEqual(AI_NAME_KEYS);
    const easy = defaultProfiles(cfg({ teamSize: 5, difficulty: 'easy' }));
    expect(easy).toHaveLength(9);
    expect(easy.map((p) => p.difficulty)).toEqual(['normal', 'normal', 'normal', 'normal', 'easy', 'easy', 'easy', 'easy', 'easy']);
    expect(easy.map((p) => p.nameKey)).toEqual(BOT_NAME_KEYS.slice(0, 9).map((k) => 'bot.' + k));
    expect(defaultProfiles(cfg({ teamSize: 3, difficulty: 'hard' })).map((p) => p.difficulty)).toEqual(['hard', 'hard', 'hard', 'hard', 'hard']);
    expect(easy[0]).toMatchObject({ preferredWeapon: 'rifle', aggression: 0.5, holdPreference: 0.5 });
  });
});

describe('rules/match — full flow', () => {
  it('idle bots + idle human, first to 4: every round is a CT time win; 3:0, swap, 3:3, sudden death draw → MATCH_END in 7 rounds', () => {
    const h = harness({ roundsToWin: 4 });
    stepUntilPhase(h, 'MATCH_END', 8 * 5100);
    const ends = ofType(h, 'roundEnd');
    expect(ends.length).toBeLessThanOrEqual(7);
    expect(ends.map((e) => e.reason)).toEqual(['time', 'time', 'time', 'time', 'time', 'time', 'draw']);
    expect(ends.slice(0, 6).every((e) => e.winner === 'CT')).toBe(true);
    expect(h.sim.state.round.suddenDeath).toBe(true);
    expect(ofType(h, 'matchEnd')).toEqual([expect.objectContaining({ result: 'draw', scoreT: 3, scoreCT: 3 })]);
    const phases = ofType(h, 'roundPhase').map((e) => e.phase);
    expect(phases.filter((p) => p === 'FREEZE')).toHaveLength(7);
    expect(phases.filter((p) => p === 'SUDDEN_DEATH')).toHaveLength(1);
    expect(phases.at(-1)).toBe('MATCH_END');
  });

  it('restore(serialize()) + 600 ticks equals continuous play across ROUND_END → FREEZE', () => {
    const a = harness();
    while (a.sim.state.tick < 4700) step(a);
    const json = a.sim.serialize();
    const b = Simulation.restore(json, a.deps);
    expect(b.hash()).toBe(a.sim.hash());
    for (let i = 0; i < 600; i++) {
      const c = humanCmd(a);
      a.sim.step(c); b.step({ ...c });
    }
    expect(a.sim.state.round.roundNumber).toBe(2);
    expect(a.sim.state.round.phase).toBe('FREEZE');
    expect(b.hash()).toBe(a.sim.hash());
  });

  it('two sims with the same seed pick the same bomb carrier (spawn stream) and hash identically', () => {
    const run = () => {
      const h = harness({ seed: 77 });
      while (h.sim.state.tick < 400) step(h);
      const carrier = h.sim.state.players.find((p) => p.hasBomb)!;
      return { carrier: carrier.id, hash: h.sim.hash() };
    };
    expect(run()).toEqual(run());
  });
});
