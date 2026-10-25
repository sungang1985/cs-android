/** Inventory helpers (slots, active weapon, ammo, weapon switching). Pure. */
import { v3 } from '../core/math';
import type { PlayerState, WeaponId, Slot, WeaponSlotState, Inventory } from '../sim/state';
import { TICKS_PER_SEC } from '../sim/state';
import { LOUDNESS, type SimEventSink } from '../sim/events';
import { WEAPONS } from './defs';

/**
 * Per-player input memory the weapon state machine needs beyond the frozen PlayerState fields. Stored as plain own
 * properties on the PlayerState object, so it is serialised, hashed, cloned and restored with the WorldState
 * (see the L3 integration note: these should become declared PlayerState fields).
 *   prevButtons — the InputCommand.buttons of the previous weapon tick (press edges for SCOPE / THROW / DROP);
 *   rescope     — AWP zoom level to restore when the bolt cycle ends (0 = none);
 *   shotTicks   — per-weapon cooldown base: the `lastShotTick` value each weapon id last wrote. The fire gates read
 *                 the held weapon's own entry, so one weapon's cycle (AWP bolt, knife stab recovery) never blocks
 *                 another, while switching away and back cannot skip it. Missing entry = never attacked.
 */
export interface WeaponMemory { prevButtons?: number; rescope?: 0 | 1 | 2; shotTicks?: Partial<Record<WeaponId, number>> }
export type WeaponPlayer = PlayerState & WeaponMemory;

/** Tick the cooldown of weapon `id` counts from (its own last attack; -1000 = never). */
export function shotTickOf(p: PlayerState, id: WeaponId): number {
  const t = (p as WeaponPlayer).shotTicks?.[id];
  return t === undefined ? -1000 : t;
}
/** Records an attack of weapon `id` (sets `lastShotTick` and the per-weapon cooldown base). */
export function setShotTick(p: PlayerState, id: WeaponId, tick: number): void {
  const w = p as WeaponPlayer;
  p.lastShotTick = tick;
  (w.shotTicks ??= {})[id] = tick;
}

/** Owned grenade kind for slot 4: the selected one if owned, else the other, else the selection (empty hand). */
export function grenadeKind(inv: Inventory): 'he' | 'flash' {
  const sel = inv.selectedGrenade, other = sel === 'he' ? 'flash' : 'he';
  return inv[sel] > 0 ? sel : inv[other] > 0 ? other : sel;
}

/** Weapon id currently held (grenade slot → the selected grenade if owned, else the other one). */
export function activeWeaponId(p: PlayerState): WeaponId {
  const inv = p.inv;
  switch (inv.active) {
    case 1: return inv.primary ? inv.primary.id : inv.pistol.id;
    case 2: return inv.pistol.id;
    case 3: return 'knife';
    case 4: return grenadeKind(inv);
  }
}
export function activeSlotState(p: PlayerState): WeaponSlotState | null {
  const inv = p.inv;
  if (inv.active === 1) return inv.primary;
  if (inv.active === 2) return inv.pistol;
  return null;
}
export function hasSlot(inv: Inventory, slot: Slot): boolean {
  switch (slot) {
    case 1: return inv.primary !== null;
    case 2: return true;
    case 3: return true;
    case 4: return inv.he > 0 || inv.flash > 0;
  }
}
/** Best remaining gun slot: primary if owned, else pistol. */
export function bestSlot(inv: Inventory): Slot { return inv.primary ? 1 : 2; }
export function giveWeapon(p: PlayerState, id: WeaponId): void {
  const def = WEAPONS[id];
  if (def.slot === 1) p.inv.primary = { id, mag: def.mag, reserve: def.reserve };
  else if (def.slot === 2) p.inv.pistol = { id, mag: def.mag, reserve: def.reserve };
  else if (id === 'he') p.inv.he = Math.min(def.maxCarry ?? 1, p.inv.he + 1);
  else if (id === 'flash') p.inv.flash = Math.min(def.maxCarry ?? 2, p.inv.flash + 1);
}
export function nextSlotCycle(inv: Inventory): Slot {
  const order: Slot[] = [1, 2, 3];
  const i = order.indexOf(inv.active as Slot);
  for (let k = 1; k <= 3; k++) { const s = order[(i + k) % 3]; if (hasSlot(inv, s)) return s; }
  return 3;
}

/**
 * Makes `slot` active now and starts its deploy (§4.1 timings: 0.5 s, knife 0.25 s, or `ticks`): the weapon cannot
 * act before `inv.switchEndsTick`. Cancels a reload and the AWP scope; emits weaponSwitch + switch_weapon.
 * `inv.active` always names the weapon in hand (the one being deployed); `pendingSlot` is managed by the caller.
 */
export function switchTo(p: PlayerState, slot: Slot, tick: number, out: SimEventSink, ticks?: number): void {
  const inv = p.inv;
  inv.active = slot;
  if (slot === 4) inv.selectedGrenade = grenadeKind(inv);
  const id = activeWeaponId(p);
  inv.switchEndsTick = tick + (ticks ?? Math.round(WEAPONS[id].switchSec * TICKS_PER_SEC));
  p.reload = null; p.scoped = 0; (p as WeaponPlayer).rescope = 0;
  out.emit('weaponSwitch', { player: p.id, weapon: id });
  out.emit('sound', { id: 'switch_weapon', pos: v3(p.pos.x, p.pos.y, p.pos.z), loudness: LOUDNESS.switch, player: p.id });
}
