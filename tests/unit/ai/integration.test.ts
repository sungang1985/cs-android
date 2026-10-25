/**
 * End-to-end bot pipelines on the real Simulation (nav → steering → movePlayer → objective). Contact is removed by
 * taking the opposing bots out at LIVE start (the idle human keeps the round alive), because in this worktree the
 * weapons/bomb rules are still stubs and a duel would never resolve.
 */
import { describe, it, expect } from 'vitest';
import { Simulation } from '@/sim/sim';
import { createBotBrain } from '@/ai/brain';
import { makeProfiles } from '@/ai/profiles';
import { rectContains } from '@/world/types';
import { v3 } from '@/core/math';
import { cloneCommand, IDLE_COMMAND, type MatchConfig, type Difficulty, type Team } from '@/sim/state';
import { depot } from './helpers';

function sim(seed: number, humanTeam: Team, difficulty: Difficulty = 'normal') {
  const { map, world, nav } = depot();
  const cfg: MatchConfig = { mode: 'defusal', seed, humanTeam, difficulty, teamSize: 5, roundsToWin: 6, tdmSeconds: 240, tdmKills: 30, mapId: 'depot', options: { autoPickup: true, scopeHold: true } };
  return new Simulation({ map, world, nav, brains: createBotBrain() }, cfg, makeProfiles(cfg));
}
function stepUntilLive(s: Simulation): void { for (let t = 0; t < 400 && s.state.round.phase !== 'LIVE'; t++) s.step(cloneCommand(IDLE_COMMAND, s.state.tick)); }
function removeBots(s: Simulation, team: Team): void { for (const p of s.state.players) if (p.isBot && p.team === team) { p.alive = false; p.hp = 0; p.pos = v3(1, 0, 1); } }

describe('integration: uncontested objectives', () => {
  for (const seed of [1, 2, 3]) {
    it(`seed ${seed}: the T carrier walks to the planned site and starts planting`, () => {
      const s = sim(seed, 'CT');
      stepUntilLive(s);
      removeBots(s, 'CT');
      const site = s.state.teams.T.plannedSite!;
      expect(['a', 'b']).toContain(site);
      const carrier = s.state.players.find((p) => p.hasBomb)!;
      expect(carrier.isBot).toBe(true);
      let plantTick = -1;
      const live0 = s.state.tick;
      for (let t = 0; t < 45 * 60 && plantTick < 0; t++) {
        s.step(cloneCommand(IDLE_COMMAND, s.state.tick));
        for (const e of s.events.drain()) if (e.type === 'botState' && (e.data as { bot: number; state: string }).bot === carrier.id && (e.data as { state: string }).state === 'PLANT') plantTick = s.state.tick;
      }
      expect(plantTick).toBeGreaterThan(0);
      const area = s.deps.map.areas.find((a) => a.id === (site === 'a' ? 'site_a' : 'site_b'))!;
      expect(rectContains(area.rect, carrier.pos.x, carrier.pos.z)).toBe(true);
      const sec = (plantTick - live0) / 60;
      expect(sec).toBeGreaterThan(8); expect(sec).toBeLessThan(35);     // ≈ 46 m at 4.3 m/s + Normal's 4 s rush wait
      // standing still and holding USE
      for (let t = 0; t < 30; t++) s.step(cloneCommand(IDLE_COMMAND, s.state.tick));
      expect(Math.hypot(carrier.vel.x, carrier.vel.z)).toBeLessThan(0.5);
    }, 30000);
  }

  it('CTs learn a planted bomb, one walks to it and defuses; the others hold the site', () => {
    const s = sim(5, 'T');
    stepUntilLive(s);
    removeBots(s, 'T');
    const st = s.state, pos = { ...s.deps.map.plantSpots.b };
    st.bomb = { state: 'planted', carrier: 0, itemId: 0, pos: v3(pos.x, pos.y, pos.z), plantedTick: st.tick, explodeTick: st.tick + 35 * 60, site: 'b' };
    st.round.phase = 'PLANTED'; st.round.phaseEndsTick = st.bomb.explodeTick;
    let defuser = 0;
    for (let t = 0; t < 20 * 60 && !defuser; t++) {
      s.step(cloneCommand(IDLE_COMMAND, s.state.tick));
      for (const e of s.events.drain()) if (e.type === 'botState' && (e.data as { state: string }).state === 'DEFUSE') defuser = (e.data as { bot: number }).bot;
    }
    expect(defuser).toBeGreaterThan(0);
    const d = st.players.find((p) => p.id === defuser)!;
    expect(Math.hypot(d.pos.x - pos.x, d.pos.z - pos.z)).toBeLessThanOrEqual(1.5);
    const others = Object.entries(st.teams.CT.assignments).filter(([id]) => Number(id) !== defuser).map(([, g]) => g);
    expect(others.length).toBeGreaterThan(0);
    expect(others.every((g) => g.site === 'b')).toBe(true);
  }, 30000);

  it('restore(serialize()) mid-round continues identically with the real brain', () => {
    const a = sim(11, 'CT', 'hard');
    for (let t = 0; t < 900; t++) a.step(cloneCommand(IDLE_COMMAND, t));
    const b = Simulation.restore(a.serialize(), a.deps);
    for (let t = 900; t < 1500; t++) { a.step(cloneCommand(IDLE_COMMAND, t)); b.step(cloneCommand(IDLE_COMMAND, t)); }
    expect(b.hash()).toBe(a.hash());
  }, 30000);
});
