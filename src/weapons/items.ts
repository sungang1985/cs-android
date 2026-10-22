/** World items: dropped weapons, bomb, defuse kit. DAY-0 STUB (signatures binding); L3 implements §4.4. */
import { v3 } from '../core/math';
import type { WorldState, PlayerState, ItemState } from '../sim/state';
import type { SimEventSink } from '../sim/events';
import { allocId } from '../sim/entities';

export function dropItem(state: WorldState, p: PlayerState, kind: ItemState['kind'], out: SimEventSink): void {
  if (kind === 'weapon') {
    if (!p.inv.primary) return;
    const item: ItemState = { id: allocId(state), kind: 'weapon', weapon: p.inv.primary, pos: v3(p.pos.x, p.pos.y, p.pos.z), yaw: p.yaw, droppedTick: state.tick };
    p.inv.primary = null; if (p.inv.active === 1) p.inv.active = 2;
    state.items.push(item);
    out.emit('itemDrop', { id: item.id, kind: 'weapon', pos: v3(item.pos.x, item.pos.y, item.pos.z) });
  } else if (kind === 'bomb') {
    if (!p.hasBomb) return;
    const item: ItemState = { id: allocId(state), kind: 'bomb', pos: v3(p.pos.x, p.pos.y, p.pos.z), yaw: p.yaw, droppedTick: state.tick };
    p.hasBomb = false; state.items.push(item);
    state.bomb.state = 'dropped'; state.bomb.carrier = 0; state.bomb.itemId = item.id; state.bomb.pos = v3(item.pos.x, item.pos.y, item.pos.z);
    out.emit('itemDrop', { id: item.id, kind: 'bomb', pos: v3(item.pos.x, item.pos.y, item.pos.z) });
    out.emit('bombDrop', { pos: v3(item.pos.x, item.pos.y, item.pos.z) });
  }
}

export function tryPickup(state: WorldState, p: PlayerState, auto: boolean, out: SimEventSink): void { void state; void p; void auto; void out; }
