/** §12.1 world/collision + movement: the §7.8 rule and the §2.1 constants, on synthetic worlds and the real Depot. */
import { describe, it, expect } from 'vitest';
import { movePlayer, MOVE, PLAYER_SHAPE, fallDamage, isWalking, targetSpeed, horizontalSpeed, canStand, eyePos } from '@/world/movement';
import { StaticWorld, type Solid } from '@/world/collision';
import { compileMap, buildStaticWorld } from '@/world/compile';
import { DEPOT } from '@/maps/depot';
import { createPlayer } from '@/sim/entities';
import { Btn, cloneCommand, IDLE_COMMAND, type InputCommand, type WorldState, type PlayerState } from '@/sim/state';
import type { SimEventSink, SimEvents } from '@/sim/events';
import { aabb, v3, DEG, type Aabb, type Vec3 } from '@/core/math';

const EAST = -Math.PI / 2, WEST = Math.PI / 2, NORTH = 0, SOUTH = Math.PI;
const RIFLE = 4.3;

type Ev = { k: keyof SimEvents; e: Record<string, unknown> };
function sink(): SimEventSink & { events: Ev[]; of(k: keyof SimEvents): Record<string, unknown>[] } {
  const events: Ev[] = [];
  return { events, emit(k, e) { events.push({ k, e: e as unknown as Record<string, unknown> }); }, of(k) { return events.filter((x) => x.k === k).map((x) => x.e); } };
}
const cmd = (p: Partial<InputCommand> = {}): InputCommand => ({ ...cloneCommand(IDLE_COMMAND), ...p });
function player(pos: Vec3, yaw: number, opts: Partial<PlayerState> = {}): PlayerState {
  const p = createPlayer(1, 'T', false, 'player', pos, yaw);
  p.grounded = pos.y === 0 || opts.grounded === true;
  return Object.assign(p, opts);
}
interface Run { out: ReturnType<typeof sink>; state: WorldState; trace: { pos: Vec3; vel: Vec3; grounded: boolean; crouched: boolean }[] }
function run(world: StaticWorld, p: PlayerState, ticks: number, c: (t: number) => Partial<InputCommand>, maxSpeed = RIFLE, frozen = false): Run {
  const out = sink(); const state = { pendingDeaths: [] } as unknown as WorldState;
  const trace: Run['trace'] = [];
  for (let t = 0; t < ticks; t++) {
    movePlayer(p, cmd({ yaw: p.yaw, ...c(t) }), world, maxSpeed, frozen, t, state, out);
    trace.push({ pos: { ...p.pos }, vel: { ...p.vel }, grounded: p.grounded, crouched: p.crouched });
  }
  return { out, state, trace };
}
const box = (b: Aabb, surface: Solid['surface'] = 'concrete', kind?: Solid['kind']): Omit<Solid, 'id'> => ({ box: b, surface, penetrable: false, kind });
const flat = (solids: Omit<Solid, 'id'>[] = []) => new StaticWorld(solids, { groundY: 0, bounds: aabb(-60, 0, -60, 60, 120, 60) });
const DEPOT_MAP = compileMap(DEPOT);
const DEPOT_WORLD = buildStaticWorld(DEPOT_MAP);
const bodyBox = (p: PlayerState): Aabb => ({ min: v3(p.pos.x - 0.3, p.pos.y + 1e-3, p.pos.z - 0.3), max: v3(p.pos.x + 0.3, p.pos.y + (p.crouched ? 1.3 : 1.8) - 1e-3, p.pos.z + 0.3) });

describe('§7.8 movement rule: binary speed', () => {
  it('walk = WALK bit or 0 < |move| ≤ 0.75; target speed is 1× or 0.52×, never proportional', () => {
    expect(isWalking({ moveX: 0, moveZ: 1, buttons: 0 })).toBe(false);
    expect(isWalking({ moveX: 0, moveZ: 0.8, buttons: 0 })).toBe(false);
    expect(isWalking({ moveX: 0.45, moveZ: 0.6, buttons: 0 })).toBe(true);    // |move| = 0.75
    expect(isWalking({ moveX: 0, moveZ: 0.3, buttons: 0 })).toBe(true);
    expect(isWalking({ moveX: 0, moveZ: 0, buttons: 0 })).toBe(false);
    expect(isWalking({ moveX: 0, moveZ: 1, buttons: Btn.WALK })).toBe(true);
    expect(targetSpeed({ moveX: 0, moveZ: 1, buttons: 0 }, RIFLE, false)).toBe(4.3);
    expect(targetSpeed({ moveX: 0, moveZ: 0.8, buttons: 0 }, RIFLE, false)).toBe(4.3);
    expect(targetSpeed({ moveX: 0, moveZ: 0.75, buttons: 0 }, RIFLE, false)).toBeCloseTo(0.52 * 4.3, 12);
    expect(targetSpeed({ moveX: 0, moveZ: 0.1, buttons: 0 }, RIFLE, false)).toBeCloseTo(0.52 * 4.3, 12);
    expect(targetSpeed({ moveX: 0, moveZ: 5e-4, buttons: 0 }, RIFLE, false)).toBe(0);
    expect(targetSpeed({ moveX: 0, moveZ: 1, buttons: Btn.WALK }, RIFLE, false)).toBeCloseTo(0.52 * 4.3, 12);
    expect(targetSpeed({ moveX: 0, moveZ: 1, buttons: 0 }, RIFLE, true)).toBeCloseTo(0.5 * 4.3, 12);
    expect(targetSpeed({ moveX: 0, moveZ: 0.5, buttons: 0 }, RIFLE, true)).toBeCloseTo(0.26 * 4.3, 12);
  });
  it('steady-state speeds through movePlayer (stick 1.0 / 0.8 / 0.75 / 0.3 / WALK / diagonal)', () => {
    const speedFor = (c: Partial<InputCommand>) => { const p = player(v3(0, 0, 0), NORTH); run(flat(), p, 60, () => c); return horizontalSpeed(p); };
    expect(speedFor({ moveZ: 1 })).toBeCloseTo(4.3, 9);
    expect(speedFor({ moveZ: 0.8 })).toBeCloseTo(4.3, 9);
    expect(speedFor({ moveZ: 0.75 })).toBeCloseTo(2.236, 9);
    expect(speedFor({ moveZ: 0.3 })).toBeCloseTo(2.236, 9);
    expect(speedFor({ moveZ: 1, buttons: Btn.WALK })).toBeCloseTo(2.236, 9);
    expect(speedFor({ moveX: 0.6, moveZ: 0.8 })).toBeCloseTo(4.3, 9);
    expect(speedFor({ moveX: 1, moveZ: 1 })).toBeCloseTo(4.3, 9);          // normalised direction, never faster diagonally
  });
  it('moves along the view: forward = (−sin yaw, −cos yaw), right = +x at yaw 0', () => {
    const p = player(v3(0, 0, 0), NORTH); run(flat(), p, 30, () => ({ moveZ: 1 }));
    expect(p.pos.z).toBeLessThan(-1); expect(Math.abs(p.pos.x)).toBeLessThan(1e-9);
    const q = player(v3(0, 0, 0), NORTH); run(flat(), q, 30, () => ({ moveX: 1 }));
    expect(q.pos.x).toBeGreaterThan(1); expect(Math.abs(q.pos.z)).toBeLessThan(1e-9);
    const e = player(v3(0, 0, 0), EAST); run(flat(), e, 30, () => ({ moveZ: 1 }));
    expect(e.pos.x).toBeGreaterThan(1);
  });
  it('ground acceleration 40 m/s² toward the target; friction 8 /s when the stick is released', () => {
    const p = player(v3(0, 0, 0), NORTH);
    const r = run(flat(), p, 8, () => ({ moveZ: 1 }));
    expect(Math.hypot(r.trace[0].vel.x, r.trace[0].vel.z)).toBeCloseTo(40 / 60, 9);
    expect(Math.hypot(r.trace[5].vel.x, r.trace[5].vel.z)).toBeCloseTo(4.0, 9);
    expect(Math.hypot(r.trace[6].vel.x, r.trace[6].vel.z)).toBeCloseTo(4.3, 9);   // full speed after 7 ticks ≈ 0.11 s
    const s = run(flat(), p, 60, () => ({}));
    expect(Math.hypot(s.trace[0].vel.x, s.trace[0].vel.z)).toBeCloseTo(4.3 * (1 - 8 / 60), 9);
    expect(horizontalSpeed(p)).toBe(0);
  });
});

describe('crouch', () => {
  it('crouch halves speed (run 2.15, walk 1.118 m/s with a rifle)', () => {
    const p = player(v3(0, 0, 0), NORTH); run(flat(), p, 60, () => ({ moveZ: 1, buttons: Btn.CROUCH }));
    expect(p.crouched).toBe(true); expect(horizontalSpeed(p)).toBeCloseTo(0.5 * 4.3, 9);
    const q = player(v3(0, 0, 0), NORTH); run(flat(), q, 60, () => ({ moveZ: 1, buttons: Btn.CROUCH | Btn.WALK }));
    expect(horizontalSpeed(q)).toBeCloseTo(0.25 * 0.52 * 4.3 * 2, 9);
    expect(eyePos(p).y).toBeCloseTo(1.15); expect(eyePos({ pos: v3(), crouched: false }).y).toBeCloseTo(1.65);
    expect(PLAYER_SHAPE.crouch.height).toBe(1.3); expect(PLAYER_SHAPE.stand.height).toBe(1.8);
  });
  it("can't un-crouch under a 1.4 m clearance; stands up once clear", () => {
    const world = flat([box(aabb(0, 1.4, -5, 10, 2, 5))]);
    const p = player(v3(5, 0, 0), WEST, { crouched: true, wantCrouch: true });
    expect(canStand(p, world)).toBe(false);
    run(world, p, 20, () => ({}));
    expect(p.crouched).toBe(true);
    const r = run(world, p, 240, () => ({ moveZ: 1 }));       // walk west out from under the slab, crouch released
    expect(p.pos.x).toBeLessThan(-0.3);
    expect(p.crouched).toBe(false);
    const firstStand = r.trace.findIndex((s) => !s.crouched);
    expect(r.trace[firstStand].pos.x).toBeLessThanOrEqual(-0.3 + 0.1);
  });
  it('a crouched body passes under 1.4 m, a standing one is stopped', () => {
    const world = flat([box(aabb(0, 1.4, -5, 10, 2, 5))]);
    const s = player(v3(-2, 0, 0), EAST); run(world, s, 90, () => ({ moveZ: 1 }));
    expect(s.pos.x).toBeCloseTo(-0.3, 2);
    const c = player(v3(-2, 0, 0), EAST); run(world, c, 180, () => ({ moveZ: 1, buttons: Btn.CROUCH }));
    expect(c.pos.x).toBeGreaterThan(2);
  });
});

describe('collision response', () => {
  it('wall slide keeps the tangential speed', () => {
    const world = flat([box(aabb(5, 0, -50, 6, 3, 50))]);
    const p = player(v3(3, 0, 0), EAST);
    const r = run(world, p, 90, () => ({ moveZ: 1, moveX: 1 }));    // 45° into a wall whose normal is −x
    expect(p.pos.x).toBeCloseTo(5 - 0.3, 3);
    expect(p.vel.x).toBe(0);
    const tangential = 4.3 * Math.SQRT1_2;
    expect(p.vel.z).toBeCloseTo(tangential, 6);
    const a = r.trace[80].pos.z, b = r.trace[89].pos.z;
    expect((b - a) / (9 / 60)).toBeCloseTo(tangential, 6);
    // moveBody: in the colliding tick the tangential component is untouched
    const hit = world.moveBody(v3(4.69, 0, 0), v3(3, 0, 2), 1 / 60, PLAYER_SHAPE.stand, { wasGrounded: true });
    expect(hit.hitWall).toBe(true); expect(hit.vel.x).toBe(0); expect(hit.vel.z).toBe(2); expect(hit.pos.z).toBeCloseTo(2 / 60, 12);
  });
  it('step-up: 0.5 m ✓, 0.6 m ✗', () => {
    const world = flat([box(aabb(2, 0, -1, 4, 0.5, 1)), box(aabb(2, 0, 4, 4, 0.6, 6))]);
    const a = player(v3(0, 0, 0), EAST); run(world, a, 60, () => ({ moveZ: 1 }));
    expect(a.pos.y).toBeCloseTo(0.5, 6); expect(a.pos.x).toBeGreaterThan(3);
    const b = player(v3(0, 0, 5), EAST); run(world, b, 60, () => ({ moveZ: 1 }));
    expect(b.pos.y).toBe(0); expect(b.pos.x).toBeCloseTo(2 - 0.3, 3);
  });
  it('no tunnelling at 6 m/s (thin 5 cm wall, every sub-tick phase; Depot walls and crates)', () => {
    const world = flat([box(aabb(3, 0, -5, 3.05, 3, 5))]);
    for (let k = 0; k < 40; k++) {
      const p = player(v3((k / 40) * 0.1, 0, 0), EAST);
      run(world, p, 60, () => ({ moveZ: 1 }), 6);
      expect(p.pos.x).toBeLessThanOrEqual(3 - 0.3 + 1e-6);
    }
    for (const [x, z, yaw] of [[25, 5, NORTH], [25, 5, SOUTH], [27, 16, EAST], [20, 17, WEST], [41, 27, SOUTH]] as const) {
      const p = player(v3(x, 0, z), yaw);
      const r = run(DEPOT_WORLD, p, 180, (t) => ({ moveZ: 1, moveX: t % 50 < 25 ? 0.4 : -0.4 }), 6);
      for (const s of r.trace) expect(DEPOT_WORLD.overlaps({ min: v3(s.pos.x - 0.299, s.pos.y + 0.01, s.pos.z - 0.299), max: v3(s.pos.x + 0.299, s.pos.y + 1.79, s.pos.z + 0.299) })).toBe(false);
      expect(p.pos.x).toBeGreaterThan(0); expect(p.pos.x).toBeLessThan(48); expect(p.pos.z).toBeGreaterThan(0); expect(p.pos.z).toBeLessThan(36);
    }
  });
});

describe('ramps on Depot (§3.3)', () => {
  it('climbs the west A ramp (17,2) to the 1.5 m platform', () => {
    const p = player(v3(31, 0, 5), EAST);
    const r = run(DEPOT_WORLD, p, 120, () => ({ moveZ: 1 }));
    expect(p.pos.y).toBeCloseTo(1.5, 6); expect(p.pos.x).toBeGreaterThan(38); expect(p.grounded).toBe(true);
    const ys = [...new Set(r.trace.map((s) => Math.round(s.pos.y * 1000) / 1000))];
    expect(ys).toEqual(expect.arrayContaining([0, 0.375, 0.75, 1.125, 1.5]));
    for (let i = 1; i < r.trace.length; i++) expect(r.trace[i].pos.y).toBeGreaterThanOrEqual(r.trace[i - 1].pos.y - 1e-9);
    expect(r.out.of('land').length).toBe(0);
  });
  it('climbs the back ramp (22,5) northward and walks back down without leaving the ground', () => {
    const p = player(v3(45, 0, 15), NORTH);
    run(DEPOT_WORLD, p, 120, () => ({ moveZ: 1 }));
    expect(p.pos.y).toBeCloseTo(1.5, 6); expect(p.pos.z).toBeLessThan(9.5);
    const q = player(v3(45, 1.5, 8), SOUTH, { grounded: true });
    const r = run(DEPOT_WORLD, q, 120, () => ({ moveZ: 1 }));
    expect(q.pos.y).toBe(0); expect(q.pos.z).toBeGreaterThan(13);
    expect(r.trace.every((s) => s.grounded)).toBe(true);
    expect(r.out.of('land').length).toBe(0);
  });
});

describe('jump (impulse 6.0, gravity 20)', () => {
  it('apex 0.90 ± 0.03 m, airtime 0.6 s, one jump and one land event', () => {
    const p = player(v3(0, 0, 0), NORTH);
    const r = run(flat(), p, 60, (t) => ({ buttons: t === 0 ? Btn.JUMP : 0 }));
    const apex = Math.max(...r.trace.map((s) => s.pos.y));
    expect(Math.abs(apex - 0.9)).toBeLessThan(0.03);
    expect(apex).toBeCloseTo(0.9, 9);                                  // exact integration
    const landed = r.trace.findIndex((s, i) => i > 0 && s.grounded);
    expect(landed).toBe(35);                                           // 36 ticks = 0.6 s
    expect(r.out.of('jump').length).toBe(1);
    const land = r.out.of('land');
    expect(land.length).toBe(1); expect(land[0].impact as number).toBeCloseTo(6, 6);
    const sounds = r.out.of('sound');
    expect(sounds.map((s) => [s.id, s.loudness])).toEqual([['jump', 8], ['land', 10]]);
    expect(p.hp).toBe(100);
  });
  it('no jump while airborne or frozen', () => {
    const p = player(v3(0, 0, 0), NORTH);
    const r = run(flat(), p, 30, () => ({ buttons: Btn.JUMP }), RIFLE, true);
    expect(r.out.of('jump').length).toBe(0); expect(p.pos.y).toBe(0);
    const q = player(v3(0, 0, 0), NORTH);
    const s = run(flat(), q, 30, () => ({ buttons: Btn.JUMP }));
    expect(s.out.of('jump').length).toBe(1);                           // held: no second jump before landing
  });
  it('a standing jump mounts the 1 m crate c at (11,6); walking into it does not', () => {
    const touching = 22.5 - 0.3 - 1e-3;
    const p = player(v3(touching, 0, 13), EAST);
    const r = run(DEPOT_WORLD, p, 60, (t) => (t < 12 ? { moveZ: 1, buttons: t === 0 ? Btn.JUMP : 0 } : {}));
    expect(p.pos.y).toBeCloseTo(1, 6); expect(p.grounded).toBe(true); expect(p.pos.x).toBeGreaterThan(22.2);
    expect(r.trace.findIndex((s) => s.pos.y === 1)).toBe(6);                // on top 0.1 s after take-off (feet ≥ 0.5 m)
    const q = player(v3(20.5, 0, 13), EAST);
    run(DEPOT_WORLD, q, 60, () => ({ moveZ: 1 }));
    expect(q.pos.y).toBe(0); expect(q.pos.x).toBeCloseTo(touching, 2);
    const runUp = player(v3(20.5, 0, 23), EAST);                           // the twin crate at (11,11) with a running jump
    run(DEPOT_WORLD, runUp, 60, (t) => (t < 24 ? { moveZ: 1, buttons: t === 12 ? Btn.JUMP : 0 } : {}));
    expect(runUp.pos.y).toBeCloseTo(1, 6);
  });
  it('the 2 m tall crate X at (18,6) cannot be mounted', () => {
    const p = player(v3(35.6, 0, 13), EAST);
    run(DEPOT_WORLD, p, 90, (t) => ({ moveZ: 1, buttons: t === 0 ? Btn.JUMP : 0 }));
    expect(p.pos.y).toBe(0); expect(p.pos.x).toBeLessThanOrEqual(36 - 0.3 + 1e-3);
  });
  it('a jump off the 1 m crate c at (18,16) never mounts the 2 m tall crate X at (18,14) (§3.3)', () => {
    // the traced exploit: on c, facing north, holding forward, jump on tick 5 → used to land grounded on X at feet 2.0 m
    const p = player(v3(37, 1, 32.4), NORTH, { grounded: true });
    run(DEPOT_WORLD, p, 90, (t) => ({ moveZ: 1, buttons: t === 5 ? Btn.JUMP : 0 }));
    expect(p.pos.y).toBeLessThan(1.5);
    let best = 0;
    for (const speed of [4.3, 5]) for (let z = 32.25; z <= 33.75 + 1e-9; z += 0.25) for (let jt = 0; jt < 20; jt += 2) {
      const q = player(v3(37, 1, z), NORTH, { grounded: true });
      const r = run(DEPOT_WORLD, q, 70, (t) => ({ moveZ: 1, buttons: t === jt ? Btn.JUMP : 0 }), speed);
      for (const s of r.trace) if (s.grounded) best = Math.max(best, s.pos.y);
    }
    expect(best).toBe(1);
  });
  it('an airborne step-up needs standing headroom: no crouch-mantling from an X top onto a 3 m wall under the 4.5 m ceiling', () => {
    const p = player(v3(36.35, 2, 29), WEST, { grounded: true, crouched: true, wantCrouch: true });   // on X (18,14), wall (17,14) to the west
    run(DEPOT_WORLD, p, 90, (t) => ({ moveZ: 1, buttons: Btn.CROUCH | (t === 0 ? Btn.JUMP : 0) }));
    expect(p.pos.y).toBeCloseTo(2, 6); expect(p.pos.x).toBeGreaterThanOrEqual(36.3 - 1e-3);
  });
});

describe('player clip (walls are unclimbable)', () => {
  it('crouch-jumping off the 2.5 m crate on the A platform never lands on the 3 m wall (17,4)', () => {
    let best = 0;
    for (let yawDeg = 0; yawDeg < 360; yawDeg += 15) for (const jt of [2, 6]) for (const crouch of [false, true]) {
      const p = player(v3(36.3, 2.5, 6.5), yawDeg * DEG, { grounded: true });
      const r = run(DEPOT_WORLD, p, 60, (t) => ({ moveZ: 1, buttons: (t === jt ? Btn.JUMP : 0) | (crouch && t >= jt ? Btn.CROUCH : 0) }), 5);
      for (const s of r.trace) if (s.grounded) best = Math.max(best, s.pos.y);
    }
    expect(best).toBe(2.5);
    // the traced exploit: yaw 165°, jump at tick 6, crouched → used to land on the wall corner at y 3.0
    const p = player(v3(36.3, 2.5, 6.5), 165 * DEG, { grounded: true });
    run(DEPOT_WORLD, p, 60, (t) => ({ moveZ: 1, buttons: (t === 6 ? Btn.JUMP : 0) | (t >= 6 ? Btn.CROUCH : 0) }), 5);
    expect(p.pos.y).toBeLessThan(2.6);
  });
  it('rays are not clipped: LOS over a wall top is unchanged', () => {
    expect(DEPOT_WORLD.lineOfSight(v3(35, 3.2, 6), v3(35, 3.2, 11))).toBe(true);   // just above wall (17,4), under the ceiling
    expect(DEPOT_WORLD.lineOfSight(v3(35, 2.8, 6), v3(35, 2.8, 11))).toBe(false);
  });
});

describe('fall damage: max(0, (vImpact − 9) × 10)', () => {
  it('formula', () => {
    expect(fallDamage(10)).toBe(10); expect(fallDamage(9)).toBe(0); expect(fallDamage(5)).toBe(0); expect(fallDamage(9.5)).toBe(5); expect(fallDamage(12)).toBe(30);
  });
  it('a 2.5 m drop lands at 10 m/s and costs 10 HP; a 1.5 m drop is free', () => {
    const p = player(v3(0, 2.5, 0), NORTH);
    const r = run(flat(), p, 60, () => ({}));
    const land = r.out.of('land');
    expect(land.length).toBe(1); expect(land[0].impact as number).toBeCloseTo(10, 6);
    expect(p.hp).toBe(90);
    expect(r.out.of('damageTaken')).toEqual([expect.objectContaining({ victim: 1, amount: 10, hpLeft: 90 })]);
    const q = player(v3(0, 1.5, 0), NORTH);
    const s = run(flat(), q, 60, () => ({}));
    expect(s.out.of('land')[0].impact as number).toBeCloseTo(Math.sqrt(60), 6);
    expect(q.hp).toBe(100);
  });
  it('a lethal fall kills: hp 0, alive false, DeathInfo { weapon: fall, killer: 0 }', () => {
    const p = player(v3(0, 60, 0), NORTH);
    const r = run(flat(), p, 200, () => ({}));
    expect(p.alive).toBe(false); expect(p.hp).toBe(0); expect(p.use.action).toBe('none');
    expect(r.state.pendingDeaths).toEqual([expect.objectContaining({ victim: 1, killer: 0, weapon: 'fall', headshot: false })]);
    expect(p.deathTick).toBe(r.trace.findIndex((s) => s.grounded));
    expect(r.out.of('damageTaken')[0]).toEqual(expect.objectContaining({ hpLeft: 0 }));
  });
});

describe('footsteps (§11.5 sound table)', () => {
  it('running emits a footstep (+ sound, loudness 10) every 1.5 m', () => {
    const p = player(v3(17, 0, 5), EAST);
    const r = run(DEPOT_WORLD, p, 210, () => ({ moveZ: 1 }));
    const steps = r.out.of('footstep');
    const travelled = p.pos.x - 17;
    expect(travelled).toBeGreaterThan(14);
    expect(steps.length).toBe(Math.floor(travelled / 1.5));
    for (let i = 1; i < steps.length; i++) expect(Math.abs((steps[i].pos as Vec3).x - (steps[i - 1].pos as Vec3).x - 1.5)).toBeLessThan(0.08);
    expect((steps[0].pos as Vec3).x - 17).toBeGreaterThanOrEqual(1.5);
    for (const s of steps) { expect(s.surface).toBe('concrete'); expect(s.walking).toBe(false); }
    const sounds = r.out.of('sound');
    expect(sounds.length).toBe(steps.length);
    for (const s of sounds) { expect(s.id).toBe('footstep_concrete'); expect(s.loudness).toBe(10); expect(s.player).toBe(1); }
  });
  it('walking (|move| ≤ 0.75 or WALK) and crouching are silent', () => {
    for (const c of [{ moveZ: 0.5 }, { moveZ: 0.75 }, { moveZ: 1, buttons: Btn.WALK }, { moveZ: 1, buttons: Btn.CROUCH }] as Partial<InputCommand>[]) {
      const p = player(v3(17, 0, 5), EAST);
      const r = run(DEPOT_WORLD, p, 300, () => c);
      expect(p.pos.x - 17).toBeGreaterThan(5);
      expect(r.out.of('footstep').length).toBe(0); expect(r.out.of('sound').length).toBe(0);
    }
  });
  it('the stride restarts when running starts (no burst after walking)', () => {
    const p = player(v3(17, 0, 5), EAST);
    const r = run(DEPOT_WORLD, p, 200, (t) => (t < 150 ? { moveZ: 0.5 } : { moveZ: 1 }));
    const steps = r.out.of('footstep');
    expect(steps.length).toBeGreaterThan(0);
    expect((steps[0].pos as Vec3).x - r.trace[149].pos.x).toBeGreaterThanOrEqual(1.5);   // 1.5 m of running before the first one
    expect(steps.length).toBe(Math.floor((p.pos.x - r.trace[149].pos.x) / 1.5));
  });
  it('surface-mapped: metal on the A platform, wood on a crate floor', () => {
    const q = player(v3(38.5, 1.5, 3), EAST, { grounded: true });
    const s = run(DEPOT_WORLD, q, 60, () => ({ moveZ: 1 }));
    expect(s.out.of('footstep').length).toBeGreaterThan(0);
    for (const f of s.out.of('footstep')) expect(f.surface).toBe('metal');
    const wood = flat([box(aabb(-20, 0, -20, 20, 0.5, 20), 'wood')]);
    const w = player(v3(0, 0.5, 0), NORTH, { grounded: true });
    const t = run(wood, w, 90, () => ({ moveZ: 1 }));
    expect(t.out.of('footstep').length).toBeGreaterThan(2);
    for (const f of t.out.of('sound')) expect(f.id).toBe('footstep_wood');
  });
});

describe('look, freeze, death', () => {
  it('frozen: look and crouch work, no horizontal motion or jump', () => {
    const p = player(v3(0, 0, 0), NORTH);
    run(flat(), p, 30, () => ({ moveZ: 1, yaw: 1.2, pitch: 0.3, buttons: Btn.JUMP | Btn.CROUCH }), RIFLE, true);
    expect(p.pos).toEqual({ x: 0, y: 0, z: 0 }); expect(p.yaw).toBe(1.2); expect(p.pitch).toBe(0.3); expect(p.crouched).toBe(true);
  });
  it('pitch is clamped to ±89°', () => {
    const p = player(v3(0, 0, 0), NORTH);
    run(flat(), p, 1, () => ({ pitch: 2 }));
    expect(p.pitch).toBeCloseTo(89 * DEG, 12);
    run(flat(), p, 1, () => ({ pitch: -2 }));
    expect(p.pitch).toBeCloseTo(-89 * DEG, 12);
  });
  it('dead players only turn their view', () => {
    const p = player(v3(0, 0, 0), NORTH, { alive: false });
    const r = run(flat(), p, 30, () => ({ moveZ: 1, yaw: 0.5, buttons: Btn.JUMP }));
    expect(p.pos).toEqual({ x: 0, y: 0, z: 0 }); expect(p.yaw).toBe(0.5); expect(r.out.events.length).toBe(0);
  });
  it('legPhase advances 2π per 1.5 m stride and distanceWalked accumulates', () => {
    const p = player(v3(0, 0, 0), NORTH);
    run(flat(), p, 120, () => ({ moveZ: 1 }));
    expect(p.distanceWalked).toBeCloseTo(-p.pos.z, 9);
    expect(p.legPhase).toBeGreaterThanOrEqual(0); expect(p.legPhase).toBeLessThan(2 * Math.PI);
    expect(MOVE.strideM).toBe(1.5);
  });
});
