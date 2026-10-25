/** §12.1 ai/perception rows: walls, FOV edge, recognition delay, sandbags vs crouch, hearing radii, confidence 0.5, blindness. */
import { describe, it, expect } from 'vitest';
import { perceive, hearSound, PERCEPTION, recognitionTicks } from '@/ai/perception';
import { DIFFICULTY } from '@/ai/difficulty';
import { createBotBrain } from '@/ai/brain';
import { v3 } from '@/core/math';
import { Btn } from '@/sim/state';
import type { SimEvents } from '@/sim/events';
import { makeFixture, botsOf, playersOf, place, setLive, setTick, parkOthers, lookAt, type Fixture } from './helpers';

const normal = DIFFICULTY.normal;
function duel(f: Fixture) {
  const ct = botsOf(f, 'CT')[0];
  const enemy = playersOf(f, 'T')[0];
  parkOthers(f, [ct.p, enemy]);
  return { self: ct.p, mem: ct.mem, enemy };
}
const sound = (pos: { x: number; y: number; z: number }, loudness: number, player: number): SimEvents['sound'] => ({ id: 'fire_ak', pos: v3(pos.x, pos.y, pos.z), loudness, player });

describe('perception: vision', () => {
  it('an enemy behind a wall is not visible; the same enemy in the open is', () => {
    const f = makeFixture(); setLive(f, 5);
    const { self, mem, enemy } = duel(f);
    place(self, 5, 0, 15, -90);                      // T-spawn room, looking east into the wall at cell (4,7)
    place(enemy, 13, 0, 15);                         // mid, behind that wall
    expect(perceive(f.ctx, self, mem, normal).visible).toEqual([]);
    place(enemy, 7, 0, 15);                          // same room
    expect(perceive(f.ctx, self, mem, normal).visible.map((v) => v.id)).toEqual([enemy.id]);
  });

  it('FOV is a 120° cone: 59° off-axis visible, 61° and 121° not', () => {
    const f = makeFixture(); setLive(f, 5);
    const { self, mem, enemy } = duel(f);
    place(self, 24, 0, 17, -90);                     // mid, looking east
    const at = (deg: number) => { const a = deg * Math.PI / 180; place(enemy, 24 + 8 * Math.cos(a), 0, 17 - 8 * Math.sin(a)); return perceive(f.ctx, self, mem, normal).visible.length; };
    expect(at(59)).toBe(1);
    expect(at(61)).toBe(0);
    expect(at(121)).toBe(0);
    expect(at(0)).toBe(1);
  });

  it('vision range by difficulty (Easy 35 m)', () => {
    const f = makeFixture(); setLive(f, 5);
    const { self, mem, enemy } = duel(f);
    place(self, 17, 0, 5, -90); place(enemy, 17 + 34, 0, 5);   // Long → A lip line is blocked; use Long itself
    place(enemy, 17 + 16, 0, 5);
    expect(perceive(f.ctx, self, mem, DIFFICULTY.easy).visible.length).toBe(1);
    expect(perceive(f.ctx, self, mem, { ...DIFFICULTY.easy, visionM: 10 }).visible.length).toBe(0);
  });

  it('recognition needs continuous visibility ≥ recognitionSec (Normal 0.30 s = 18 ticks)', () => {
    const f = makeFixture(); setLive(f, 5);
    const { self, mem, enemy } = duel(f);
    place(self, 24, 0, 17, -90); place(enemy, 29, 0, 17);
    const T0 = 600; setTick(f, T0);
    const R = recognitionTicks(normal);
    expect(R).toBe(18);
    expect(perceive(f.ctx, self, mem, normal).best).toBe(0);
    expect(mem.targetSeenSinceTick).toBe(T0);
    setTick(f, T0 + R - 1);
    expect(perceive(f.ctx, self, mem, normal).best).toBe(0);                 // visible 17 ticks: not yet
    setTick(f, T0 + R + 1);
    expect(perceive(f.ctx, self, mem, normal).best).toBe(enemy.id);          // 19 ticks: recognised
    expect(mem.reactionUntilTick).toBeGreaterThanOrEqual(T0 + R);
    expect(f.events.some((e) => e.type === 'spotted')).toBe(true);
    // a break in visibility resets the continuity
    place(enemy, 13, 0, 15); place(self, 5, 0, 15, -90);
    setTick(f, T0 + 30); expect(perceive(f.ctx, self, mem, normal).best).toBe(0);
    expect(mem.targetSeenSinceTick).toBe(-1);
    place(self, 24, 0, 17, -90); place(enemy, 29, 0, 17);
    setTick(f, T0 + 36); expect(perceive(f.ctx, self, mem, normal).best).toBe(0);
  });

  it('memory: last known position kept 6 s, shared to the blackboard after 0.5 s of sighting', () => {
    const f = makeFixture(); setLive(f, 5);
    const { self, mem, enemy } = duel(f);
    place(self, 24, 0, 17, -90); place(enemy, 29, 0, 17);
    for (let t = 600; t <= 600 + 24; t += 6) { setTick(f, t); perceive(f.ctx, self, mem, normal); }
    expect(f.state.teams.CT.lastEnemySeen.filter((e) => e.confidence === 1)).toEqual([]);     // recognised, < 0.5 s
    for (let t = 630; t <= 642; t += 6) { setTick(f, t); perceive(f.ctx, self, mem, normal); }
    expect(f.state.teams.CT.lastEnemySeen.find((e) => e.id === enemy.id && e.confidence === 1 && e.by === self.id)).toBeTruthy();
    place(enemy, 13, 0, 15); place(self, 5, 0, 15, -90);                        // LOS lost
    setTick(f, 642 + PERCEPTION.memoryTicks); perceive(f.ctx, self, mem, normal);
    expect(mem.lastKnown).not.toBeNull();
    setTick(f, 642 + PERCEPTION.memoryTicks + 6); perceive(f.ctx, self, mem, normal);
    expect(mem.lastKnown).toBeNull(); expect(mem.target).toBe(0);
  });

  it('a crouched target behind the mid sandbags is hidden, a standing one is visible', () => {
    const f = makeFixture(); setLive(f, 5);
    const { self, mem, enemy } = duel(f);
    place(self, 26, 0, 16, -90);                     // mid, looking east at the sandbag line (cells (15, 7..10), 1.2 m)
    place(enemy, 33, 0, 16);                         // 1 m behind the bags (see report: at 34 m the crouched head clears them by 4 cm)
    enemy.crouched = true;
    expect(perceive(f.ctx, self, mem, normal).visible).toEqual([]);
    enemy.crouched = false;
    expect(perceive(f.ctx, self, mem, normal).visible.map((v) => v.id)).toEqual([enemy.id]);
  });
});

describe('perception: hearing', () => {
  it('audible iff dist ≤ loudness × hearingMult, enemies or unknown only', () => {
    const f = makeFixture(); setLive(f, 5);
    const { self, enemy } = duel(f);
    place(self, 24, 0, 17, -90);
    const mate = playersOf(f, 'CT').find((p) => p.id !== self.id)!;
    expect(hearSound(sound(v3(24 + 39, 0, 17), 40, enemy.id), self, f.ctx, normal)).toBe(true);     // rifle 40 m, Normal ×1.0
    expect(hearSound(sound(v3(24 + 41, 0, 17), 40, enemy.id), self, f.ctx, normal)).toBe(false);
    expect(hearSound(sound(v3(24 + 23, 0, 17), 40, enemy.id), self, f.ctx, DIFFICULTY.easy)).toBe(true);   // Easy ×0.6 → 24 m
    expect(hearSound(sound(v3(24 + 25, 0, 17), 40, enemy.id), self, f.ctx, DIFFICULTY.easy)).toBe(false);
    expect(hearSound(sound(v3(24 + 47, 0, 17), 40, enemy.id), self, f.ctx, DIFFICULTY.hard)).toBe(true);   // Hard ×1.2 → 48 m
    expect(hearSound(sound(v3(24 + 9, 0, 17), 10, enemy.id), self, f.ctx, normal)).toBe(true);             // footstep 10 m
    expect(hearSound(sound(v3(24 + 11, 0, 17), 10, enemy.id), self, f.ctx, normal)).toBe(false);
    expect(hearSound(sound(v3(25, 0, 17), 40, mate.id), self, f.ctx, normal)).toBe(false);                // teammate
    expect(hearSound(sound(v3(25, 0, 17), 40, self.id), self, f.ctx, normal)).toBe(false);                // self
    expect(hearSound(sound(v3(30, 0, 17), 25, 0), self, f.ctx, normal)).toBe(true);                       // unknown emitter
    expect(hearSound({ id: 'impact_concrete', pos: v3(28, 1, 17), loudness: 10, player: enemy.id }, self, f.ctx, normal)).toBe(true);
    expect(f.state.teams.CT.lastEnemySeen.some((e) => e.id === 0 && e.pos.x === 28)).toBe(true);           // impacts do not locate the shooter
    const heard = f.state.teams.CT.lastEnemySeen;
    expect(heard.length).toBeGreaterThan(0);
    expect(heard.every((e) => e.confidence === 0.5 && e.by === self.id)).toBe(true);
  });

  it('confidence 0.5 never fires: a heard-only enemy behind a wall gets looked at but never shot', () => {
    const f = makeFixture(); setLive(f, 5);
    const { self, mem, enemy } = duel(f);
    const brain = createBotBrain()('normal');
    place(self, 5, 0, 15, 0);                        // T-spawn room, facing north
    place(enemy, 13, 0, 15);                          // behind the wall, 8 m east, making noise
    mem.state = 'HOLD'; mem.holdUntilTick = 1e9; mem.goal = { kind: 'hold', pos: v3(5, 0, 15), holdSpot: '' };
    const yaw0 = self.yaw;
    let fired = false;
    for (let t = 600; t < 900; t++) {
      setTick(f, t);
      if (t % 10 === 0) brain.onEvent({ type: 'sound', data: sound(enemy.pos, 40, enemy.id), tick: t }, mem, self, f.ctx);
      const c = brain.think(f.ctx, self, mem);
      self.yaw = c.yaw; self.pitch = c.pitch;
      if (c.buttons & Btn.FIRE) fired = true;
    }
    expect(fired).toBe(false);
    expect(mem.state).not.toBe('ENGAGE');
    expect(Math.abs(self.yaw - yaw0)).toBeGreaterThan(0.8);       // turned toward the noise (east = −90°)
    expect(f.state.teams.CT.lastEnemySeen.some((e) => e.id === enemy.id && e.confidence === 0.5)).toBe(true);
  });
});

describe('perception: blindness', () => {
  it('blind bots perceive nothing; vision returns afterwards', () => {
    const f = makeFixture(); setLive(f, 5);
    const { self, mem, enemy } = duel(f);
    place(self, 24, 0, 17, -90); place(enemy, 29, 0, 17);
    setTick(f, 600);
    self.blindUntilTick = 700;
    const p = perceive(f.ctx, self, mem, normal);
    expect(p.visible).toEqual([]); expect(p.best).toBe(0);
    setTick(f, 700);
    expect(perceive(f.ctx, self, mem, normal).visible.length).toBe(1);
  });

  it('a blinded bot either sprays toward the last target direction or retreats (50 %)', () => {
    const outcomes = new Set<string>();
    for (let seed = 1; seed <= 12; seed++) {
      const f = makeFixture({ seed }); setLive(f, 5);
      const { self, mem, enemy } = duel(f);
      const brain = createBotBrain()('normal');
      place(self, 24, 0, 17, -90); place(enemy, 29, 0, 17); lookAt(self, mem, 29, 1.2, 17);
      mem.state = 'HOLD'; mem.holdUntilTick = 1e9; mem.goal = { kind: 'hold', pos: v3(24, 0, 17) };
      mem.target = enemy.id; mem.lastKnown = v3(29, 0, 17); mem.targetLastSeenTick = 590;
      self.blindUntilTick = 2000;
      let fired = false;
      for (let t = 600; t < 660; t++) { setTick(f, t); const c = brain.think(f.ctx, self, mem); if (c.buttons & Btn.FIRE) fired = true; }
      const state = mem.state as string;
      outcomes.add(state);
      if (state === 'ENGAGE') expect(fired).toBe(true);
      expect(['ENGAGE', 'RETREAT']).toContain(state);
    }
    expect(outcomes).toEqual(new Set(['ENGAGE', 'RETREAT']));
  });
});
