/** §4.4 world items: dropItem, tryPickup (auto vs USE swap), bomb/kit rules, DROP bit toss. */
import { describe, it, expect } from 'vitest';
import { v3, DEG, aabb } from '@/core/math';
import { Btn, SNAPSHOT_CAPACITY, type ItemState } from '@/sim/state';
import type { CompiledMap } from '@/world/types';
import { processDeaths } from '@/sim/death';
import { dropItem, tryPickup, pickupObjectives, floorDropPoint } from '@/weapons/items';
import { recorder, makeState, player, openWorld, solid, cmd, stepWeapon, give, rngs } from './helpers';

const gun = (id: number, x: number, z = 0, w: 'ak47' | 'awp' | 'm4a4' = 'awp', tick = 0): ItemState => ({ id, kind: 'weapon', weapon: { id: w, mag: 3, reserve: 10 }, pos: v3(x, 0, z), yaw: 0, droppedTick: tick });

describe('tryPickup', () => {
  it('auto: only into an empty primary slot, within 1.0 m (XZ)', () => {
    const p = player(2, 'CT', v3(0, 0, 0));
    const state = makeState([p]); const out = recorder(state);
    state.items.push(gun(50, 1.2), gun(51, 0.8));
    tryPickup(state, p, true, out);
    expect(p.inv.primary).toEqual({ id: 'awp', mag: 3, reserve: 10 });
    expect(state.items.map((i) => i.id)).toEqual([50]);
    expect(out.of('itemPickup')).toEqual([{ id: 51, player: 2, kind: 'weapon' }]);
    expect(p.inv.active).toBe(2); // auto pickup does not draw the weapon
    state.items.push(gun(52, 0.2, 0, 'm4a4'));
    tryPickup(state, p, true, out);
    expect(p.inv.primary!.id).toBe('awp'); expect(state.items).toHaveLength(2);
  });
  it('USE (auto = false): swaps with the nearest, drops the held primary at the feet and draws the new one', () => {
    const p = player(1, 'T', v3(0, 0, 0)); give(p, 'ak47'); p.inv.primary!.mag = 11;
    const state = makeState([p]); const out = recorder(state);
    state.items.push(gun(50, 0.9, 0, 'awp', 0), gun(51, 0.4, 0, 'm4a4', 0));
    tryPickup(state, p, false, out);
    expect(p.inv.primary!.id).toBe('m4a4');
    const dropped = state.items.find((i) => i.weapon?.id === 'ak47')!;
    expect(dropped.weapon!.mag).toBe(11); expect(dropped.pos).toEqual(v3(0, 0, 0));
    expect(p.inv.active).toBe(1); expect(p.inv.switchEndsTick).toBe(state.tick + 30);
    expect(out.of('weaponSwitch').at(-1)).toEqual({ player: 1, weapon: 'm4a4' });
    // a second call in the same tick never swaps back to the weapon just dropped
    tryPickup(state, p, false, out);
    expect(p.inv.primary!.id).toBe('awp');
    tryPickup(state, p, false, out);
    expect(p.inv.primary!.id).toBe('awp');
  });
  it('bomb: T only, always (also with auto); bomb state carried; bombPickup + bomb_pickup sound', () => {
    const ct = player(2, 'CT', v3(0, 0, 0)); const t = player(3, 'T', v3(0.5, 0, 0));
    const state = makeState([ct, t]); const out = recorder(state);
    const p0 = player(9, 'T', v3(0, 0, 0)); p0.hasBomb = true; state.players.push(p0);
    dropItem(state, p0, 'bomb', out);
    expect(state.bomb.state).toBe('dropped');
    const bombId = state.bomb.itemId;
    tryPickup(state, ct, true, out); tryPickup(state, ct, false, out);
    expect(ct.hasBomb).toBe(false); expect(state.items).toHaveLength(1);
    tryPickup(state, t, false, out);
    expect(t.hasBomb).toBe(true); expect(state.items).toHaveLength(0);
    expect(state.bomb).toMatchObject({ state: 'carried', carrier: 3, itemId: 0 });
    expect(out.of('itemPickup')).toEqual([{ id: bombId, player: 3, kind: 'bomb' }]);
    expect(out.of('bombPickup')).toEqual([{ player: 3 }]);
    expect(out.of('sound').find((s) => s.id === 'bomb_pickup')!.loudness).toBe(5);
  });
  it('kit: CT without a kit only; dropItem supports kit', () => {
    const owner = player(4, 'CT', v3(0, 0, 0)); owner.hasKit = true;
    const t = player(3, 'T', v3(0, 0, 0)); const ct = player(2, 'CT', v3(0.3, 0, 0));
    const state = makeState([ct, t, owner]); const out = recorder(state);
    dropItem(state, owner, 'kit', out);
    expect(owner.hasKit).toBe(false); expect(state.items[0].kind).toBe('kit');
    tryPickup(state, t, true, out);
    expect(state.items).toHaveLength(1);
    tryPickup(state, ct, true, out);
    expect(ct.hasKit).toBe(true); expect(state.items).toHaveLength(0);
  });
  it('pickupObjectives takes the bomb but never weapons', () => {
    const t = player(3, 'T', v3(0, 0, 0)); const state = makeState([t]); const out = recorder(state);
    state.items.push(gun(50, 0.3), { id: 51, kind: 'bomb', pos: v3(0.2, 0, 0), yaw: 0, droppedTick: 0 });
    state.bomb.state = 'dropped'; state.bomb.itemId = 51;
    pickupObjectives(state, t, out);
    expect(t.hasBomb).toBe(true); expect(t.inv.primary).toBeNull(); expect(state.items.map((i) => i.id)).toEqual([50]);
  });
  it('dead players and items on another floor are ignored', () => {
    const p = player(2, 'CT', v3(0, 0, 0)); const state = makeState([p]); const out = recorder(state);
    state.items.push({ ...gun(50, 0.2), pos: v3(0.2, 1.5, 0) });
    tryPickup(state, p, true, out);
    expect(p.inv.primary).toBeNull();
    state.items[0].pos.y = 0; p.alive = false;
    tryPickup(state, p, true, out);
    expect(p.inv.primary).toBeNull();
  });
});

describe('DROP bit', () => {
  it('tosses the primary 1.2 m ahead (out of auto-pickup range) and draws the pistol', () => {
    const p = player(1, 'T', v3(0, 0, 0), -90 * DEG); give(p, 'ak47');
    const state = makeState([p]); const out = recorder(state); const world = openWorld();
    stepWeapon(p, cmd(p, Btn.DROP), state, world, rngs(), out);
    expect(p.inv.primary).toBeNull(); expect(p.inv.active).toBe(2);
    expect(state.items[0].pos.x).toBeCloseTo(1.2, 6); expect(state.items[0].pos.y).toBe(0);
    expect(out.of('itemDrop')[0]).toMatchObject({ kind: 'weapon' });
    expect(out.of('weaponSwitch').at(-1)!.weapon).toBe('glock');
    tryPickup(state, p, true, out);
    expect(p.inv.primary).toBeNull();
  });
});

describe('item cap (snapshot capacity)', () => {
  it('never holds more than SNAPSHOT_CAPACITY.items: the oldest weapon/kit gives way, the bomb always stays', () => {
    const carrier = player(9, 'T', v3(0, 0, 0)); carrier.hasBomb = true;
    const state = makeState([carrier]); const out = recorder(state);
    dropItem(state, carrier, 'bomb', out);
    const bombId = state.bomb.itemId;
    const ids: number[] = [];
    for (let i = 0; i < 40; i++) { const v = player(10 + i, 'CT', v3(i, 0, 0)); give(v, 'ak47'); dropItem(state, v, 'weapon', out); ids.push(state.items.at(-1)!.id); }
    expect(state.items).toHaveLength(SNAPSHOT_CAPACITY.items);
    expect(state.items[0].id).toBe(bombId);
    expect(state.items.slice(1).map((i) => i.id)).toEqual(ids.slice(-(SNAPSHOT_CAPACITY.items - 1)));
  });
});

describe('drops settle on the floor', () => {
  const world = openWorld([solid(aabb(4, 0, -1, 6, 1.5, 1), 'lowcrate')]);
  it('floorDropPoint projects an airborne player onto the floor below (ground or a crate top)', () => {
    expect(floorDropPoint(player(2, 'CT', v3(0, 2.4, 0)), world)).toEqual(v3(0, 0, 0));
    expect(floorDropPoint(player(2, 'CT', v3(5, 2.2, 0)), world)).toEqual(v3(5, 1.5, 0));
    expect(floorDropPoint(player(2, 'CT', v3(5, 1.5, 0)), world)).toEqual(v3(5, 1.5, 0));
  });
  it('the death pipeline drops an airborne victim primary and bomb on the floor, where a T can pick the bomb up', () => {
    const v = player(2, 'T', v3(0, 2.4, 0)); give(v, 'awp'); v.hasBomb = true; v.alive = false;
    const t = player(3, 'T', v3(0.3, 0, 0));
    const state = makeState([v, t]); const out = recorder(state);
    state.pendingDeaths.push({ victim: 2, killer: 0, weapon: 'ak47', headshot: false, dir: v3(0, 0, -1), point: v3(0, 3.4, 0) });
    processDeaths(state, {} as CompiledMap, out, world);
    expect(state.items.map((i) => i.pos.y)).toEqual([0, 0]);
    expect(state.bomb.pos.y).toBe(0);
    tryPickup(state, t, true, out);
    expect(t.hasBomb).toBe(true);
  });
});
