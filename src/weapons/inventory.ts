/** Inventory helpers (slots, active weapon, ammo). Pure. */
import type { PlayerState, WeaponId, Slot, WeaponSlotState, Inventory } from '../sim/state';
import { WEAPONS } from './defs';

/** Weapon id currently held (grenade slot → the selected grenade if owned, else knife). */
export function activeWeaponId(p: PlayerState): WeaponId {
  const inv = p.inv;
  switch (inv.active) {
    case 1: return inv.primary ? inv.primary.id : inv.pistol.id;
    case 2: return inv.pistol.id;
    case 3: return 'knife';
    case 4: return inv.selectedGrenade === 'he' ? (inv.he > 0 ? 'he' : inv.flash > 0 ? 'flash' : 'knife') : (inv.flash > 0 ? 'flash' : inv.he > 0 ? 'he' : 'knife');
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
