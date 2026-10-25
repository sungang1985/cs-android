/**
 * Hitscan (§4.4): player hitboxes in the victim's yaw-local frame, training targets, solids with ≤ 1 penetration.
 * Pure and deterministic (players iterate in ascending id; exact ties keep the lower id). Hitbox geometry is exported
 * (in defs.ts, importable by adapters) so the renderer (debug draw) and tests use the same numbers.
 */
import { v3, raySphere, aabbFaceNormal, type Vec3, type Aabb } from '../core/math';
import type { PlayerState, TargetState, EntityId, HitZone, SurfaceId } from '../sim/state';
import { rayAabbRange, type StaticWorld, type RayHit } from '../world/collision';
import { toSimSurface } from '../world/types';
import { HITBOX, TARGET_BOX, hitboxesFor, type WeaponDef } from './defs';

export { HITBOX, TARGET_BOX, hitboxesFor };
export type { HitBox, PlayerHitboxes } from './defs';

export interface HitResult {
  kind: 'player' | 'target' | 'solid'; id: EntityId | 0; t: number; point: Vec3; normal: Vec3; zone: HitZone | null; surface: SurfaceId;
  /** this hit came after a penetration */ penetrated: boolean;
  /** 1 or the penetration factor */ damageScale: number; dist: number;
}

export const HITSCAN = {
  range: 200,
  /** max thickness along the ray of a penetrable prop */ maxPenThickness: 1.2,
  /** tall crates (`X`, one 2 × 2 m cell, ≤ 2.83 m on a diagonal) stop everything except `penetratesTallCrate` weapons (AWP), which pass one crate */ maxTallCrateThickness: 3.0,
  nearMiss: 1.5,
} as const;

export function headPoint(p: Pick<PlayerState, 'pos' | 'crouched'>, out: Vec3 = v3()): Vec3 { out.x = p.pos.x; out.y = p.pos.y + (p.crouched ? HITBOX.headYCrouch : HITBOX.headY); out.z = p.pos.z; return out; }
/** Centre of the chest box. */
export function chestPoint(p: Pick<PlayerState, 'pos' | 'crouched'>, out: Vec3 = v3()): Vec3 {
  const t = p.crouched ? HITBOX.torsoCrouch : HITBOX.torso;
  out.x = p.pos.x; out.y = p.pos.y + t.y1 - (t.y1 - t.y0) * HITBOX.chestFrac * 0.5; out.z = p.pos.z; return out;
}

export interface ActorHit { t: number; zone: HitZone; point: Vec3; normal: Vec3 }

/** Ray vs one player's hitboxes (optionally inflated, for the knife sphere-cast); nearest entry in [tMin, tMax]. */
export function rayVsPlayer(origin: Vec3, dir: Vec3, p: Pick<PlayerState, 'pos' | 'yaw' | 'crouched'>, tMax: number, tMin = 0, inflate = 0): ActorHit | null {
  const c = Math.cos(p.yaw), s = Math.sin(p.yaw);
  // world → local: right R = (c, 0, −s), back B = (s, 0, c)
  const dx = origin.x - p.pos.x, dy = origin.y - p.pos.y, dz = origin.z - p.pos.z;
  const lo = v3(dx * c - dz * s, dy, dx * s + dz * c);
  const ld = v3(dir.x * c - dir.z * s, dir.y, dir.x * s + dir.z * c);
  const hb = hitboxesFor(p, inflate);
  let best = Infinity, zone: HitZone = 'chest', ln = v3();
  const th = raySphere(lo, ld, hb.head.center, hb.head.radius, tMax);
  if (th !== null && th >= tMin) {
    best = th; zone = 'head';
    ln = v3((lo.x + ld.x * th - hb.head.center.x) / hb.head.radius, (lo.y + ld.y * th - hb.head.center.y) / hb.head.radius, (lo.z + ld.z * th - hb.head.center.z) / hb.head.radius);
  }
  for (const b of hb.boxes) {
    const r = rayAabbRange(lo, ld, b, tMax);
    if (!r || r[0] < tMin || r[0] >= best) continue;
    best = r[0]; zone = b.zone;
    ln = aabbFaceNormal(b, v3(lo.x + ld.x * best, lo.y + ld.y * best, lo.z + ld.z * best));
  }
  if (best === Infinity) return null;
  // local normal → world: x·R + y·up + z·B
  const normal = v3(ln.x * c + ln.z * s, ln.y, -ln.x * s + ln.z * c);
  return { t: best, zone, point: v3(origin.x + dir.x * best, origin.y + dir.y * best, origin.z + dir.z * best), normal };
}

export function targetBox(tg: Pick<TargetState, 'pos'>, inflate = 0): Aabb {
  return { min: v3(tg.pos.x - TARGET_BOX.halfX - inflate, tg.pos.y - inflate, tg.pos.z - TARGET_BOX.halfZ - inflate), max: v3(tg.pos.x + TARGET_BOX.halfX + inflate, tg.pos.y + TARGET_BOX.height + inflate, tg.pos.z + TARGET_BOX.halfZ + inflate) };
}

/** Coarse reject: the ray passes farther than 1.4 m from the body's mid-point (or the body is behind the origin). */
function farFromRay(origin: Vec3, dir: Vec3, pos: Vec3, tMax: number): boolean {
  const wx = pos.x - origin.x, wy = pos.y + 0.9 - origin.y, wz = pos.z - origin.z;
  const tc = wx * dir.x + wy * dir.y + wz * dir.z;
  if (tc < -1.4 || tc > tMax + 1.4) return true;
  const ex = wx - dir.x * tc, ey = wy - dir.y * tc, ez = wz - dir.z * tc;
  return ex * ex + ey * ey + ez * ez > 1.4 * 1.4;
}

type ActorResult = { kind: 'player' | 'target'; id: EntityId; hit: ActorHit };

/** Nearest enemy player or up target entered in [tMin, tMax). Teammates and the shooter are skipped (friendly fire off). */
export function nearestActor(origin: Vec3, dir: Vec3, shooter: Pick<PlayerState, 'id' | 'team'>, players: readonly PlayerState[], targets: readonly TargetState[], tMin: number, tMax: number, inflate = 0): ActorResult | null {
  let best: ActorResult | null = null, bestT = tMax;
  for (const p of players) {
    if (!p.alive || p.id === shooter.id || p.team === shooter.team) continue;
    if (farFromRay(origin, dir, p.pos, bestT)) continue;
    const h = rayVsPlayer(origin, dir, p, bestT, tMin, inflate);
    if (h && h.t < bestT) { best = { kind: 'player', id: p.id, hit: h }; bestT = h.t; }
  }
  for (const tg of targets) {
    if (!tg.up) continue;
    const box = targetBox(tg, inflate);
    const r = rayAabbRange(origin, dir, box, bestT);
    if (!r || r[0] < tMin || r[0] >= bestT) continue;
    const point = v3(origin.x + dir.x * r[0], origin.y + dir.y * r[0], origin.z + dir.z * r[0]);
    best = { kind: 'target', id: tg.id, hit: { t: r[0], zone: 'chest', point, normal: aabbFaceNormal(box, point) } };
    bestT = r[0];
  }
  return best;
}

/** Kinds that stop every bullet regardless of data flags (walls, lips, lintels, slabs, steps, ceiling, seals). */
function stopsEverything(kind: string | undefined): boolean {
  return kind === 'wall' || kind === 'lip' || kind === 'lintel' || kind === 'platform' || kind === 'ramp-step' || kind === 'ceiling' || kind === 'seal';
}

/** Damage factor if `def` may continue through the solid hit `h`, else null. */
export function penetrationFactor(h: RayHit, def: Pick<WeaponDef, 'penetration' | 'penetratesTallCrate'>): number | null {
  const s = h.solid;
  if (def.penetration === null || !s || !s.penetrable || stopsEverything(s.kind)) return null;
  const thick = h.tExit - h.t;
  if (s.kind === 'tallcrate') { if (!def.penetratesTallCrate || thick > HITSCAN.maxTallCrateThickness + 1e-6) return null; }
  else if (thick > HITSCAN.maxPenThickness + 1e-6) return null;
  const f = s.penetrationFactor;
  return f !== undefined && f > 0 ? Math.min(def.penetration, f) : def.penetration;
}

/** resolveHitscan plus the distance at which the bullet stopped (range when it flew out). */
export function traceShot(origin: Vec3, dir: Vec3, shooter: PlayerState, players: readonly PlayerState[], targets: readonly TargetState[], world: StaticWorld, def: WeaponDef): { hits: HitResult[]; stopT: number } {
  const range: number = HITSCAN.range;
  const solids = world.raycastAll(origin, dir, range);
  const hits: HitResult[] = [];
  let segStart = 0, scale = 1, penetrated = false, i = 0;
  for (let seg = 0; seg < 2; seg++) {
    let solid: RayHit | null = null, solidT = range;
    for (; i < solids.length; i++) {
      const h = solids[i];
      if (h.solid !== null && h.tExit <= segStart + 1e-6) continue; // inside/behind the penetrated prop
      solid = h; solidT = Math.max(h.t, segStart); break;
    }
    const actor = nearestActor(origin, dir, shooter, players, targets, segStart, solidT);
    if (actor) {
      const a = actor.hit;
      hits.push({ kind: actor.kind, id: actor.id, t: a.t, point: a.point, normal: a.normal, zone: actor.kind === 'player' ? a.zone : null, surface: 'concrete', penetrated, damageScale: scale, dist: a.t });
      return { hits, stopT: a.t };
    }
    if (!solid) return { hits, stopT: range };
    const point = solidT === solid.t ? v3(solid.point.x, solid.point.y, solid.point.z) : v3(origin.x + dir.x * solidT, origin.y + dir.y * solidT, origin.z + dir.z * solidT);
    hits.push({ kind: 'solid', id: 0, t: solidT, point, normal: v3(solid.normal.x, solid.normal.y, solid.normal.z), zone: null, surface: toSimSurface(solid.surface), penetrated, damageScale: scale, dist: solidT });
    const f = seg === 0 ? penetrationFactor(solid, def) : null;
    if (f === null) return { hits, stopT: solidT };
    penetrated = true; scale = f; segStart = solid.tExit; i++;
  }
  return { hits, stopT: range };
}

/** All hits along the shot ordered by t (§4.4): ≤ 1 penetration, stops at the first player/target; max range 200 m. */
export function resolveHitscan(origin: Vec3, dir: Vec3, shooter: PlayerState, players: PlayerState[], targets: TargetState[], world: StaticWorld, def: WeaponDef): HitResult[] {
  return traceShot(origin, dir, shooter, players, targets, world, def).hits;
}

/** Closest point of the segment origin + dir·[0, len] to `p`; returns the parameter (or −1 if p is behind the origin). */
export function closestOnRay(origin: Vec3, dir: Vec3, len: number, p: Vec3, out: Vec3): number {
  const t = (p.x - origin.x) * dir.x + (p.y - origin.y) * dir.y + (p.z - origin.z) * dir.z;
  if (t <= 0) return -1;
  const tc = Math.min(t, len);
  out.x = origin.x + dir.x * tc; out.y = origin.y + dir.y * tc; out.z = origin.z + dir.z * tc;
  return tc;
}
