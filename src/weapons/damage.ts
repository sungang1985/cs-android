/** Damage model (§4.1). computeDamage is final data; applyDamage is complete (death bookkeeping per §11.6.1). */
import { v3, type Vec3 } from '../core/math';
import type { PlayerState, HitZone, WorldState, EntityId, WeaponId } from '../sim/state';
import type { SimEventSink } from '../sim/events';
import { ZONE_MULT, AWP_LEG_DAMAGE, type WeaponDef } from './defs';

export function computeDamage(def: WeaponDef, dist: number, zone: HitZone): number {
  if (def.id === 'awp' && zone === 'legs') return AWP_LEG_DAMAGE;
  return Math.round(def.dmg * Math.pow(def.falloff, dist / 10) * ZONE_MULT[zone]);
}

export function zoneArmored(victim: Pick<PlayerState, 'armor' | 'helmet'>, zone: HitZone): boolean {
  if (victim.armor <= 0) return false;
  if (zone === 'legs') return false;
  if (zone === 'head') return victim.helmet;
  return true;
}

/**
 * Applies post-falloff/zone damage with the armour rule, emits damageTaken, and on a kill does the §11.6.1 field
 * reset and pushes a DeathInfo (sim/death.ts finishes the pipeline). Dead or spawn-protected victims
 * (`invulnerableUntilTick > tick`, TDM §2.3) take nothing.
 */
export function applyDamage(
  victim: PlayerState, dmg: number, zone: HitZone, ap: number,
  src: { attacker: EntityId; weapon: WeaponId | 'bomb'; headshot: boolean; dir: Vec3; point: Vec3 },
  state: WorldState, out: SimEventSink,
): { dealt: number; armorDealt: number; killed: boolean } {
  if (!victim.alive || dmg <= 0 || victim.invulnerableUntilTick > state.tick) return { dealt: 0, armorDealt: 0, killed: false };
  let dealt = dmg, armorDealt = 0;
  if (zoneArmored(victim, zone)) {
    armorDealt = Math.ceil(dmg * (1 - ap) * 0.5);
    dealt = Math.round(dmg * ap);
    victim.armor = Math.max(0, victim.armor - armorDealt);
    if (victim.armor === 0) victim.helmet = false;
  }
  victim.hp -= dealt;
  victim.lastDamage = { tick: state.tick, from: v3(src.point.x - src.dir.x * 5, src.point.y, src.point.z - src.dir.z * 5), amount: dealt };
  out.emit('damageTaken', { victim: victim.id, from: victim.lastDamage.from, amount: dealt, hpLeft: Math.max(0, victim.hp) });
  if (victim.hp <= 0) {
    victim.hp = 0; victim.alive = false; victim.deathTick = state.tick; victim.deathDir = v3(src.dir.x, src.dir.y, src.dir.z);
    if (victim.use.action !== 'none') victim.use.action = 'none';
    victim.reload = null; victim.scoped = 0; victim.throwing = null;
    state.pendingDeaths.push({ victim: victim.id, killer: src.attacker, weapon: src.weapon, headshot: src.headshot, dir: v3(src.dir.x, src.dir.y, src.dir.z), point: v3(src.point.x, src.point.y, src.point.z) });
    return { dealt, armorDealt, killed: true };
  }
  return { dealt, armorDealt, killed: false };
}
