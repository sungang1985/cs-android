/** Grenade physics and effects. DAY-0 STUB (signatures binding); L3 implements §4.4. */
import type { Vec3 } from '../core/math';
import type { WorldState, PlayerState, EntityId } from '../sim/state';
import type { SimEventSink } from '../sim/events';
import type { StaticWorld } from '../world/collision';

export function stepGrenades(state: WorldState, world: StaticWorld, out: SimEventSink): void { void state; void world; void out; }
export function resolveHE(center: Vec3, thrower: PlayerState, players: PlayerState[], world: StaticWorld): { victim: EntityId; damage: number }[] { void center; void thrower; void players; void world; return []; }
export function resolveFlash(center: Vec3, players: PlayerState[], world: StaticWorld): { victim: EntityId; seconds: number }[] { void center; void players; void world; return []; }
