/** §12.1 weapons/fire: spread, heat, patterns, recoil, cone sampling, trigger semantics, reload, switch, AWP, knife. */
import { describe, it, expect } from 'vitest';
import { v3, DEG, dirFromYawPitch, v3dot } from '@/core/math';
import { Rng } from '@/core/rng';
import { Btn } from '@/sim/state';
import { WEAPONS } from '@/weapons/defs';
import { computeSpread, recoverRecoil, sampleShotDir, cycleTicks, isBackstab } from '@/weapons/fire';
import { activeWeaponId } from '@/weapons/inventory';
import { recorder, makeState, player, openWorld, cmd, stepWeapon, give, rngs } from './helpers';

const YAW_EAST = -90 * DEG; // forward = +x

describe('spread (§4.2)', () => {
  it('crouch < stand < move, airborne ×4, heat adds perShot', () => {
    const def = WEAPONS.ak47;
    const base = { vel: v3(), crouched: false, grounded: true, heat: 0, scoped: 0 as const };
    const stand = computeSpread(def, base), crouch = computeSpread(def, { ...base, crouched: true }), move = computeSpread(def, { ...base, vel: v3(def.speed, 0, 0) });
    expect(crouch).toBeCloseTo(0.55); expect(stand).toBeCloseTo(0.8); expect(move).toBeCloseTo(5.5);
    expect(crouch).toBeLessThan(stand); expect(stand).toBeLessThan(move);
    expect(computeSpread(def, { ...base, grounded: false })).toBeCloseTo(0.8 * 4);
    expect(computeSpread(def, { ...base, heat: 3 })).toBeCloseTo(0.8 + 3 * 0.45);
    expect(computeSpread(WEAPONS.awp, { ...base, scoped: 1 })).toBeCloseTo(0.05);
    expect(computeSpread(WEAPONS.awp, { ...base, scoped: 1, crouched: true })).toBeCloseTo(0.04);
    expect(computeSpread(WEAPONS.awp, base)).toBeCloseTo(8);
  });
  it('heat decays at heatRecover per second', () => {
    const p = player(1, 'T', v3());
    p.heat = 10;
    for (let i = 0; i < 60; i++) recoverRecoil(p, WEAPONS.ak47);
    expect(p.heat).toBeCloseTo(10 - 6, 6);
    for (let i = 0; i < 60; i++) recoverRecoil(p, WEAPONS.ak47);
    expect(p.heat).toBe(0);
  });
});

describe('recoil patterns (§4.3)', () => {
  it('autos have 30 entries with monotone non-decreasing pitch for shots 0–7', () => {
    for (const id of ['mp5', 'ak47', 'm4a4'] as const) {
      const p = WEAPONS[id].pattern;
      expect(p.length, id).toBe(30);
      for (let i = 1; i < 8; i++) expect(p[i][0], `${id}[${i}]`).toBeGreaterThanOrEqual(p[i - 1][0]);
    }
    expect(WEAPONS.glock.pattern.length).toBe(1); expect(WEAPONS.deagle.pattern.length).toBe(2); expect(WEAPONS.awp.pattern).toEqual([[6, 0]]);
  });

  function spray(shots: number) {
    const p = player(1, 'T', v3(0, 0, 0), YAW_EAST); give(p, 'ak47');
    p.inv.primary!.mag = 30;
    const state = makeState([p]); const world = openWorld(); const rng = rngs(3); const out = recorder(state);
    const pitchAfterShot: number[] = [];
    while (out.of('shot').length < shots) {
      const n = out.of('shot').length;
      stepWeapon(p, cmd(p, Btn.FIRE), state, world, rng, out);
      if (out.of('shot').length > n) pitchAfterShot.push(p.aimOffset.pitch / DEG);
    }
    return { p, state, world, rng, out, pitchAfterShot };
  }
  it('steady-state AK spray offset is 7–11° and recovers below 0.5° within 2 s', () => {
    const { p, state, world, rng, out, pitchAfterShot } = spray(30);
    for (const v of pitchAfterShot.slice(10)) { expect(v).toBeGreaterThanOrEqual(7); expect(v).toBeLessThanOrEqual(11); }
    for (let i = 0; i < 120; i++) stepWeapon(p, cmd(p, 0), state, world, rng, out);
    expect(Math.hypot(p.aimOffset.pitch, p.aimOffset.yaw) / DEG).toBeLessThan(0.5);
    expect(p.shotIndex).toBeCloseTo(30 - 2 * 6, 6); // pattern index recovers at 6/s
  });
});

describe('sampleShotDir', () => {
  it('stays inside the cone (10^4 samples) and fills it', () => {
    const rng = new Rng(11);
    let maxRatio = 0;
    for (let i = 0; i < 10000; i++) {
      const yaw = rng.range(-Math.PI, Math.PI), pitch = rng.range(-1.4, 1.4), off = { yaw: rng.range(-0.05, 0.05), pitch: rng.range(0, 0.2) };
      const spread = rng.range(0.05, 12);
      const d = sampleShotDir(yaw, pitch, off, spread, rng);
      const c = dirFromYawPitch(yaw + off.yaw, pitch + off.pitch);
      const ang = Math.acos(Math.min(1, v3dot(d, c))) / DEG;
      expect(ang).toBeLessThanOrEqual(spread + 1e-6);
      maxRatio = Math.max(maxRatio, ang / spread);
    }
    expect(maxRatio).toBeGreaterThan(0.99);
    expect(sampleShotDir(0.3, 0.1, { yaw: 0, pitch: 0 }, 0, rng)).toEqual(dirFromYawPitch(0.3, 0.1));
  });
});

describe('trigger semantics (§4.4)', () => {
  it('AK fires exactly 10 shots in 1 s held; M4 ≈ 11; shots consume ammo and count stats', () => {
    for (const [id, n] of [['ak47', 10], ['m4a4', 11], ['mp5', 13]] as const) {
      const p = player(1, 'T', v3(), YAW_EAST); give(p, id);
      const state = makeState([p]); const out = recorder(state); const world = openWorld(); const rng = rngs();
      for (let i = 0; i < 60; i++) stepWeapon(p, cmd(p, Btn.FIRE), state, world, rng, out);
      expect(out.of('shot').length, id).toBe(n);
      expect(p.inv.primary!.mag).toBe(30 - n);
      expect(p.stats.shots).toBe(n);
    }
    expect(cycleTicks(WEAPONS.ak47)).toBe(6);
  });
  it('semi-auto needs a release between shots and respects the RPM', () => {
    const p = player(1, 'T', v3(), YAW_EAST); give(p, 'glock');
    const state = makeState([p]); const out = recorder(state); const world = openWorld(); const rng = rngs();
    for (let i = 0; i < 60; i++) stepWeapon(p, cmd(p, Btn.FIRE), state, world, rng, out);
    expect(out.of('shot').length).toBe(1);
    out.clear();
    for (let i = 0; i < 60; i++) stepWeapon(p, cmd(p, i % 2 === 0 ? Btn.FIRE : 0), state, world, rng, out); // tap every 2 ticks
    expect(out.of('shot').length).toBe(6); // 400 RPM → 9-tick cycle; presses inside the cycle are lost
  });
  it('shot event: origin = eye, end = first hit point, fire sound loudness by class', () => {
    const p = player(1, 'T', v3(0, 0, 0), YAW_EAST); give(p, 'ak47');
    const world = openWorld([{ box: { min: v3(10, 0, -5), max: v3(11, 4, 5) }, kind: 'wall', penetrable: false, surface: 'concrete' }]);
    const state = makeState([p]); const out = recorder(state);
    stepWeapon(p, cmd(p, Btn.FIRE), state, world, rngs(), out);
    const s = out.of('shot')[0];
    expect(s.origin).toEqual({ x: 0, y: 1.65, z: 0 });
    expect(s.end.x).toBeCloseTo(10, 5);
    expect(out.of('impact').length).toBe(1);
    const sounds = out.of('sound');
    expect(sounds.find((x) => x.id === 'fire_ak')!.loudness).toBe(40);
    expect(sounds.find((x) => x.id === 'impact_concrete')!.loudness).toBe(10);
    for (const [id, loud, snd] of [['glock', 30, 'fire_glock'], ['mp5', 40, 'fire_mp5'], ['awp', 60, 'fire_awp'], ['m4a4', 40, 'fire_m4']] as const) {
      const q = player(1, 'T', v3(), YAW_EAST); give(q, id); const st = makeState([q]); const o = recorder(st);
      stepWeapon(q, cmd(q, Btn.FIRE), st, openWorld(), rngs(), o);
      expect(o.of('sound').find((x) => x.id === snd)!.loudness).toBe(loud);
    }
  });
  it('dry fire emits dryFire + dryfire sound on a press and does not auto-reload', () => {
    const p = player(1, 'T', v3()); give(p, 'ak47'); p.inv.primary!.mag = 0;
    const state = makeState([p]); const out = recorder(state); const world = openWorld(); const rng = rngs();
    for (let i = 0; i < 20; i++) stepWeapon(p, cmd(p, Btn.FIRE), state, world, rng, out);
    expect(out.of('dryFire').length).toBe(1);
    expect(out.of('sound').filter((s) => s.id === 'dryfire')[0].loudness).toBe(3);
    expect(out.of('shot').length).toBe(0);
    expect(p.reload).toBeNull();
  });
});

describe('reload & switch timings (§4.1)', () => {
  it('reload restores the mag only at the end, decrements reserve, emits start/mid/end', () => {
    const p = player(1, 'T', v3()); give(p, 'ak47'); p.inv.primary!.mag = 5;
    const state = makeState([p]); const out = recorder(state); const world = openWorld(); const rng = rngs();
    stepWeapon(p, cmd(p, Btn.RELOAD), state, world, rng, out);
    expect(p.reload).not.toBeNull();
    for (let i = 1; i < 150; i++) stepWeapon(p, cmd(p, Btn.FIRE), state, world, rng, out); // firing is blocked while reloading
    expect(p.inv.primary!.mag).toBe(5);
    expect(out.of('shot').length).toBe(0);
    stepWeapon(p, cmd(p), state, world, rng, out);
    expect(p.inv.primary!.mag).toBe(30); expect(p.inv.primary!.reserve).toBe(65); expect(p.reload).toBeNull();
    expect(out.of('reload').map((r) => r.phase)).toEqual(['start', 'mid', 'end']);
    expect(out.of('sound').filter((s) => s.id.startsWith('reload_')).map((s) => s.id)).toEqual(['reload_out', 'reload_in', 'reload_bolt']);
    // limited by reserve
    p.inv.primary!.mag = 0; p.inv.primary!.reserve = 7;
    for (let i = 0; i < 160; i++) stepWeapon(p, cmd(p, i === 0 ? Btn.RELOAD : 0), state, world, rng, out);
    expect(p.inv.primary!.mag).toBe(7); expect(p.inv.primary!.reserve).toBe(0);
  });
  it('reload is cancelled by a switch; switch 0.5 s, knife 0.25 s, deploy after purchase 1.0 s', () => {
    const p = player(1, 'T', v3(), YAW_EAST); give(p, 'ak47'); p.inv.primary!.mag = 5;
    const state = makeState([p]); const out = recorder(state); const world = openWorld(); const rng = rngs();
    stepWeapon(p, cmd(p, Btn.RELOAD), state, world, rng, out);
    for (let i = 0; i < 60; i++) stepWeapon(p, cmd(p), state, world, rng, out);
    stepWeapon(p, cmd(p, 0, { slot: 2 }), state, world, rng, out);
    expect(p.reload).toBeNull(); expect(p.inv.active).toBe(2); expect(p.inv.primary!.mag).toBe(5);
    expect(out.of('weaponSwitch').at(-1)).toEqual({ player: 1, weapon: 'glock' });
    expect(out.of('sound').some((s) => s.id === 'switch_weapon' && s.loudness === 3)).toBe(true);
    // pistol fires only after 30 ticks
    const t0 = state.tick - 1; let firstShot = -1;
    expect(p.inv.switchEndsTick - t0).toBe(30);
    for (let i = 1; i < 40 && firstShot < 0; i++) { stepWeapon(p, cmd(p, i % 2 ? Btn.FIRE : 0), state, world, rng, out); if (out.of('shot').length) firstShot = state.tick - 1; }
    expect(firstShot - t0).toBe(31); // first press edge at/after the 30-tick deploy (odd offsets)
    // knife: 15 ticks
    stepWeapon(p, cmd(p, 0, { slot: 3 }), state, world, rng, out);
    expect(p.inv.switchEndsTick - (state.tick - 1)).toBe(15);
    expect(activeWeaponId(p)).toBe('knife');
    // deploy after purchase (economy.buy sets switchEndsTick = tick + 60)
    stepWeapon(p, cmd(p, 0, { slot: 1 }), state, world, rng, out);
    p.inv.switchEndsTick = state.tick + 60; out.clear();
    for (let i = 0; i < 60; i++) stepWeapon(p, cmd(p, Btn.FIRE), state, world, rng, out);
    expect(out.of('shot').length).toBe(0);
    stepWeapon(p, cmd(p, Btn.FIRE), state, world, rng, out);
    expect(out.of('shot').length).toBe(1);
  });
  it('reload requested during a deploy starts when the deploy ends', () => {
    const p = player(1, 'T', v3()); give(p, 'ak47'); p.inv.primary!.mag = 1;
    const state = makeState([p]); const out = recorder(state); const world = openWorld(); const rng = rngs();
    p.inv.switchEndsTick = state.tick + 20;
    stepWeapon(p, cmd(p, Btn.RELOAD), state, world, rng, out);
    expect(p.reload!.startTick).toBe(p.inv.switchEndsTick);
    expect(out.of('reload').length).toBe(0);
    for (let i = 0; i < 20; i++) stepWeapon(p, cmd(p), state, world, rng, out);
    expect(out.of('reload').map((r) => r.phase)).toEqual(['start']);
  });
});

describe('AWP (§4.1/§4.4)', () => {
  it('SCOPE press edges cycle 0→1→2→0; holding does not cycle', () => {
    const p = player(1, 'CT', v3()); give(p, 'awp');
    const state = makeState([p]); const out = recorder(state); const world = openWorld(); const rng = rngs();
    const seen: number[] = [];
    for (let i = 0; i < 6; i++) { stepWeapon(p, cmd(p, Btn.SCOPE), state, world, rng, out); stepWeapon(p, cmd(p, 0), state, world, rng, out); seen.push(p.scoped); }
    expect(seen).toEqual([1, 2, 0, 1, 2, 0]);
    for (let i = 0; i < 10; i++) stepWeapon(p, cmd(p, Btn.SCOPE), state, world, rng, out);
    expect(p.scoped).toBe(1);
  });
  it('shot → unscoped during the 1.46 s bolt → re-scope with scopeHold; none without it; bots always', () => {
    for (const [hold, bot, expected] of [[true, false, 2], [false, false, 0], [false, true, 2]] as const) {
      const p = player(bot ? 2 : 1, 'CT', v3(), 0, bot); give(p, 'awp'); p.scoped = 2;
      const state = makeState([p], { options: { autoPickup: true, scopeHold: hold } }); const out = recorder(state); const world = openWorld(); const rng = rngs();
      stepWeapon(p, cmd(p, Btn.FIRE), state, world, rng, out);
      expect(p.scoped).toBe(0);
      for (let i = 0; i < 87; i++) stepWeapon(p, cmd(p), state, world, rng, out);
      expect(p.scoped).toBe(0);
      stepWeapon(p, cmd(p), state, world, rng, out);
      expect(p.scoped, `hold=${hold} bot=${bot}`).toBe(expected);
    }
  });
  it('a re-scope whose bolt ended while the weapon tick was skipped (freeze) expires', () => {
    const p = player(1, 'CT', v3()); give(p, 'awp'); p.scoped = 1;
    const state = makeState([p]); const out = recorder(state); const world = openWorld(); const rng = rngs();
    stepWeapon(p, cmd(p, Btn.FIRE), state, world, rng, out);
    state.tick += 400; // ROUND_END + FREEZE: sim.ts skips tickWeapon
    stepWeapon(p, cmd(p), state, world, rng, out);
    expect(p.scoped).toBe(0);
  });
  it('bolt: next shot no sooner than 1.46 s', () => {
    const p = player(1, 'CT', v3()); give(p, 'awp');
    const state = makeState([p]); const out = recorder(state); const world = openWorld(); const rng = rngs();
    const ticks: number[] = [];
    for (let i = 0; i < 200; i++) { const n = out.of('shot').length; stepWeapon(p, cmd(p, i % 2 ? 0 : Btn.FIRE), state, world, rng, out); if (out.of('shot').length > n) ticks.push(i); }
    expect(ticks.length).toBe(3);
    expect(ticks[1] - ticks[0]).toBeGreaterThanOrEqual(88); expect(ticks[1] - ticks[0]).toBeLessThanOrEqual(89);
  });
});

describe('per-weapon cooldowns (§4.1/§4.4)', () => {
  /** Ticks (state.tick) at which a `shot` / `knife` event happened while holding `btn` from now on. */
  function attackTicks(p: ReturnType<typeof player>, btn: number, n: number, s: { state: ReturnType<typeof makeState>; out: ReturnType<typeof recorder>; world: ReturnType<typeof openWorld>; rng: ReturnType<typeof rngs> }): number[] {
    const at: number[] = [];
    for (let i = 0; i < n; i++) { const k = s.out.of('shot').length + s.out.of('knife').length; const t = s.state.tick; stepWeapon(p, cmd(p, i % 2 ? 0 : btn), s.state, s.world, s.rng, s.out); if (s.out.of('shot').length + s.out.of('knife').length > k) at.push(t); }
    return at;
  }
  function setup() {
    const p = player(1, 'CT', v3()); give(p, 'awp'); give(p, 'usp'); // holding the USP, AWP in slot 1
    const state = makeState([p]); const out = recorder(state); const world = openWorld(); const rng = rngs();
    return { p, s: { state, out, world, rng } };
  }
  it('a pistol shot does not start the AWP bolt: the AWP fires and scopes as soon as its deploy ends', () => {
    const { p, s } = setup();
    stepWeapon(p, cmd(p, Btn.FIRE), s.state, s.world, s.rng, s.out);           // USP shot at 1000
    expect(s.out.of('shot')).toHaveLength(1);
    stepWeapon(p, cmd(p, 0, { slot: 1 }), s.state, s.world, s.rng, s.out);      // switch at 1001 → deploy ends 1031
    expect(p.inv.switchEndsTick).toBe(1031);
    while (s.state.tick < 1031) stepWeapon(p, cmd(p, Btn.SCOPE), s.state, s.world, s.rng, s.out);
    expect(p.scoped).toBe(0);
    stepWeapon(p, cmd(p, 0), s.state, s.world, s.rng, s.out);
    stepWeapon(p, cmd(p, Btn.SCOPE), s.state, s.world, s.rng, s.out);          // 1032: scope works
    expect(p.scoped).toBe(1);
    expect(attackTicks(p, Btn.FIRE, 2, s)).toEqual([1033]);
  });
  it('switching away and back cannot skip the AWP bolt, even with a pistol shot in between', () => {
    const { p, s } = setup();
    p.inv.active = 1;
    stepWeapon(p, cmd(p, Btn.FIRE), s.state, s.world, s.rng, s.out);           // AWP shot at 1000
    stepWeapon(p, cmd(p, 0, { slot: 2 }), s.state, s.world, s.rng, s.out);      // 1001 → USP ready 1031
    while (s.state.tick < 1031) stepWeapon(p, cmd(p), s.state, s.world, s.rng, s.out);
    expect(attackTicks(p, Btn.FIRE, 1, s)).toEqual([1031]);                    // the USP is not blocked by the bolt
    stepWeapon(p, cmd(p, 0, { slot: 1 }), s.state, s.world, s.rng, s.out);      // 1032 → AWP deploy ends 1062
    const shots = attackTicks(p, Btn.FIRE, 60, s);
    expect(shots[0]).toBeGreaterThanOrEqual(1000 + cycleTicks(WEAPONS.awp) - 1e-6);
    expect(shots[0]).toBeLessThanOrEqual(1089);
  });
  it('a knife stab only delays the knife: a gun drawn after it fires when its deploy ends', () => {
    const p = player(1, 'CT', v3()); give(p, 'ak47'); p.inv.active = 3;
    const state = makeState([p]); const out = recorder(state); const world = openWorld(); const rng = rngs();
    const s = { state, out, world, rng };
    stepWeapon(p, cmd(p, Btn.SCOPE), state, world, rng, out);                 // stab at 1000
    expect(out.of('knife')).toHaveLength(1);
    stepWeapon(p, cmd(p, 0, { slot: 1 }), state, world, rng, out);            // 1001 → AK ready 1031
    while (state.tick < p.inv.switchEndsTick) stepWeapon(p, cmd(p), state, world, rng, out);
    expect(attackTicks(p, Btn.FIRE, 1, s)).toEqual([1031]);
  });
});

describe('knife (§4.4)', () => {
  function duel(dist: number, victimYaw: number, attackerYaw = YAW_EAST) {
    const a = player(1, 'T', v3(0, 0, 0), attackerYaw); a.inv.active = 3;
    const v = player(2, 'CT', v3(dist, 0, 0), victimYaw);
    const state = makeState([a, v]); const out = recorder(state); const world = openWorld(); const rng = rngs();
    return { a, v, state, out, world, rng };
  }
  it('slash 40 / stab 65 / backstab 195 within 1.2 m in front; misses out of reach or behind', () => {
    let d = duel(0.9, 90 * DEG); // victim faces the attacker (west)
    stepWeapon(d.a, cmd(d.a, Btn.FIRE), d.state, d.world, d.rng, d.out);
    expect(d.v.hp).toBe(60);
    expect(d.out.of('knife')[0]).toMatchObject({ player: 1, hit: true, stab: false });
    expect(d.out.of('sound').map((s) => s.id)).toEqual(expect.arrayContaining(['knife_swing', 'knife_hit']));
    d = duel(0.9, 90 * DEG);
    stepWeapon(d.a, cmd(d.a, Btn.SCOPE), d.state, d.world, d.rng, d.out);
    expect(d.v.hp).toBe(35);
    expect(d.out.of('sound').some((s) => s.id === 'knife_stab' && s.loudness === 8)).toBe(true);
    d = duel(0.9, -90 * DEG); // victim faces away (east) → backstab
    expect(isBackstab(d.a, d.v)).toBe(true);
    stepWeapon(d.a, cmd(d.a, Btn.SCOPE), d.state, d.world, d.rng, d.out);
    expect(d.v.alive).toBe(false);
    expect(d.state.pendingDeaths.length).toBe(0); // consumed by stepWeapon helper; the kill was pushed
    d = duel(1.9, 90 * DEG);
    stepWeapon(d.a, cmd(d.a, Btn.FIRE), d.state, d.world, d.rng, d.out);
    expect(d.v.hp).toBe(100); expect(d.out.of('knife')[0].hit).toBe(false);
    d = duel(0.9, 90 * DEG, 90 * DEG); // attacker faces away
    stepWeapon(d.a, cmd(d.a, Btn.FIRE), d.state, d.world, d.rng, d.out);
    expect(d.v.hp).toBe(100);
  });
  it('slash every 0.5 s while held, stab every 1.0 s; teammates are never cut', () => {
    const d = duel(0.9, 90 * DEG); d.v.hp = 10000;
    for (let i = 0; i < 60; i++) stepWeapon(d.a, cmd(d.a, Btn.FIRE), d.state, d.world, d.rng, d.out);
    expect(d.out.of('knife').length).toBe(2);
    d.out.clear();
    for (let i = 0; i < 120; i++) stepWeapon(d.a, cmd(d.a, Btn.SCOPE), d.state, d.world, d.rng, d.out);
    expect(d.out.of('knife').length).toBe(2);
    const m = duel(0.9, 90 * DEG); m.v.team = 'T';
    stepWeapon(m.a, cmd(m.a, Btn.FIRE), m.state, m.world, m.rng, m.out);
    expect(m.v.hp).toBe(100);
  });
});
