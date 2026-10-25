/** §12.1 weapons/grenade + the §4.4 throw protocol. */
import { describe, it, expect } from 'vitest';
import { v3, aabb, DEG, type Vec3 } from '@/core/math';
import { Btn, type GrenadeState, type WorldState } from '@/sim/state';
import { GRENADE } from '@/weapons/defs';
import { stepGrenades, resolveHE, resolveFlash, flashSeconds, heDamageAt, integrateGrenade, launchGrenade, predictGrenade } from '@/weapons/grenade';
import { activeWeaponId } from '@/weapons/inventory';
import { recorder, makeState, player, openWorld, solid, cmd, stepWeapon, give, rngs } from './helpers';

const EAST = -90 * DEG;
function nade(state: WorldState, pos: Vec3, vel: Vec3, kind: 'he' | 'flash' = 'he', owner = 1, fuse = 1000): GrenadeState {
  const g: GrenadeState = { id: state.nextId++, kind, owner, team: 'T', pos: { ...pos }, prevPos: { ...pos }, vel: { ...vel }, explodeTick: state.tick + fuse, bounces: 0 };
  state.grenades.push(g); return g;
}
function run(state: WorldState, world: ReturnType<typeof openWorld>, out: ReturnType<typeof recorder>, ticks: number, each?: () => void) {
  for (let i = 0; i < ticks; i++) { stepGrenades(state, world, out); state.pendingDeaths.length = 0; state.tick++; each?.(); }
}

describe('grenade physics', () => {
  it('bounce restitution 0.45 on the floor (apex ≈ 0.45² · drop height) with a bounce event + he_bounce 15', () => {
    const state = makeState([player(1, 'T', v3())]); const world = openWorld(); const out = recorder(state);
    const g = nade(state, v3(0, 3, 0), v3());
    let apexAfter = 0, bounced = false;
    run(state, world, out, 150, () => { if (out.of('grenadeBounce').length === 1) { bounced = true; apexAfter = Math.max(apexAfter, g.pos.y - GRENADE.radius); } });
    expect(bounced).toBe(true);
    const drop = 3 - GRENADE.radius;
    expect(apexAfter / drop).toBeGreaterThan(0.2025 * 0.85); expect(apexAfter / drop).toBeLessThan(0.2025 * 1.15);
    expect(out.of('sound').find((s) => s.id === 'he_bounce')!.loudness).toBe(15);
    expect(out.of('grenadeBounce')[0].surface).toBe('concrete');
    // comes to rest on the ground
    expect(g.pos.y).toBeCloseTo(GRENADE.radius, 3); expect(Math.hypot(g.vel.x, g.vel.y, g.vel.z)).toBeLessThan(0.05);
  });
  it('wall bounce: normal × −0.45, tangential × 0.7; no tunnelling through a thin wall at 12+ m/s (sub-steps)', () => {
    const world = openWorld([solid(aabb(2, 0, -5, 2.1, 4, 5), 'wall', false, 0, 'metal')]);
    const g = { pos: v3(1.5, 2, 0), vel: v3(15, 0, 3), prevPos: v3() };
    let hitTick = -1;
    for (let i = 0; i < 30; i++) { const vx = g.vel.x; integrateGrenade(g, world, () => { if (hitTick < 0) hitTick = i; }); if (hitTick === i) { expect(g.vel.x).toBeCloseTo(-vx * 0.45, 1); break; } }
    expect(hitTick).toBeGreaterThanOrEqual(0);
    expect(g.vel.z).toBeCloseTo(3 * 0.7, 1);
    for (let i = 0; i < 60; i++) integrateGrenade(g, world);
    expect(g.pos.x).toBeLessThan(2 - GRENADE.radius + 1e-6);
  });
  it('players are ignored; predictGrenade matches the stepped path', () => {
    const p = player(2, 'CT', v3(3, 0, 0));
    const state = makeState([player(1, 'T', v3()), p]); const world = openWorld(); const out = recorder(state);
    const g = nade(state, v3(0, 2, 0), v3(15, 0, 0));
    const path = predictGrenade(world, g.pos, g.vel, 20);
    run(state, world, out, 20);
    expect(g.pos.x).toBeGreaterThan(3.5);
    expect(g.pos).toEqual(path[19]);
  });
  it('fuse: HE explodes exactly 2.0 s after release, flash 1.5 s; events + sounds loudness 60; removed', () => {
    const thrower = player(1, 'T', v3(), EAST);
    const state = makeState([thrower]); const world = openWorld(); const out = recorder(state);
    const t0 = state.tick;
    launchGrenade(state, thrower, 'he', 12, out); launchGrenade(state, thrower, 'flash', 12, out);
    expect(out.of('grenadeThrow')).toHaveLength(2);
    expect(out.of('sound').filter((s) => s.id === 'he_pin').every((s) => s.loudness === 5)).toBe(true);
    run(state, world, out, 200);
    const ex = out.events.filter((e) => e.type === 'grenadeExplode');
    expect(ex.map((e) => [(e.data as { kind: string }).kind, e.tick - t0])).toEqual([['flash', 90], ['he', 120]]);
    expect(out.of('sound').filter((s) => s.id === 'he_explode' || s.id === 'flash_explode').map((s) => s.loudness)).toEqual([60, 60]);
    expect(state.grenades).toHaveLength(0);
  });
});

describe('HE (§4.4)', () => {
  it('98 → 0 linear over 3.5 m (distance to the body)', () => {
    expect(heDamageAt(0)).toBe(98); expect(heDamageAt(1.75)).toBe(49); expect(heDamageAt(3.5)).toBe(0); expect(heDamageAt(5)).toBe(0);
    const thrower = player(1, 'T', v3(-50, 0, 0));
    const at = (d: number) => resolveHE(v3(0.3 + d, 1.2, 0), thrower, [thrower, player(2, 'CT', v3(0, 0, 0))], openWorld())[0]?.damage ?? 0;
    expect(at(0)).toBe(98); expect(at(1)).toBe(70); expect(at(2.5)).toBe(28); expect(at(3.6)).toBe(0);
  });
  it('LOS from the burst to chest or head is required', () => {
    const thrower = player(1, 'T', v3(-50, 0, 0)); const v = player(2, 'CT', v3(0, 0, 0));
    const wall = openWorld([solid(aabb(0.5, 0, -3, 0.7, 4, 3), 'wall')]);
    expect(resolveHE(v3(1.5, 1.2, 0), thrower, [thrower, v], wall)).toEqual([]);
    const low = openWorld([solid(aabb(0.5, 0, -3, 0.7, 1.0, 3), 'lowcrate', true, 0.6)]); // head visible over a low wall
    expect(resolveHE(v3(1.5, 0.5, 0), thrower, [thrower, v], low)[0].victim).toBe(2);
  });
  it('self-damage on, teammates off; damage through applyDamage with AP 0.5 and hit events', () => {
    const thrower = player(1, 'T', v3(0, 0, 0)); const mate = player(2, 'T', v3(1, 0, 0)); const enemy = player(3, 'CT', v3(-1, 0, 0)); enemy.armor = 100;
    const state = makeState([thrower, mate, enemy]); const world = openWorld(); const out = recorder(state);
    const r = resolveHE(v3(0, 0.1, 0.5), thrower, state.players, world);
    expect(r.map((x) => x.victim)).toEqual([1, 3]);
    nade(state, v3(0, 0.07, 0.5), v3(), 'he', 1, 1);
    run(state, world, out, 2);
    expect(mate.hp).toBe(100);
    expect(thrower.hp).toBeLessThan(100);
    expect(enemy.armor).toBeLessThan(100);
    const hits = out.of('hit');
    expect(hits.map((h) => h.victim)).toEqual([1, 3]);
    expect(hits.every((h) => h.weapon === 'he' && h.zone === 'chest')).toBe(true);
    expect(thrower.stats.damage).toBe(hits[1].damage);
  });
});

describe('flash (§4.4)', () => {
  it('seconds vs angle and distance table', () => {
    const c = (deg: number) => Math.cos(deg * DEG);
    expect(flashSeconds(5, c(0))).toBeCloseTo(2.25, 6);
    expect(flashSeconds(5, c(30))).toBeCloseTo(3 * Math.pow(c(30), 0.7) * 0.75, 6);
    expect(flashSeconds(5, c(60))).toBeCloseTo(3 * Math.pow(0.5, 0.7) * 0.75, 6);
    expect(flashSeconds(5, c(90))).toBeCloseTo(0, 6);
    expect(flashSeconds(5, c(180))).toBe(0);
    expect(flashSeconds(0, 1)).toBeCloseTo(3); expect(flashSeconds(18, 1)).toBeCloseTo(0.75); expect(flashSeconds(21, 1)).toBe(0);
  });
  it('blinds both teams (incl. the thrower) with LOS, sets blindUntilTick, emits blinded', () => {
    const t = player(1, 'T', v3(0, 0, 0), EAST); const mate = player(2, 'T', v3(0, 0, 2), EAST); const away = player(3, 'CT', v3(0, 0, -2), 90 * DEG);
    const hidden = player(4, 'CT', v3(10, 0, 8), 180 * DEG);
    const world = openWorld([solid(aabb(9, 0, 6, 11, 4, 6.5), 'wall')]);
    const center = v3(5, 1.65, 0);
    const r = resolveFlash(center, [t, mate, away, hidden], world);
    expect(r.map((x) => x.victim)).toEqual([1, 2]);
    expect(r[0].seconds).toBeCloseTo(flashSeconds(5, 1), 6);
    const state = makeState([t, mate, away, hidden]); const out = recorder(state);
    nade(state, center, v3(), 'flash', 1, 1);
    const tick = state.tick;
    run(state, world, out, 2);
    expect(out.of('blinded').map((b) => b.player)).toEqual([1, 2]);
    expect(t.blindUntilTick).toBe(tick + 1 + Math.round(r[0].seconds * 60));
  });
});

describe('throw protocol (§4.4)', () => {
  function setup(he = 1, flash = 0) {
    const p = player(1, 'T', v3(0, 0, 0), EAST); give(p, 'ak47'); p.inv.he = he; p.inv.flash = flash;
    const state = makeState([p]); const world = openWorld(); const out = recorder(state); const rng = rngs();
    const step = (b: number, extra = {}) => { stepWeapon(p, cmd(p, b, extra), state, world, rng, out); stepGrenades(state, world, out); };
    return { p, state, world, out, rng, step };
  }
  const speedOf = (g: GrenadeState) => Math.hypot(g.vel.x, g.vel.y + GRENADE.gravity / 60, g.vel.z);
  it('tap from any slot: switch to 4 (0.25 s), release at 12 m/s +10°, return to the slot 30 ticks later', () => {
    const { p, state, out, step } = setup();
    const t0 = state.tick;
    step(Btn.THROW);
    expect(p.inv.active).toBe(4); expect(p.throwing).toEqual({ startTick: t0, returnSlot: 1 });
    expect(out.of('weaponSwitch')[0].weapon).toBe('he');
    for (let i = 0; i < 14; i++) step(0);
    expect(out.of('grenadeThrow')).toHaveLength(0);
    step(0);
    const thr = out.events.find((e) => e.type === 'grenadeThrow')!;
    expect(thr.tick - t0).toBe(15);
    expect(p.inv.he).toBe(0); expect(p.throwing).toBeNull();
    const g = state.grenades[0];
    expect(g.owner).toBe(1); expect(g.kind).toBe('he'); expect(g.explodeTick).toBe(thr.tick + 120);
    // one integration tick has run (gravity 20 m/s² · DT on vy): undo it to read the release velocity
    const vy0 = g.vel.y + GRENADE.gravity / 60;
    expect(Math.hypot(g.vel.x, vy0, g.vel.z)).toBeCloseTo(12, 6); expect(Math.atan2(vy0, Math.hypot(g.vel.x, g.vel.z)) / DEG).toBeCloseTo(10, 6);
    expect(g.vel.x).toBeGreaterThan(0); // thrown along the view (east)
    expect(out.of('sound').some((s) => s.id === 'he_pin')).toBe(true);
    for (let i = 0; i < 29; i++) step(0);
    expect(p.inv.active).toBe(4);
    step(0);
    expect(p.inv.active).toBe(1); expect(activeWeaponId(p)).toBe('ak47');
  });
  it('held ≥ 18 ticks → short toss 7 m/s; > 3 s forces the release', () => {
    const a = setup();
    for (let i = 0; i < 20; i++) a.step(Btn.THROW);
    a.step(0);
    expect(a.out.of('grenadeThrow')).toHaveLength(1);
    expect(speedOf(a.state.grenades[0])).toBeLessThan(7.2);
    const b = setup();
    for (let i = 0; i < 200; i++) b.step(Btn.THROW);
    const thr = b.out.events.find((e) => e.type === 'grenadeThrow')!;
    expect(thr.tick - (b.state.tick - 200)).toBe(180);
    expect(b.out.of('grenadeThrow')).toHaveLength(1); // still held: no second throw without a new press
  });
  it('FIRE on slot 4 is THROW; the other grenade is used when the selected one is not owned; cmd.grenade selects', () => {
    const { p, out, step } = setup(0, 2);
    step(0, { slot: 4 });
    expect(activeWeaponId(p)).toBe('flash'); expect(p.inv.selectedGrenade).toBe('flash');
    for (let i = 0; i < 30; i++) step(0);
    step(Btn.FIRE); step(0);
    expect(out.of('grenadeThrow')[0].kind).toBe('flash'); expect(p.inv.flash).toBe(1);
    expect(out.of('shot')).toHaveLength(0);
    for (let i = 0; i < 31; i++) step(0);
    expect(p.inv.active).toBe(4); // returned to slot 4 (flash left)
    step(0, { grenade: 1 });
    expect(p.inv.selectedGrenade).toBe('he'); expect(activeWeaponId(p)).toBe('flash');
  });
  it('no grenade → THROW does nothing; a slot requested while holding replaces the return slot', () => {
    const none = setup(0, 0);
    none.step(Btn.THROW);
    expect(none.p.throwing).toBeNull(); expect(none.p.inv.active).toBe(1);
    const { p, step } = setup();
    step(Btn.THROW); step(Btn.THROW, { slot: 3 });
    for (let i = 0; i < 20; i++) step(0);
    for (let i = 0; i < 30; i++) step(0);
    expect(p.inv.active).toBe(3);
  });
});

