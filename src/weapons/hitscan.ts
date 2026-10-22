/** Hitscan against solids, players and targets. DAY-0 STUB (signature binding, §11.8); L3 implements §4.4. */
import type { Vec3 } from '../core/math';
import type { PlayerState, TargetState, EntityId, HitZone, SurfaceId } from '../sim/state';
import type { StaticWorld } from '../world/collision';
import { toSimSurface } from '../world/types';
import type { WeaponDef } from './defs';

export interface HitResult { kind: 'player' | 'target' | 'solid'; id: EntityId | 0; t: number; point: Vec3; normal: Vec3; zone: HitZone | null; surface: SurfaceId; penetrated: boolean; damageScale: number; dist: number }

/** STUB: solids only (no player hitboxes, no penetration). Ordered by t. */
export function resolveHitscan(origin: Vec3, dir: Vec3, shooter: PlayerState, players: PlayerState[], targets: TargetState[], world: StaticWorld, def: WeaponDef): HitResult[] {
  void shooter; void players; void targets; void def;
  const hit = world.raycast(origin, dir, 200);
  if (!hit) return [];
  return [{ kind: 'solid', id: 0, t: hit.t, point: hit.point, normal: hit.normal, zone: null, surface: toSimSurface(hit.surface), penetrated: false, damageScale: 1, dist: hit.t }];
}
