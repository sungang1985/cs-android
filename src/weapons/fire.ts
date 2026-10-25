/**
 * Spread / recoil / firing state machine (§4.2–4.4): trigger semantics, hitscan shots, knife, reload, weapon switch,
 * AWP scope + bolt, throw protocol, DROP. Pure; randomness only through the RngStreams handle (spread cones from
 * `spread`, recoil jitter from `fire`). Called by sim.ts step 4 for every alive, non-frozen player in ascending id.
 */
import { v3, v3copy, v3norm, v3dot, dirFromYawPitch, forwardXZ, DEG, type Vec3 } from '../core/math';
import type { Rng, RngStreams } from '../core/rng';
import { Btn, DT, TICKS_PER_SEC, type PlayerState, type InputCommand, type WorldState, type WeaponSlotState, type Slot, type WeaponId, type HitZone } from '../sim/state';
import { LOUDNESS, type SimEventSink, type SoundId } from '../sim/events';
import type { StaticWorld } from '../world/collision';
import { eyePos } from '../world/movement';
import { findPlayer } from '../sim/entities';
import { WEAPONS, AWP_BOLT_SEC, GRENADE, type WeaponDef } from './defs';
import { activeWeaponId, activeSlotState, hasSlot, bestSlot, switchTo, grenadeKind, type WeaponPlayer } from './inventory';
import { traceShot, nearestActor, headPoint, chestPoint, closestOnRay, HITSCAN } from './hitscan';
import { computeDamage, applyDamage, zoneArmored } from './damage';
import { launchGrenade } from './grenade';
import { dropItem } from './items';

export const FIRE = {
  /** reload `mid` phase (mag in, reload_in) as a fraction of the reload */ reloadMidFrac: 0.5,
  /** throw protocol switch to slot 4 */ throwSwitchTicks: 15,
  /** switch back this many ticks after release */ throwReturnTicks: 30,
  /** forced release */ throwMaxHoldTicks: 180,
  knifeReach: 1.2, knifeRadius: 0.3, /** half-angle of the 60° cone */ knifeConeDeg: 30, backstabDeg: 60,
  /** a hit training target stays down this long (pop-back is rules/modes training tick) */ targetDownTicks: 120,
  /** DROP tosses the weapon this far ahead (out of the 1 m pickup radius) */ dropToss: 1.2,
} as const;

const FIRE_SOUND: Partial<Record<WeaponId, SoundId>> = { glock: 'fire_glock', usp: 'fire_usp', deagle: 'fire_deagle', mp5: 'fire_mp5', ak47: 'fire_ak', m4a4: 'fire_m4', awp: 'fire_awp' };
export function fireLoudness(def: WeaponDef): number {
  return def.type === 'sniper' ? LOUDNESS.fire_awp : def.type === 'smg' ? LOUDNESS.fire_smg : def.type === 'rifle' ? LOUDNESS.fire_rifle : LOUDNESS.fire_pistol;
}

// ───────── spread & recoil (§4.2, §4.3) ─────────

/** Cone half-angle in degrees (§4.2). Scoped AWP: σ_scoped / σ_scopedMove, crouched scoped = 0.8 · σ_scoped (0.04°). */
export function computeSpread(def: WeaponDef, p: Pick<PlayerState, 'vel' | 'crouched' | 'grounded' | 'heat' | 'scoped'>): number {
  const speed = Math.hypot(p.vel.x, p.vel.z);
  const sp = def.spread;
  const scoped = p.scoped !== 0 && sp.scoped !== undefined;
  const stand = scoped ? sp.scoped! : sp.stand;
  const move = scoped && sp.scopedMove !== undefined ? sp.scopedMove : sp.move;
  const crouch = scoped ? sp.scoped! * 0.8 : sp.crouch;
  const pose = speed < 0.3 ? (p.crouched ? crouch : stand) : stand + (move - stand) * Math.min(1, speed / def.speed);
  return pose * (1 + (p.grounded ? 0 : 3.0)) + def.perShot * p.heat;
}

export function applyRecoil(p: PlayerState, def: WeaponDef, rng: Rng): void {
  const idx = Math.min(Math.floor(p.shotIndex), def.pattern.length - 1);
  const [pitch, yaw] = def.pattern[idx];
  const jitter = 1 + rng.gauss(0, 0.08);
  p.aimOffset.pitch = Math.min(12 * DEG, p.aimOffset.pitch + pitch * DEG * jitter);
  p.aimOffset.yaw = Math.max(-6 * DEG, Math.min(6 * DEG, p.aimOffset.yaw + yaw * DEG * jitter));
  p.shotIndex += 1;
  p.heat += 1;
}

export function recoverRecoil(p: PlayerState, def: WeaponDef): void {
  const k = Math.exp(-DT / 0.45);
  p.aimOffset.pitch *= k; p.aimOffset.yaw *= k;
  if (Math.abs(p.aimOffset.pitch) < 1e-5) p.aimOffset.pitch = 0;
  if (Math.abs(p.aimOffset.yaw) < 1e-5) p.aimOffset.yaw = 0;
  p.heat = Math.max(0, p.heat - def.heatRecover * DT);
  if (!p.triggerHeld) p.shotIndex = Math.max(0, p.shotIndex - def.patternRecovery * DT);
}

/**
 * Shot direction: dir(yaw + aimOffset.yaw, pitch + aimOffset.pitch) rotated by a random offset uniform over the disc of
 * angular radius spreadDeg (ρ = θ·√u1, φ = 2π·u2), built in the tangent plane so the cone is round at any pitch.
 */
export function sampleShotDir(yaw: number, pitch: number, aimOffset: { yaw: number; pitch: number }, spreadDeg: number, rng: Rng): Vec3 {
  const u1 = rng.next(), u2 = rng.next();
  const rho = spreadDeg * DEG * Math.sqrt(u1), phi = 2 * Math.PI * u2;
  const y = yaw + aimOffset.yaw, pt = pitch + aimOffset.pitch;
  const c = dirFromYawPitch(y, pt);
  if (rho === 0) return c;
  const sy = Math.sin(y), cy = Math.cos(y), sp = Math.sin(pt), cp = Math.cos(pt);
  const a = Math.sin(rho) * Math.cos(phi), b = Math.sin(rho) * Math.sin(phi), k = Math.cos(rho);
  // L = ∂dir/∂yaw normalised = (−cos y, 0, sin y); U = ∂dir/∂pitch = (sin y sin p, cos p, cos y sin p)
  return v3norm(v3(c.x * k - cy * a + sy * sp * b, c.y * k + cp * b, c.z * k + sy * a + cy * sp * b));
}

/** Ticks between shots: 60/RPM s (fractional), AWP at least the 1.46 s bolt. */
export function cycleTicks(def: WeaponDef): number {
  const t = (60 / def.rpm) * TICKS_PER_SEC;
  return def.id === 'awp' ? Math.max(t, AWP_BOLT_SEC * TICKS_PER_SEC) : t;
}

// ───────── tickWeapon ─────────

/**
 * One weapon tick (§4.4). Order: grenade selection → DROP → slot switch / post-throw return → throw protocol →
 * reload request & progress → AWP bolt/re-scope → scope toggle → fire (gun or knife). Every action waits for
 * `inv.switchEndsTick` (switch 0.5 s / knife 0.25 s / deploy after purchase 1.0 s, set by economy.buy).
 */
export function tickWeapon(p: PlayerState, cmd: InputCommand, state: WorldState, world: StaticWorld, rng: RngStreams, out: SimEventSink): void {
  const w = p as WeaponPlayer;
  const b = cmd.buttons, prev = w.prevButtons ?? 0, tick = state.tick;
  const inv = p.inv;
  if (p.alive) {
    if (cmd.grenade === 1) inv.selectedGrenade = 'he'; else if (cmd.grenade === 2) inv.selectedGrenade = 'flash';

    if ((b & Btn.DROP) && !(prev & Btn.DROP) && inv.primary && !p.throwing) {
      const wasActive = inv.active === 1;
      dropItem(state, p, 'weapon', out, tossPoint(p, world));
      if (wasActive) switchTo(p, 2, tick, out);
    }

    if (cmd.slot !== 0) requestSlot(p, cmd.slot, tick, out);
    if (!p.throwing && inv.pendingSlot !== 0 && tick >= inv.switchEndsTick) {
      const s = hasSlot(inv, inv.pendingSlot) ? inv.pendingSlot : bestSlot(inv);
      inv.pendingSlot = 0;
      switchTo(p, s, tick, out, s === 4 ? FIRE.throwSwitchTicks : undefined);
    }

    tickThrow(p, b, prev, state, out);

    const id = activeWeaponId(p), def = WEAPONS[id];
    if (id !== 'awp') { p.scoped = 0; w.rescope = 0; }
    const ready = tick >= inv.switchEndsTick && !p.throwing && inv.pendingSlot === 0;
    const ws = activeSlotState(p);
    if (ws) {
      if ((b & Btn.RELOAD) && !p.reload && !p.throwing && ws.mag < def.mag && ws.reserve > 0) {
        const start = Math.max(tick, inv.switchEndsTick);
        p.reload = { startTick: start, endTick: start + Math.round(def.reloadSec * TICKS_PER_SEC), weapon: ws.id };
        p.scoped = 0; w.rescope = 0;
      }
      if (p.reload) tickReload(p, ws, def, tick, out);
      if (id === 'awp') {
        const boltEnd = p.lastShotTick + cycleTicks(def), boltDone = tick >= boltEnd - 1e-6;
        // re-scope exactly when the bolt ends; a stale request (bolt ended during a freeze / round change) expires
        if (boltDone && (w.rescope ?? 0) > 0) { if (!p.reload && tick < boltEnd + 2) p.scoped = w.rescope!; w.rescope = 0; }
        if ((b & Btn.SCOPE) && !(prev & Btn.SCOPE) && ready && !p.reload && boltDone) p.scoped = ((p.scoped + 1) % 3) as 0 | 1 | 2;
      }
      if (ready && !p.reload) {
        const press = (b & Btn.FIRE) !== 0 && !p.triggerHeld;
        const want = def.auto ? (b & Btn.FIRE) !== 0 : press;
        if (want) {
          if (ws.mag <= 0) { if (press) dryFire(p, out); }
          else if (tick >= p.lastShotTick + cycleTicks(def) - 1e-6) fireGun(p, def, ws, state, world, rng, out);
        }
      }
    } else if (inv.active === 3 && ready) {
      // knife: FIRE = slash (0.5 s recovery), SCOPE = stab (1.0 s); next attack at lastShotTick + slash cycle
      if (tick >= p.lastShotTick + cycleTicks(def) - 1e-6) {
        if (b & Btn.FIRE) knifeAttack(p, false, state, world, out);
        else if (b & Btn.SCOPE) knifeAttack(p, true, state, world, out);
      }
    }
  }
  p.triggerHeld = (b & Btn.FIRE) !== 0;
  w.prevButtons = b;
}

function requestSlot(p: PlayerState, slot: Slot, tick: number, out: SimEventSink): void {
  const inv = p.inv;
  if (!hasSlot(inv, slot)) return;
  if (p.throwing) { inv.pendingSlot = slot; return; }            // applied instead of returnSlot after the throw
  if (inv.pendingSlot !== 0) inv.pendingSlot = 0;                 // a manual switch overrides the post-throw return
  if (slot === inv.active) return;
  switchTo(p, slot, tick, out);
}

/** Point where a DROPped weapon lands: 1.2 m ahead at the feet, short of any wall. */
function tossPoint(p: PlayerState, world: StaticWorld): Vec3 {
  const f = forwardXZ(p.yaw);
  const from = v3(p.pos.x, p.pos.y + 0.5, p.pos.z);
  const hit = world.raycast(from, f, FIRE.dropToss + 0.3);
  const d = hit ? Math.max(0, hit.t - 0.3) : FIRE.dropToss;
  const x = p.pos.x + f.x * d, z = p.pos.z + f.z * d;
  return v3(x, world.floorHeightAt(x, z, p.pos.y + 0.6, 0), z);
}

// ───────── throw protocol (§4.4) ─────────

function throwHeld(buttons: number, active: Slot): boolean { return (buttons & Btn.THROW) !== 0 || (active === 4 && (buttons & Btn.FIRE) !== 0); }

function tickThrow(p: PlayerState, b: number, prev: number, state: WorldState, out: SimEventSink): void {
  const inv = p.inv, tick = state.tick;
  if (p.throwing) {
    const held = throwHeld(b, inv.active) && tick - p.throwing.startTick < FIRE.throwMaxHoldTicks;
    if (!held && tick >= inv.switchEndsTick) releaseThrow(p, state, out);
    return;
  }
  if (!throwHeld(b, inv.active) || throwHeld(prev, inv.active) || inv.pendingSlot !== 0 || (inv.he <= 0 && inv.flash <= 0)) return;
  const returnSlot = inv.active;
  if (inv.active !== 4) switchTo(p, 4, tick, out, FIRE.throwSwitchTicks);
  else inv.switchEndsTick = Math.min(inv.switchEndsTick, tick + FIRE.throwSwitchTicks);
  p.throwing = { startTick: tick, returnSlot };
}

/**
 * Release at max(releaseTick, switchEndsTick). The switch to slot 4 is capped at 15 ticks < 18, so a release that had
 * to wait for it was necessarily a tap: speed = held ≥ 18 ticks ? 7 m/s (short toss) : 12 m/s.
 */
function releaseThrow(p: PlayerState, state: WorldState, out: SimEventSink): void {
  const inv = p.inv, th = p.throwing!, tick = state.tick;
  p.throwing = null;
  const kind = grenadeKind(inv);
  if (inv[kind] > 0) {
    const speed = tick - th.startTick >= GRENADE.shortHoldTicks ? GRENADE.shortSpeed : GRENADE.speed;
    inv[kind]--;
    launchGrenade(state, p, kind, speed, out);
  }
  inv.pendingSlot = inv.pendingSlot !== 0 ? inv.pendingSlot : th.returnSlot;   // validated when the return fires
  inv.switchEndsTick = tick + FIRE.throwReturnTicks;
}

// ───────── reload ─────────

function tickReload(p: PlayerState, ws: WeaponSlotState, def: WeaponDef, tick: number, out: SimEventSink): void {
  const r = p.reload!;
  if (r.weapon !== ws.id) { p.reload = null; return; }
  const pos = v3(p.pos.x, p.pos.y, p.pos.z);
  if (tick === r.startTick) {
    out.emit('reload', { player: p.id, weapon: r.weapon, phase: 'start' });
    out.emit('sound', { id: 'reload_out', pos, loudness: LOUDNESS.reload, player: p.id });
  }
  if (tick === r.startTick + Math.round((r.endTick - r.startTick) * FIRE.reloadMidFrac)) {
    out.emit('reload', { player: p.id, weapon: r.weapon, phase: 'mid' });
    out.emit('sound', { id: 'reload_in', pos, loudness: LOUDNESS.reload, player: p.id });
  }
  if (tick >= r.endTick) {
    const take = Math.min(def.mag - ws.mag, ws.reserve);
    ws.mag += take; ws.reserve -= take;
    p.reload = null;
    out.emit('reload', { player: p.id, weapon: r.weapon, phase: 'end' });
    out.emit('sound', { id: 'reload_bolt', pos, loudness: LOUDNESS.reload, player: p.id });
  }
}

function dryFire(p: PlayerState, out: SimEventSink): void {
  const pos = v3(p.pos.x, p.pos.y, p.pos.z);
  out.emit('dryFire', { player: p.id, pos });
  out.emit('sound', { id: 'dryfire', pos: v3copy(pos), loudness: LOUDNESS.dryfire, player: p.id });
}

// ───────── hitscan shot ─────────

const _tmp = v3();

function fireGun(p: PlayerState, def: WeaponDef, ws: WeaponSlotState, state: WorldState, world: StaticWorld, rng: RngStreams, out: SimEventSink): void {
  const tick = state.tick, w = p as WeaponPlayer;
  const eye = eyePos(p);
  const spread = computeSpread(def, p);
  const dir = sampleShotDir(p.yaw, p.pitch, p.aimOffset, spread, rng.get('spread'));
  applyRecoil(p, def, rng.get('fire'));
  const next = p.lastShotTick + cycleTicks(def);
  p.lastShotTick = tick - next >= 0 && tick - next < 1 ? next : tick;   // keeps the exact average rate for held autos
  ws.mag--;
  p.stats.shots++;
  if (def.id === 'awp' && p.scoped) { w.rescope = p.isBot || state.cfg.options.scopeHold ? p.scoped : 0; p.scoped = 0; }

  const { hits, stopT } = traceShot(eye, dir, p, state.players, state.targets, world, def);
  const first = hits[0];
  const end = first ? v3copy(first.point) : v3(eye.x + dir.x * HITSCAN.range, eye.y + dir.y * HITSCAN.range, eye.z + dir.z * HITSCAN.range);
  const victimHit = hits.find((h) => h.kind === 'player');
  out.emit('shot', { shooter: p.id, weapon: def.id, origin: v3copy(eye), dir: v3copy(dir), end, hitPlayer: victimHit ? victimHit.id : 0 });
  out.emit('sound', { id: FIRE_SOUND[def.id] ?? 'fire_glock', pos: v3copy(eye), loudness: fireLoudness(def), player: p.id });

  let struck = false;
  for (const h of hits) {
    if (h.kind === 'solid') {
      out.emit('impact', { point: v3copy(h.point), normal: v3copy(h.normal), surface: h.surface });
      out.emit('sound', { id: `impact_${h.surface}`, pos: v3copy(h.point), loudness: LOUDNESS.impact, player: p.id });
    } else if (h.kind === 'player') {
      const victim = findPlayer(state, h.id);
      if (!victim || !h.zone) continue;
      struck = true;
      const dmg = Math.round(computeDamage(def, h.dist, h.zone) * h.damageScale);
      const armored = zoneArmored(victim, h.zone);
      const r = applyDamage(victim, dmg, h.zone, def.ap, { attacker: p.id, weapon: def.id, headshot: h.zone === 'head', dir: v3copy(dir), point: v3copy(h.point) }, state, out);
      if (r.dealt > 0 || r.armorDealt > 0) out.emit('hit', { attacker: p.id, victim: victim.id, weapon: def.id, zone: h.zone, damage: r.dealt, armored, point: v3copy(h.point) });
      p.stats.damage += r.dealt;
    } else {
      const tg = state.targets.find((t) => t.id === h.id);
      if (!tg) continue;
      struck = true;
      tg.up = false; tg.downUntilTick = tick + FIRE.targetDownTicks;
      out.emit('targetHit', { id: tg.id });
    }
  }
  if (struck) p.stats.hits++;

  // near misses: the flown segment passes < 1.5 m from an enemy head (not the one hit)
  const head = v3();
  for (const q of state.players) {
    if (!q.alive || q.team === p.team || q.id === p.id || (victimHit && victimHit.id === q.id)) continue;
    headPoint(q, head);
    if (closestOnRay(eye, dir, stopT, head, _tmp) < 0) continue;
    const dx = head.x - _tmp.x, dy = head.y - _tmp.y, dz = head.z - _tmp.z;
    if (dx * dx + dy * dy + dz * dz >= HITSCAN.nearMiss * HITSCAN.nearMiss) continue;
    out.emit('nearMiss', { listener: q.id, point: v3copy(_tmp) });
    out.emit('sound', { id: 'bullet_whiz', pos: v3copy(_tmp), loudness: LOUDNESS.whiz, player: p.id });
  }
}

// ───────── knife (§4.4) ─────────

/** True when the attacker is behind the victim: angle(victim forward, attacker→victim) < 60° (XZ). */
export function isBackstab(attacker: Pick<PlayerState, 'pos'>, victim: Pick<PlayerState, 'pos' | 'yaw'>): boolean {
  const dx = victim.pos.x - attacker.pos.x, dz = victim.pos.z - attacker.pos.z, d = Math.hypot(dx, dz);
  if (d < 1e-6) return false;
  const f = forwardXZ(victim.yaw);
  return (f.x * dx + f.z * dz) / d > Math.cos(FIRE.backstabDeg * DEG);
}

/** Knife sphere-cast (r 0.3 m, reach 1.2 m) along the view, limited to a 60° cone and by walls. */
export function knifeTrace(p: PlayerState, state: WorldState, world: StaticWorld): { kind: 'player' | 'target'; id: number; zone: HitZone; point: Vec3 } | null {
  const eye = eyePos(p), dir = dirFromYawPitch(p.yaw, p.pitch);
  const a = nearestActor(eye, dir, p, state.players, state.targets, 0, FIRE.knifeReach, FIRE.knifeRadius);
  if (!a) return null;
  // cone: direction to the victim's body axis point nearest the swing must be within 30° of the view
  const q = a.kind === 'player' ? findPlayer(state, a.id)! : null;
  const tg = q ? null : state.targets.find((t) => t.id === a.id)!;
  const base = q ? q.pos : tg!.pos;
  const top = q ? headPoint(q).y : base.y + 1.8;
  const ax = v3(base.x, Math.min(top, Math.max(base.y + 0.1, a.hit.point.y)), base.z);
  const to = v3(ax.x - eye.x, ax.y - eye.y, ax.z - eye.z);
  const len = Math.hypot(to.x, to.y, to.z);
  if (len > 1e-6 && v3dot(to, dir) / len < Math.cos(FIRE.knifeConeDeg * DEG)) return null;
  if (!world.lineOfSight(eye, a.hit.point)) return null;
  return { kind: a.kind, id: a.id, zone: a.hit.zone, point: a.hit.point };
}

function knifeAttack(p: PlayerState, stab: boolean, state: WorldState, world: StaticWorld, out: SimEventSink): void {
  const def = WEAPONS.knife, tick = state.tick;
  const melee = def.melee!;
  // next attack at lastShotTick + 30 (slash cycle): a stab's 1.0 s recovery is stored as lastShotTick = tick + 30
  p.lastShotTick = stab ? tick + Math.round((60 / melee.stabRpm - 60 / def.rpm) * TICKS_PER_SEC) : tick;
  const hit = knifeTrace(p, state, world);
  const eye = eyePos(p);
  out.emit('knife', { player: p.id, pos: v3copy(eye), hit: hit !== null, stab });
  out.emit('sound', { id: stab ? 'knife_stab' : 'knife_swing', pos: v3copy(eye), loudness: LOUDNESS.knife, player: p.id });
  if (!hit) return;
  out.emit('sound', { id: 'knife_hit', pos: v3copy(hit.point), loudness: LOUDNESS.knife, player: p.id });
  if (hit.kind === 'target') {
    const tg = state.targets.find((t) => t.id === hit.id)!;
    tg.up = false; tg.downUntilTick = tick + FIRE.targetDownTicks;
    out.emit('targetHit', { id: tg.id });
    return;
  }
  const victim = findPlayer(state, hit.id)!;
  let dmg = stab ? melee.stab : def.dmg;
  if (stab && isBackstab(p, victim)) dmg *= melee.backstabMult;
  const dir = v3norm(v3(chestPoint(victim).x - eye.x, chestPoint(victim).y - eye.y, chestPoint(victim).z - eye.z));
  const armored = zoneArmored(victim, hit.zone);
  const r = applyDamage(victim, dmg, hit.zone, def.ap, { attacker: p.id, weapon: 'knife', headshot: false, dir, point: v3copy(hit.point) }, state, out);
  if (r.dealt > 0 || r.armorDealt > 0) out.emit('hit', { attacker: p.id, victim: victim.id, weapon: 'knife', zone: hit.zone, damage: r.dealt, armored, point: v3copy(hit.point) });
  p.stats.damage += r.dealt;
}

