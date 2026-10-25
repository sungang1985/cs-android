/** §2.2 / §6.8 bomb rules: plant, defuse (7 s / 3.5 s kit), resets, explosion, dropped bomb. */
import { describe, it, expect } from 'vitest';
import { explosionDamage, BOMB, siteAt } from '@/rules/bomb';
import { harness, step, stepTo, kill, giveBomb, teleport, ofType, BOX_SITE_A, Btn, type Harness } from './helpers';

/** LIVE, human (T, id 1) carries the bomb and stands on BOX site A. */
function atSite(): Harness {
  const h = harness();
  stepTo(h, 400);
  giveBomb(h, 1); teleport(h.human(), BOX_SITE_A.x, BOX_SITE_A.y, BOX_SITE_A.z);
  return h;
}

/** Plants with the human (holds USE for 181 ticks) and returns the plant tick. */
function plant(h: Harness): number {
  const start = h.sim.state.tick;
  step(h, BOMB.plantTicks + 1, { buttons: Btn.USE });
  expect(h.sim.state.bomb.state).toBe('planted');
  return start + BOMB.plantTicks;
}

describe('rules/bomb — plant', () => {
  it('3.0 s plant: start event + bomb_plant sound (25), bombPlanted at +180 ticks, planter +$300 and stats', () => {
    const h = atSite();
    const me = h.human(); const money = me.money;
    const start = h.sim.state.tick;
    step(h, 1, { buttons: Btn.USE });
    expect(me.use.action).toBe('plant');
    expect(ofType(h, 'bombPlantStart')).toEqual([{ player: 1, tick: start }]);
    expect(ofType(h, 'sound').filter((s) => s.id === 'bomb_plant')).toEqual([expect.objectContaining({ loudness: 25, player: 1, tick: start })]);
    step(h, BOMB.plantTicks - 1, { buttons: Btn.USE });
    expect(h.sim.state.bomb.state).toBe('carried');
    step(h, 1, { buttons: Btn.USE });
    const b = h.sim.state.bomb;
    expect([b.state, b.site, b.plantedTick, b.explodeTick, b.carrier]).toEqual(['planted', 'a', start + 180, start + 180 + 35 * 60, 0]);
    expect(ofType(h, 'bombPlanted')).toEqual([expect.objectContaining({ player: 1, site: 'a', tick: start + 180 })]);
    expect(me.hasBomb).toBe(false); expect(me.use.action).toBe('none');
    expect(me.money).toBe(money + 300);
    expect(ofType(h, 'money')).toContainEqual(expect.objectContaining({ player: 1, delta: 300, reason: 'plant' }));
    expect(me.stats.plants).toBe(1);
    expect(ofType(h, 'bombPlantStop')).toHaveLength(0);
  });

  it('progress resets (never pauses): releasing USE or moving stops it with exactly one stop event', () => {
    const h = atSite();
    const me = h.human();
    step(h, 100, { buttons: Btn.USE });
    step(h, 1); // released
    expect(me.use.action).toBe('none');
    expect(ofType(h, 'bombPlantStop')).toHaveLength(1);
    step(h, 5);
    expect(ofType(h, 'bombPlantStop')).toHaveLength(1);
    const restart = h.sim.state.tick;
    step(h, 1, { buttons: Btn.USE });
    expect(me.use.startTick).toBe(restart); // from 0 again
    me.vel.x = 3; // pushed: speed ≥ 0.5 m/s
    step(h, 1, { buttons: Btn.USE });
    expect(me.use.action).toBe('none');
    expect(ofType(h, 'bombPlantStop')).toHaveLength(2);
    // still holding: once the player stands still again the plant restarts from 0
    let ticks = 0;
    while (me.use.action === 'none' && ticks++ < 60) step(h, 1, { buttons: Btn.USE });
    expect(me.use.action).toBe('plant');
    expect(ofType(h, 'bombPlantStart')).toHaveLength(3);
    step(h, BOMB.plantTicks + 1, { buttons: Btn.USE });
    expect(h.sim.state.bomb.state).toBe('planted');
  });

  it('only a T carrier inside a site, standing, not switching or blind, during LIVE can plant', () => {
    const h = harness();
    stepTo(h, 100);
    giveBomb(h, 1); teleport(h.human(), BOX_SITE_A.x, 0, BOX_SITE_A.z);
    step(h, 10, { buttons: Btn.USE }); // FREEZE
    expect(h.human().use.action).toBe('none');
    stepTo(h, 400);
    teleport(h.human(), 5, 0, 5); // outside the site
    step(h, 10, { buttons: Btn.USE });
    expect(h.human().use.action).toBe('none');
    teleport(h.human(), BOX_SITE_A.x, 0, BOX_SITE_A.z);
    h.human().blindUntilTick = h.sim.state.tick + 30;
    step(h, 10, { buttons: Btn.USE });
    expect(h.human().use.action).toBe('none');
    h.human().blindUntilTick = 0; h.human().inv.switchEndsTick = h.sim.state.tick + 5;
    step(h, 1, { buttons: Btn.USE });
    expect(h.human().use.action).toBe('none');
    step(h, 10, { buttons: Btn.USE });
    expect(h.human().use.action).toBe('plant');
    expect(siteAt(h.deps.map, 5, 5)).toBeNull();
    expect(siteAt(h.deps.map, h.deps.map.plantSpots.b.x, h.deps.map.plantSpots.b.z)).toBe('b');
  });

  it('taking damage does not interrupt a plant (CS rule)', () => {
    const h = atSite();
    step(h, 50, { buttons: Btn.USE });
    const me = h.human(); me.hp = 100; me.lastDamage = { tick: h.sim.state.tick, from: { x: 0, y: 0, z: 0 }, amount: 60 }; me.hp = 40;
    step(h, BOMB.plantTicks - 49, { buttons: Btn.USE });
    expect(h.sim.state.bomb.state).toBe('planted');
  });

  it('a planter killed mid-plant emits bombPlantStop once and drops the bomb', () => {
    const h = atSite();
    step(h, 30, { buttons: Btn.USE });
    kill(h, 1, 3);
    step(h, 1, { buttons: Btn.USE });
    expect(ofType(h, 'bombPlantStop')).toEqual([expect.objectContaining({ player: 1 })]);
    step(h, 3, { buttons: Btn.USE });
    expect(ofType(h, 'bombPlantStop')).toHaveLength(1);
    expect(h.sim.state.bomb.state).toBe('dropped');
  });
});

describe('rules/bomb — defuse', () => {
  function planted(kit: boolean): { h: Harness; plantTick: number } {
    const h = atSite();
    const plantTick = plant(h);
    const ct = h.p(3); ct.hasKit = kit;
    teleport(ct, BOX_SITE_A.x + 1, 0, BOX_SITE_A.z);
    teleport(h.human(), 5, 0, 5);
    step(h, 2);
    return { h, plantTick };
  }

  for (const kit of [false, true]) {
    it(`defuse takes ${kit ? '3.5' : '7.0'} s ${kit ? 'with' : 'without'} a kit → CT \`defuse\`, +$300, ticking sound every 20 ticks`, () => {
      const { h } = planted(kit);
      const ct = h.p(3); const money = ct.money;
      h.script.set(3, { buttons: Btn.USE });
      const start = h.sim.state.tick;
      step(h);
      expect(ct.use.action).toBe('defuse');
      expect(ofType(h, 'bombDefuseStart')).toEqual([{ player: 3, kit, tick: start }]);
      const dur = kit ? 210 : 420;
      stepTo(h, start + dur);
      expect(h.sim.state.bomb.state).toBe('planted');
      step(h);
      expect(h.sim.state.bomb.state).toBe('defused');
      expect(ofType(h, 'bombDefused')).toEqual([{ player: 3, tick: start + dur }]);
      expect(ofType(h, 'sound').filter((s) => s.id === 'bomb_defused')).toEqual([expect.objectContaining({ loudness: 30 })]);
      const ticks = ofType(h, 'sound').filter((s) => s.id === 'bomb_defuse_tick');
      expect(ticks.length).toBe(Math.floor(dur / 20) + 1);
      expect(ticks.every((s) => (s.tick - start) % 20 === 0 && s.loudness === 15)).toBe(true);
      expect(ct.stats.defuses).toBe(1);
      expect(ofType(h, 'money')).toContainEqual(expect.objectContaining({ player: 3, delta: 300, reason: 'defuse' }));
      expect(ct.money).toBe(money + 300);
      step(h);
      expect([h.sim.state.round.phase, h.sim.state.round.winner, h.sim.state.round.reason]).toEqual(['ROUND_END', 'CT', 'defuse']);
    });
  }

  it('defuse needs the CT within 1.5 m; stepping away resets it; only one defuser at a time', () => {
    const { h } = planted(false);
    const a = h.p(3), b = h.p(4);
    teleport(b, BOX_SITE_A.x - 1, 0, BOX_SITE_A.z);
    h.script.set(3, { buttons: Btn.USE }); h.script.set(4, { buttons: Btn.USE });
    step(h);
    expect([a.use.action, b.use.action]).toEqual(['defuse', 'none']);
    teleport(a, BOX_SITE_A.x + 1.6, 0, BOX_SITE_A.z);
    step(h);
    expect(a.use.action).toBe('none');
    expect(ofType(h, 'bombDefuseStop')).toEqual([expect.objectContaining({ player: 3 })]);
    step(h);
    expect(b.use.action).toBe('defuse'); // the other CT takes over
  });

  it('explosion: bombExploded + global sound (1000), damage round(500·(1 − d/12)) with weapon `bomb` to both teams', () => {
    expect([explosionDamage(0), explosionDamage(6), explosionDamage(3), explosionDamage(12), explosionDamage(20)]).toEqual([500, 250, 375, 0, 0]);
    const h = atSite();
    const plantTick = plant(h);
    const me = h.human(); teleport(me, BOX_SITE_A.x - 1, 0, BOX_SITE_A.z); me.armor = 100; me.helmet = true;
    const ct = h.p(4); teleport(ct, BOX_SITE_A.x, 0, BOX_SITE_A.z + 9); // 9 m away → 125 dmg
    const ct3 = h.p(3); teleport(ct3, 3, 0, 9); // 8.49 m away
    stepTo(h, plantTick + BOMB.timerTicks + 1);
    expect(ofType(h, 'bombExploded')).toHaveLength(1);
    expect(ofType(h, 'sound').filter((s) => s.id === 'bomb_explode')).toEqual([expect.objectContaining({ loudness: 1000, player: 0 })]);
    const dmg = ofType(h, 'damageTaken');
    expect(dmg.find((d) => d.victim === 1)?.amount).toBe(Math.round(explosionDamage(1) * 0.5)); // armored chest, AP 0.5
    expect(dmg.find((d) => d.victim === 4)?.amount).toBe(explosionDamage(9));
    expect(dmg.find((d) => d.victim === 3)?.amount).toBe(explosionDamage(Math.hypot(6, 6)));
    expect(ofType(h, 'bombExploded')[0].tick).toBe(plantTick + BOMB.timerTicks);
    const deaths = ofType(h, 'death');
    expect(deaths.every((d) => d.weapon === 'bomb' && d.killer === 0)).toBe(true);
  });

  it('a defuse completing on the explosion tick wins for CT', () => {
    const { h } = planted(true);
    const b = h.sim.state.bomb;
    b.explodeTick = h.sim.state.tick + 210;
    h.script.set(3, { buttons: Btn.USE });
    step(h, 212);
    expect(b.state).toBe('defused');
    expect(ofType(h, 'bombExploded')).toHaveLength(0);
  });
});

describe('rules/bomb — dropped bomb', () => {
  it('a dead carrier drops the bomb; a T bot walking over it picks it up (itemPickup, bombPickup, bomb_pickup sound)', () => {
    const h = harness();
    stepTo(h, 400);
    giveBomb(h, 1);
    kill(h, 1, 3);
    expect(h.sim.state.bomb.state).toBe('dropped');
    const item = h.sim.state.items.find((i) => i.kind === 'bomb')!;
    teleport(h.p(2), item.pos.x + 0.2, 0, item.pos.z);
    step(h);
    expect(h.sim.state.bomb.state).toBe('carried');
    expect(h.sim.state.bomb.carrier).toBe(2);
    expect(h.p(2).hasBomb).toBe(true);
    expect(h.sim.state.items.some((i) => i.kind === 'bomb')).toBe(false);
    expect(ofType(h, 'bombPickup')).toEqual([expect.objectContaining({ player: 2 })]);
    expect(ofType(h, 'sound').filter((s) => s.id === 'bomb_pickup')).toEqual([expect.objectContaining({ loudness: 5 })]);
  });

  it('the human with auto-pickup off takes the dropped bomb only on a USE press', () => {
    const h = harness({ options: { autoPickup: false, scopeHold: true } });
    stepTo(h, 400);
    giveBomb(h, 2);
    kill(h, 2, 3);
    const item = h.sim.state.items.find((i) => i.kind === 'bomb')!;
    teleport(h.human(), item.pos.x, 0, item.pos.z);
    step(h, 5);
    expect(h.sim.state.bomb.state).toBe('dropped');
    step(h, 1, { buttons: Btn.USE });
    expect(h.sim.state.bomb.carrier).toBe(1);
  });

  it('the carried bomb position follows the carrier', () => {
    const h = harness();
    stepTo(h, 400);
    giveBomb(h, 1); teleport(h.human(), 4, 0, 4);
    step(h);
    expect(h.sim.state.bomb.pos).toEqual(expect.objectContaining({ x: 4, z: 4 }));
  });
});
