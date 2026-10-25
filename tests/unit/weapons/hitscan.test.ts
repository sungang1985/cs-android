/** §12.1 weapons/hitscan + damage: damage table, armour, hitboxes, penetration, ordering, friendly fire, near misses. */
import { describe, it, expect } from 'vitest';
import { v3, aabb, DEG, v3norm, v3sub, type Vec3 } from '@/core/math';
import { Btn, type PlayerState } from '@/sim/state';
import { WEAPONS } from '@/weapons/defs';
import { computeDamage, applyDamage, zoneArmored } from '@/weapons/damage';
import { resolveHitscan, hitboxesFor, headPoint, chestPoint, rayVsPlayer } from '@/weapons/hitscan';
import { compileMap, buildStaticWorld } from '@/world/compile';
import { DEPOT } from '@/maps/depot';
import { recorder, makeState, player, openWorld, solid, cmd, stepWeapon, give, rngs } from './helpers';

const EAST = -90 * DEG;
const dirTo = (a: Vec3, b: Vec3) => v3norm(v3sub(b, a));
const eye = (p: PlayerState) => v3(p.pos.x, p.pos.y + 1.65, p.pos.z);
const src = (attacker: number, weapon: 'ak47' | 'deagle' | 'awp' = 'ak47') => ({ attacker, weapon, headshot: false, dir: v3(1, 0, 0), point: v3() });

describe('damage (§4.1)', () => {
  it('AK head + helmet at 10 m kills; AK body at 30 m = 34; Deagle head + helmet = 197', () => {
    const v = player(2, 'CT', v3(10, 0, 0)); v.armor = 100; v.helmet = true;
    const state = makeState([v]); const out = recorder(state);
    const d = computeDamage(WEAPONS.ak47, 10, 'head');
    expect(d).toBe(141);
    const r = applyDamage(v, d, 'head', WEAPONS.ak47.ap, src(1), state, out);
    expect(r.killed).toBe(true); expect(r.dealt).toBe(109);
    expect(state.pendingDeaths).toHaveLength(1);
    expect(computeDamage(WEAPONS.ak47, 30, 'chest')).toBe(34);
    const w = player(3, 'CT', v3()); w.armor = 100; w.helmet = true; const st = makeState([w]);
    expect(applyDamage(w, computeDamage(WEAPONS.deagle, 0, 'head'), 'head', WEAPONS.deagle.ap, src(1, 'deagle'), st, recorder()).dealt).toBe(197);
  });
  it('legs ignore armour; head is armoured only with a helmet; AWP legs = 85 fixed', () => {
    const v = player(2, 'CT', v3()); v.armor = 100; v.helmet = true;
    const state = makeState([v]);
    expect(zoneArmored(v, 'legs')).toBe(false);
    const r = applyDamage(v, computeDamage(WEAPONS.ak47, 0, 'legs'), 'legs', 0.77, src(1), state, recorder());
    expect(r.dealt).toBe(27); expect(v.armor).toBe(100);
    v.helmet = false; expect(zoneArmored(v, 'head')).toBe(false); expect(zoneArmored(v, 'chest')).toBe(true);
    expect(computeDamage(WEAPONS.awp, 0, 'legs')).toBe(85); expect(computeDamage(WEAPONS.awp, 50, 'legs')).toBe(85);
    // chest armour: armour loses ceil(d·(1−AP)·0.5), hp loses round(d·AP)
    const k = player(4, 'CT', v3()); k.armor = 100; const st = makeState([k]);
    const a = applyDamage(k, 36, 'chest', 0.77, src(1), st, recorder());
    expect(a.dealt).toBe(28); expect(a.armorDealt).toBe(5); expect(k.armor).toBe(95);
  });
  it('spawn protection (invulnerableUntilTick > tick) blocks all damage', () => {
    const v = player(2, 'CT', v3()); const state = makeState([v]); v.invulnerableUntilTick = state.tick + 1;
    const out = recorder();
    expect(applyDamage(v, 500, 'head', 1, src(1), state, out)).toEqual({ dealt: 0, armorDealt: 0, killed: false });
    expect(v.hp).toBe(100); expect(out.events).toHaveLength(0);
  });
});

describe('hitboxes (§4.4)', () => {
  it('head sphere at 1.60 / 1.10 crouched; chest = upper 55 % of the torso, stomach below, legs 0–0.9', () => {
    const p = player(2, 'CT', v3(0, 0, 0));
    const hb = hitboxesFor(p);
    expect(hb.head.center.y).toBeCloseTo(1.6); expect(hb.head.radius).toBeCloseTo(0.16);
    const chest = hb.boxes.find((b) => b.zone === 'chest')!, stomach = hb.boxes.find((b) => b.zone === 'stomach')!, legs = hb.boxes.find((b) => b.zone === 'legs')!;
    expect(chest.max.y).toBeCloseTo(1.5); expect(chest.min.y).toBeCloseTo(1.5 - 0.6 * 0.55); expect(stomach.min.y).toBeCloseTo(0.9); expect(legs.max.y).toBeCloseTo(0.9);
    expect(chest.max.x - chest.min.x).toBeCloseTo(0.5); expect(chest.max.z - chest.min.z).toBeCloseTo(0.3);
    p.crouched = true;
    const hc = hitboxesFor(p);
    expect(hc.head.center.y).toBeCloseTo(1.1); expect(hc.boxes.find((b) => b.zone === 'legs')!.max.y).toBeCloseTo(0.6);
    expect(hc.boxes.find((b) => b.zone === 'chest')!.max.y).toBeCloseTo(1.1);
  });
  it('zones by height and the yaw-local frame (0.5 m wide, 0.3 m deep)', () => {
    const v = player(2, 'CT', v3(10, 0, 0), 90 * DEG); // faces west, toward a shooter at x = 0: width spans z
    const o = v3(0, 0, 0);
    const zoneAt = (y: number, z = 0) => rayVsPlayer(v3(o.x, y, z), v3(1, 0, 0), v, 50)?.zone ?? null;
    expect(zoneAt(1.6)).toBe('head'); expect(zoneAt(1.4)).toBe('chest'); expect(zoneAt(1.0)).toBe('stomach'); expect(zoneAt(0.5)).toBe('legs');
    expect(zoneAt(1.3, 0.2)).toBe('chest'); // inside the 0.25 half-width
    v.yaw = 0; // side-on: only the 0.15 half-depth faces the shooter
    expect(zoneAt(1.3, 0.2)).toBeNull();
    const h = rayVsPlayer(v3(0, 1.3, 0), v3(1, 0, 0), v, 50)!;
    expect(h.t).toBeCloseTo(10 - 0.25, 6); // yaw 0: local x (half 0.25) lies along world x
    expect(h.normal.x).toBeCloseTo(-1, 6);
  });
});

describe('resolveHitscan', () => {
  const shooter = () => player(1, 'T', v3(0, 0, 0), EAST);
  it('nearest player first; teammates ignored; dead skipped; max range 200 m', () => {
    const s = shooter();
    const near = player(2, 'CT', v3(8, 0, 0)), far = player(3, 'CT', v3(16, 0, 0)), mate = player(4, 'T', v3(4, 0, 0));
    const world = openWorld();
    const hits = resolveHitscan(eye(s), dirTo(eye(s), headPoint(far)), s, [s, near, far, mate], [], world, WEAPONS.ak47);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ kind: 'player', id: 2, penetrated: false, damageScale: 1 });
    near.alive = false;
    expect(resolveHitscan(eye(s), dirTo(eye(s), headPoint(far)), s, [s, near, far, mate], [], world, WEAPONS.ak47)[0]).toMatchObject({ id: 3, zone: 'head' });
    const lone = player(5, 'CT', v3(210, 0, 0));
    expect(resolveHitscan(eye(s), v3(1, 0, 0), s, [s, lone], [], openWorld(), WEAPONS.ak47)).toHaveLength(0);
  });
  it('low crate ×0.6 (Deagle ×0.5), wall none, tall crate only for the AWP ×0.4', () => {
    const s = shooter(); const v = player(2, 'CT', v3(10, 0, 0), 90 * DEG);
    const aim = (world: ReturnType<typeof openWorld>, def = WEAPONS.ak47) => resolveHitscan(eye(s), dirTo(eye(s), chestPoint(v)), s, [s, v], [], world, def);
    const crate = openWorld([solid(aabb(4, 0, -1, 5, 2.5, 1), 'lowcrate', true, 0.6)]);
    const h = aim(crate);
    expect(h.map((x) => x.kind)).toEqual(['solid', 'player']);
    expect(h[0]).toMatchObject({ penetrated: false, damageScale: 1, surface: 'wood' });
    expect(h[1]).toMatchObject({ penetrated: true, damageScale: 0.6, id: 2 });
    expect(aim(crate, WEAPONS.deagle)[1].damageScale).toBe(0.5);
    expect(aim(crate, WEAPONS.glock).map((x) => x.kind)).toEqual(['solid']); // no Pen factor
    expect(aim(openWorld([solid(aabb(4, 0, -1, 6, 2.5, 1), 'lowcrate', true, 0.6)])).map((x) => x.kind)).toEqual(['solid']); // 2 m thick
    expect(aim(openWorld([solid(aabb(4, 0, -1, 4.2, 2.5, 1), 'wall', false, 0, 'concrete')]), WEAPONS.awp).map((x) => x.kind)).toEqual(['solid']);
    expect(aim(openWorld([solid(aabb(4, 0, -1, 4.2, 2.5, 1), 'lintel', true, 0.6, 'concrete')]), WEAPONS.awp).map((x) => x.kind)).toEqual(['solid']);
    const tall = openWorld([solid(aabb(4, 0, -1, 6, 2.5, 1), 'tallcrate', true, 0.4)]);
    expect(aim(tall).map((x) => x.kind)).toEqual(['solid']);
    expect(aim(tall, WEAPONS.awp)[1]).toMatchObject({ kind: 'player', penetrated: true, damageScale: 0.4 });
    // at most one penetration
    const two = openWorld([solid(aabb(3, 0, -1, 3.5, 2.5, 1), 'lowcrate', true, 0.6), solid(aabb(6, 0, -1, 6.5, 2.5, 1), 'lowcrate', true, 0.6)]);
    expect(aim(two).map((x) => `${x.kind}:${x.penetrated}`)).toEqual(['solid:false', 'solid:true']);
  });
  it('Depot: AWP wallbangs a tall crate X, the AK cannot; walls stop both', () => {
    const map = compileMap(DEPOT); const world = buildStaticWorld(map);
    const x = map.solids.findIndex((sd) => sd.kind === 'tallcrate' && sd.box.min.x === 28 && sd.box.min.z === 8);
    expect(x).toBeGreaterThanOrEqual(0); // the X at cell (14, 4) between Long and Mid
    const s = player(1, 'T', v3(29, 0, 11.5), 0); const v = player(2, 'CT', v3(29, 0, 7), 180 * DEG);
    const d = dirTo(eye(s), chestPoint(v));
    expect(resolveHitscan(eye(s), d, s, [s, v], [], world, WEAPONS.ak47).map((h) => h.kind)).toEqual(['solid']);
    const awp = resolveHitscan(eye(s), d, s, [s, v], [], world, WEAPONS.awp);
    expect(awp.map((h) => h.kind)).toEqual(['solid', 'player']);
    expect(awp[1].damageScale).toBe(0.4);
  });
  it('training targets: hit only while up', () => {
    const s = shooter(); const tg = { id: 50, pos: v3(6, 0, 0), up: true, downUntilTick: 0 };
    const h = resolveHitscan(eye(s), v3(1, 0, 0), s, [s], [tg], openWorld(), WEAPONS.ak47);
    expect(h[0]).toMatchObject({ kind: 'target', id: 50, zone: null });
    expect(h[0].t).toBeCloseTo(6 - 0.25);
    tg.up = false;
    expect(resolveHitscan(eye(s), v3(1, 0, 0), s, [s], [tg], openWorld(), WEAPONS.ak47)).toHaveLength(0);
  });
});

describe('shots through tickWeapon', () => {
  it('a hit applies zone damage, emits hit/damageTaken, counts stats; targets drop for 120 ticks', () => {
    const s = player(1, 'T', v3(0, 0, 0), EAST); give(s, 'ak47'); s.crouched = true; s.pitch = Math.atan2(1.3 - 1.15, 10);
    const v = player(2, 'CT', v3(10, 0, 0), 90 * DEG);
    const state = makeState([s, v]); const out = recorder(state);
    stepWeapon(s, cmd(s, Btn.FIRE), state, openWorld(), rngs(), out);
    const hit = out.of('hit')[0], shot = out.of('shot')[0];
    expect(hit).toMatchObject({ attacker: 1, victim: 2, weapon: 'ak47', zone: 'chest', armored: false });
    const dist = Math.hypot(hit.point.x - shot.origin.x, hit.point.y - shot.origin.y, hit.point.z - shot.origin.z);
    expect(hit.damage).toBe(computeDamage(WEAPONS.ak47, dist, 'chest'));
    expect(v.hp).toBe(100 - hit.damage);
    expect(out.of('damageTaken')[0]).toMatchObject({ victim: 2, amount: hit.damage });
    expect(shot.hitPlayer).toBe(2); expect(shot.end).toEqual(hit.point);
    expect(s.stats).toMatchObject({ shots: 1, hits: 1, damage: hit.damage });
    // target
    const t = player(1, 'T', v3(0, 0, 0), EAST); give(t, 'ak47'); t.crouched = true;
    const ts = makeState([t]); ts.targets.push({ id: 60, pos: v3(8, 0, 0), up: true, downUntilTick: 0 });
    const to = recorder(ts);
    stepWeapon(t, cmd(t, Btn.FIRE), ts, openWorld(), rngs(), to);
    expect(to.of('targetHit')).toEqual([{ id: 60 }]);
    expect(ts.targets[0]).toMatchObject({ up: false, downUntilTick: ts.tick - 1 + 120 });
    expect(t.stats.hits).toBe(1);
  });
  it('nearMiss + bullet_whiz when the ray passes < 1.5 m from an enemy head; not at 2 m; not teammates', () => {
    for (const [offset, team, expected] of [[1.0, 'CT', 1], [2.0, 'CT', 0], [1.0, 'T', 0]] as const) {
      const s = player(1, 'T', v3(0, 0, 0), EAST); give(s, 'ak47'); s.crouched = true; s.pitch = Math.atan2(1.6 - 1.15, 10);
      const e = player(2, team, v3(10, 0, offset));
      const state = makeState([s, e]); const out = recorder(state);
      stepWeapon(s, cmd(s, Btn.FIRE), state, openWorld(), rngs(), out);
      expect(out.of('nearMiss').length, `offset ${offset} ${team}`).toBe(expected);
      if (expected) {
        expect(out.of('nearMiss')[0].listener).toBe(2);
        expect(out.of('sound').find((x) => x.id === 'bullet_whiz')!.loudness).toBe(5);
      }
    }
  });
  it('friendly fire is off: a teammate in the line of fire is shot through', () => {
    const s = player(1, 'T', v3(0, 0, 0), EAST); give(s, 'ak47'); s.crouched = true; s.pitch = Math.atan2(1.3 - 1.15, 10);
    const mate = player(2, 'T', v3(5, 0, 0)); const enemy = player(3, 'CT', v3(10, 0, 0));
    const state = makeState([s, mate, enemy]); const out = recorder(state);
    stepWeapon(s, cmd(s, Btn.FIRE), state, openWorld(), rngs(), out);
    expect(mate.hp).toBe(100); expect(enemy.hp).toBeLessThan(100);
  });
});

