/**
 * Grenades (§4.4): launch, deterministic physics (no RNG), HE damage and flash blindness. Sphere r 0.07 m, gravity
 * 20 m/s², swept against solids with StaticWorld.raycast (×4 sub-steps above 10 m/s), restitution 0.45 along the
 * normal, tangential speed × 0.7 per bounce, slow contacts settle and roll to rest; players are ignored.
 */
import { v3, v3copy, v3norm, dirFromYawPitch, clamp, DEG, type Vec3 } from '../core/math';
import { BODY, DT, TICKS_PER_SEC, type WorldState, type PlayerState, type EntityId, type GrenadeState } from '../sim/state';
import { LOUDNESS, type SimEventSink } from '../sim/events';
import type { StaticWorld } from '../world/collision';
import { toSimSurface, type CollisionSurfaceId } from '../world/types';
import { eyePos } from '../world/movement';
import { allocId, findPlayer } from '../sim/entities';
import { GRENADE, HE, FLASH } from './defs';
import { applyDamage, zoneArmored } from './damage';
import { chestPoint, headPoint } from './hitscan';

export const GRENADE_PHYS = {
  /** below this normal speed a contact settles instead of bouncing (no bounce event) */ restSpeed: 1.0,
  /** rolling deceleration on a floor, 1/s (exponential) */ rollDamping: 3.0,
  subSteps: 4, subStepAbove: 10,
} as const;

/** Launch position and velocity for a throw at `speed` (eye, view pitched +10°). */
export function grenadeLaunch(p: Pick<PlayerState, 'pos' | 'crouched' | 'yaw' | 'pitch'>, speed: number): { pos: Vec3; vel: Vec3 } {
  const pitch = Math.min(89 * DEG, p.pitch + GRENADE.pitchUp * DEG);
  const d = dirFromYawPitch(p.yaw, pitch);
  return { pos: eyePos(p), vel: v3(d.x * speed, d.y * speed, d.z * speed) };
}

/** Creates the GrenadeState (fuse from release: HE 2.0 s, flash 1.5 s); emits grenadeThrow + he_pin. */
export function launchGrenade(state: WorldState, p: PlayerState, kind: 'he' | 'flash', speed: number, out: SimEventSink): GrenadeState {
  const { pos, vel } = grenadeLaunch(p, speed);
  const fuse = kind === 'he' ? HE.fuseSec : FLASH.fuseSec;
  const g: GrenadeState = { id: allocId(state), kind, owner: p.id, team: p.team, pos, prevPos: v3copy(pos), vel, explodeTick: state.tick + Math.round(fuse * TICKS_PER_SEC), bounces: 0 };
  state.grenades.push(g);
  out.emit('grenadeThrow', { id: g.id, kind, owner: p.id, pos: v3copy(pos) });
  out.emit('sound', { id: 'he_pin', pos: v3copy(pos), loudness: LOUDNESS.he_pin, player: p.id });
  return g;
}

type Body = Pick<GrenadeState, 'pos' | 'vel'>;
type OnBounce = (surface: CollisionSurfaceId, pos: Vec3) => void;
const DOWN = v3(0, -1, 0);

function collide(g: Body, n: Vec3, surface: CollisionSurfaceId, h: number, onBounce: OnBounce | null): void {
  const v = g.vel;
  const vn = v.x * n.x + v.y * n.y + v.z * n.z;
  if (vn >= 0) return;
  const tx = v.x - n.x * vn, ty = v.y - n.y * vn, tz = v.z - n.z * vn;
  if (-vn >= GRENADE_PHYS.restSpeed) {
    const e = GRENADE.restitution, f = GRENADE.friction;
    v.x = tx * f - n.x * vn * e; v.y = ty * f - n.y * vn * e; v.z = tz * f - n.z * vn * e;
    if (onBounce) onBounce(surface, g.pos);
  } else {
    const k = n.y > 0.7 ? Math.exp(-GRENADE_PHYS.rollDamping * h) : 1;
    v.x = tx * k; v.y = ty * k; v.z = tz * k;
  }
}

/** Moves the sphere by vel·h with up to 3 contacts. */
function sweep(g: Body, h: number, world: StaticWorld, onBounce: OnBounce | null): void {
  const R = GRENADE.radius;
  let remaining = h;
  for (let iter = 0; iter < 3 && remaining > 1e-9; iter++) {
    const v = g.vel, sp = Math.hypot(v.x, v.y, v.z);
    if (sp < 1e-6) return;
    const len = sp * remaining, dx = v.x / sp, dy = v.y / sp, dz = v.z / sp;
    const hit = world.raycast(g.pos, v3(dx, dy, dz), len + 3 * R);
    const dn = hit ? dx * hit.normal.x + dy * hit.normal.y + dz * hit.normal.z : 0;
    let s = len;
    if (hit && dn < -1e-6) {
      const d0 = (g.pos.x - hit.point.x) * hit.normal.x + (g.pos.y - hit.point.y) * hit.normal.y + (g.pos.z - hit.point.z) * hit.normal.z;
      s = clamp((R - d0) / dn, 0, len + 1);
    }
    if (!hit || dn >= -1e-6 || s >= len) { g.pos.x += dx * len; g.pos.y += dy * len; g.pos.z += dz * len; return; }
    g.pos.x += dx * s; g.pos.y += dy * s; g.pos.z += dz * s;
    collide(g, hit.normal, hit.surface, h, onBounce);
    remaining *= 1 - s / len;
  }
}

/** Keeps the sphere on top of the floor under it and settles slow vertical motion. */
function support(g: Body, h: number, world: StaticWorld, onBounce: OnBounce | null): void {
  const R = GRENADE.radius;
  if (world.groundY !== null && g.pos.y < world.groundY + R) {
    g.pos.y = world.groundY + R;
    collide(g, v3(0, 1, 0), 'ground', h, onBounce);
    return;
  }
  const hit = world.raycast(g.pos, DOWN, R + 0.02);
  if (!hit || hit.normal.y < 0.7) return;
  if (g.pos.y - hit.point.y < R) g.pos.y = hit.point.y + R;
  if (g.vel.y <= 0 && -g.vel.y < GRENADE_PHYS.restSpeed) collide(g, hit.normal, hit.surface, h, null);
}

/** One 60 Hz tick of grenade physics (deterministic). */
export function integrateGrenade(g: Body & { prevPos?: Vec3 }, world: StaticWorld, onBounce: OnBounce | null = null): void {
  if (g.prevPos) { g.prevPos.x = g.pos.x; g.prevPos.y = g.pos.y; g.prevPos.z = g.pos.z; }
  const speed = Math.hypot(g.vel.x, g.vel.y, g.vel.z);
  const n = speed > GRENADE_PHYS.subStepAbove ? GRENADE_PHYS.subSteps : 1, h = DT / n;
  for (let k = 0; k < n; k++) {
    g.vel.y -= GRENADE.gravity * h;
    sweep(g, h, world, onBounce);
    support(g, h, world, onBounce);
  }
}

/** Predicted path (one point per tick) for AI planning / previews; no events, no state changes. */
export function predictGrenade(world: StaticWorld, pos: Vec3, vel: Vec3, ticks: number): Vec3[] {
  const g: Body = { pos: v3copy(pos), vel: v3copy(vel) };
  const pts: Vec3[] = [];
  for (let i = 0; i < ticks; i++) { integrateGrenade(g, world); pts.push(v3copy(g.pos)); }
  return pts;
}

/** Steps every grenade (ascending id); detonates those whose fuse expired. Called by sim.ts step 5. */
export function stepGrenades(state: WorldState, world: StaticWorld, out: SimEventSink): void {
  if (state.grenades.length === 0) return;
  const live = state.grenades.slice();
  state.grenades.length = 0;
  for (const g of live) {
    if (state.tick >= g.explodeTick) { explode(g, state, world, out); continue; }
    integrateGrenade(g, world, (surface, pos) => {
      g.bounces++;
      const sim = toSimSurface(surface);
      out.emit('grenadeBounce', { id: g.id, pos: v3copy(pos), surface: sim });
      out.emit('sound', { id: 'he_bounce', pos: v3copy(pos), loudness: LOUDNESS.he_bounce, player: g.owner });
    });
    state.grenades.push(g);
  }
}

function explode(g: GrenadeState, state: WorldState, world: StaticWorld, out: SimEventSink): void {
  const pos = v3copy(g.pos);
  out.emit('grenadeExplode', { id: g.id, kind: g.kind, pos });
  out.emit('sound', { id: g.kind === 'he' ? 'he_explode' : 'flash_explode', pos: v3copy(pos), loudness: g.kind === 'he' ? LOUDNESS.he_explode : LOUDNESS.flash_explode, player: g.owner });
  if (g.kind === 'he') {
    const thrower = findPlayer(state, g.owner);
    if (!thrower) return;
    for (const { victim, damage } of resolveHE(pos, thrower, state.players, world)) {
      const v = findPlayer(state, victim)!;
      const point = chestPoint(v);
      const d = v3norm(v3(point.x - pos.x, point.y - pos.y, point.z - pos.z));
      const dir = d.x === 0 && d.y === 0 && d.z === 0 ? v3(0, 1, 0) : d;
      const armored = zoneArmored(v, 'chest');
      const r = applyDamage(v, damage, 'chest', HE.ap, { attacker: g.owner, weapon: 'he', headshot: false, dir, point }, state, out);
      if (r.dealt > 0 || r.armorDealt > 0) out.emit('hit', { attacker: g.owner, victim, weapon: 'he', zone: 'chest', damage: r.dealt, armored, point: v3copy(point) });
      if (victim !== thrower.id) thrower.stats.damage += r.dealt;
    }
  } else {
    for (const { victim, seconds } of resolveFlash(pos, state.players, world)) {
      const v = findPlayer(state, victim)!;
      v.blindUntilTick = Math.max(v.blindUntilTick, state.tick + Math.round(seconds * TICKS_PER_SEC));
      out.emit('blinded', { player: victim, seconds });
    }
  }
}

/** HE damage at `dist` m from the burst: 98 · max(0, 1 − dist / 3.5), rounded. */
export function heDamageAt(dist: number): number { return Math.round(HE.dmg * Math.max(0, 1 - dist / HE.radius)); }

/** Distance from `c` to the nearest point of a player's body AABB (feet-centred, 0.3 m half-width). */
export function distToBody(c: Vec3, p: Pick<PlayerState, 'pos' | 'crouched'>): number {
  const h = p.crouched ? BODY.crouchHeight : BODY.standHeight, hw = BODY.halfWidth;
  const dx = Math.max(p.pos.x - hw - c.x, 0, c.x - (p.pos.x + hw));
  const dy = Math.max(p.pos.y - c.y, 0, c.y - (p.pos.y + h));
  const dz = Math.max(p.pos.z - hw - c.z, 0, c.z - (p.pos.z + hw));
  return Math.hypot(dx, dy, dz);
}

/**
 * HE victims (§4.4): every alive enemy of the thrower — and the thrower (self-damage on) — whose chest or head has LOS
 * from the burst centre, damage by distance to the body. Teammates are skipped.
 */
export function resolveHE(center: Vec3, thrower: PlayerState, players: PlayerState[], world: StaticWorld): { victim: EntityId; damage: number }[] {
  const res: { victim: EntityId; damage: number }[] = [];
  for (const v of players) {
    if (!v.alive || (v.id !== thrower.id && v.team === thrower.team)) continue;
    const dmg = heDamageAt(distToBody(center, v));
    if (dmg <= 0) continue;
    if (!world.lineOfSight(center, chestPoint(v)) && !world.lineOfSight(center, headPoint(v))) continue;
    res.push({ victim: v.id, damage: dmg });
  }
  return res;
}

/** Blind seconds: 3.0 · clamp(cos α, 0, 1)^0.7 · clamp(1 − dist / 20, 0.25, 1). */
export function flashSeconds(dist: number, cosAlpha: number): number {
  if (dist > FLASH.range) return 0;
  return FLASH.maxSec * Math.pow(clamp(cosAlpha, 0, 1), 0.7) * clamp(1 - dist / FLASH.range, 0.25, 1);
}

/** Flash victims (§4.4): every alive player (both teams) within 20 m whose eye has LOS to the burst. */
export function resolveFlash(center: Vec3, players: PlayerState[], world: StaticWorld): { victim: EntityId; seconds: number }[] {
  const res: { victim: EntityId; seconds: number }[] = [];
  for (const v of players) {
    if (!v.alive) continue;
    const eye = eyePos(v);
    const tx = center.x - eye.x, ty = center.y - eye.y, tz = center.z - eye.z, dist = Math.hypot(tx, ty, tz);
    if (dist > FLASH.range || !world.lineOfSight(center, eye)) continue;
    const f = dirFromYawPitch(v.yaw, v.pitch);
    const cosA = dist > 1e-6 ? (f.x * tx + f.y * ty + f.z * tz) / dist : 1;
    const s = flashSeconds(dist, cosA);
    if (s > 0) res.push({ victim: v.id, seconds: s });
  }
  return res;
}
