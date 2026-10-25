/**
 * World items (§4.4): dropped primaries, the dropped C4, defuse kits. dropItem is used by the death pipeline (§11.6.1),
 * the DROP bit and USE swaps; tryPickup runs every tick for alive players (sim.ts step 6) and on a USE press.
 */
import { v3, type Vec3 } from '../core/math';
import { SNAPSHOT_CAPACITY, type WorldState, type PlayerState, type ItemState } from '../sim/state';
import type { StaticWorld } from '../world/collision';
import { LOUDNESS, type SimEventSink } from '../sim/events';
import { allocId } from '../sim/entities';
import { WEAPONS } from './defs';
import { switchTo, type WeaponPlayer } from './inventory';

export const PICKUP = { radius: 1.0, maxDy: 1.2 } as const;

/**
 * The floor under the player's feet (an airborne victim's drop falls to the ground instead of floating): pass as
 * dropItem's `at`. Falls back to the feet when there is no floor below.
 */
export function floorDropPoint(p: PlayerState, world: StaticWorld): Vec3 {
  const y = world.floorHeightAt(p.pos.x, p.pos.z, p.pos.y + 0.1, 0);
  return v3(p.pos.x, Number.isFinite(y) ? y : p.pos.y, p.pos.z);
}

/**
 * World items never exceed the snapshot capacity (SNAPSHOT_CAPACITY.items), so every item the sim can pick up is also
 * rendered: when full, the oldest weapon/kit item is removed (TDM/training never clear items; the bomb always stays).
 */
function pushItem(state: WorldState, item: ItemState): void {
  while (state.items.length >= SNAPSHOT_CAPACITY.items) {
    const i = state.items.findIndex((it) => it.kind !== 'bomb');
    if (i < 0) break;
    state.items.splice(i, 1);
  }
  state.items.push(item);
}

/** Drops the primary ('weapon'), the C4 ('bomb') or the defuse kit ('kit') at `at` (default: the feet). */
export function dropItem(state: WorldState, p: PlayerState, kind: ItemState['kind'], out: SimEventSink, at?: Vec3): void {
  const pos = at ? v3(at.x, at.y, at.z) : v3(p.pos.x, p.pos.y, p.pos.z);
  if (kind === 'weapon') {
    if (!p.inv.primary) return;
    const item: ItemState = { id: allocId(state), kind: 'weapon', weapon: p.inv.primary, pos, yaw: p.yaw, droppedTick: state.tick };
    if (p.reload && p.reload.weapon === p.inv.primary.id) p.reload = null;
    p.inv.primary = null;
    if (p.inv.active === 1) { p.inv.active = 2; p.scoped = 0; (p as WeaponPlayer).rescope = 0; }
    pushItem(state, item);
    out.emit('itemDrop', { id: item.id, kind: 'weapon', pos: v3(pos.x, pos.y, pos.z) });
  } else if (kind === 'bomb') {
    if (!p.hasBomb) return;
    const item: ItemState = { id: allocId(state), kind: 'bomb', pos, yaw: p.yaw, droppedTick: state.tick };
    p.hasBomb = false; pushItem(state, item);
    state.bomb.state = 'dropped'; state.bomb.carrier = 0; state.bomb.itemId = item.id; state.bomb.pos = v3(pos.x, pos.y, pos.z);
    out.emit('itemDrop', { id: item.id, kind: 'bomb', pos: v3(pos.x, pos.y, pos.z) });
    out.emit('bombDrop', { pos: v3(pos.x, pos.y, pos.z) });
  } else {
    if (!p.hasKit) return;
    const item: ItemState = { id: allocId(state), kind: 'kit', pos, yaw: p.yaw, droppedTick: state.tick };
    p.hasKit = false; pushItem(state, item);
    out.emit('itemDrop', { id: item.id, kind: 'kit', pos: v3(pos.x, pos.y, pos.z) });
  }
}

function removeItem(state: WorldState, id: number): void {
  const i = state.items.findIndex((it) => it.id === id);
  if (i >= 0) state.items.splice(i, 1);
}

/**
 * Items within 1.0 m (XZ, |Δy| ≤ 1.2) of the player's feet, in ascending id:
 *  - bomb → T only, always (bomb.state 'carried'); kit → CT without a kit, always;
 *  - weapon (primary) → `auto` (bots always; the human iff cfg.options.autoPickup): only into an EMPTY primary slot;
 *    `!auto` (the USE-press path): the nearest one is swapped in (the held primary is dropped at the feet) and drawn.
 *    Items dropped this very tick are never swap targets (no ping-pong when called twice in one tick).
 */
export function tryPickup(state: WorldState, p: PlayerState, auto: boolean, out: SimEventSink): void { pickup(state, p, auto ? 'auto' : 'use', out); }

/** Bomb (T) / kit (CT) only — for players without auto-pickup, whose weapons are taken only on a USE press. */
export function pickupObjectives(state: WorldState, p: PlayerState, out: SimEventSink): void { pickup(state, p, 'objectives', out); }

function pickup(state: WorldState, p: PlayerState, mode: 'auto' | 'use' | 'objectives', out: SimEventSink): void {
  if (!p.alive || state.items.length === 0) return;
  const auto = mode === 'auto';
  const near: ItemState[] = [];
  for (const it of state.items) {
    if (Math.hypot(it.pos.x - p.pos.x, it.pos.z - p.pos.z) <= PICKUP.radius && Math.abs(it.pos.y - p.pos.y) <= PICKUP.maxDy) near.push(it);
  }
  if (near.length === 0) return;
  near.sort((a, b) => a.id - b.id);
  let weapon: ItemState | null = null, bestD = Infinity;
  for (const it of near) {
    if (it.kind === 'bomb') {
      if (p.team !== 'T' || p.hasBomb) continue;
      removeItem(state, it.id);
      p.hasBomb = true;
      state.bomb.state = 'carried'; state.bomb.carrier = p.id; state.bomb.itemId = 0; state.bomb.pos = v3(p.pos.x, p.pos.y, p.pos.z);
      out.emit('itemPickup', { id: it.id, player: p.id, kind: 'bomb' });
      out.emit('bombPickup', { player: p.id });
      out.emit('sound', { id: 'bomb_pickup', pos: v3(p.pos.x, p.pos.y, p.pos.z), loudness: LOUDNESS.bomb_pickup, player: p.id });
    } else if (it.kind === 'kit') {
      if (p.team !== 'CT' || p.hasKit) continue;
      removeItem(state, it.id);
      p.hasKit = true;
      out.emit('itemPickup', { id: it.id, player: p.id, kind: 'kit' });
    } else if (mode !== 'objectives' && it.weapon && WEAPONS[it.weapon.id].slot === 1) {
      if (auto ? p.inv.primary !== null : it.droppedTick === state.tick) continue;
      const d = Math.hypot(it.pos.x - p.pos.x, it.pos.z - p.pos.z);
      if (d < bestD) { bestD = d; weapon = it; }
    }
  }
  if (!weapon || !weapon.weapon) return;
  removeItem(state, weapon.id);
  if (!auto && p.inv.primary) dropItem(state, p, 'weapon', out);
  p.inv.primary = weapon.weapon;
  out.emit('itemPickup', { id: weapon.id, player: p.id, kind: 'weapon' });
  if (!auto) {
    if (p.throwing) p.inv.pendingSlot = 1;
    else switchTo(p, 1, state.tick, out);
  }
}
