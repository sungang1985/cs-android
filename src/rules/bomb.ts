/**
 * Bomb plant / defuse / explosion (§2.2, §6.8 timings) and the USE intent.
 *
 * Step 6 of Simulation.step: `applyUseIntent(p, cmd, …)` for every alive player (ascending id), then `tickBomb`.
 * - applyUseIntent starts, continues or cancels a plant/defuse; on a USE press edge with nothing to plant/defuse it
 *   performs a pickup (weapons/items.tryPickup with auto = false).
 * - tickBomb completes plants/defuses, emits the defuse ticking sound, explodes the bomb and keeps the carried bomb's
 *   position in sync. Phase changes (LIVE → PLANTED → ROUND_END) are made only by rules/round.ts#tickRound, which
 *   reads `bomb.state` on the next tick.
 *
 * Progress rule (§2.2): progress advances only while USE stays held, horizontal speed < 0.5 m/s, the player is alive,
 * grounded, inside the site (plant) / within 1.5 m of the bomb (defuse), not switching weapons and not blind. The
 * moment a condition fails the progress RESETS to 0 (never pauses) and the stop event is emitted exactly once. While
 * USE is still held, progress restarts from 0 as soon as every condition holds again. Taking damage does not
 * interrupt (CS rule; §6.8's "> 20 damage" is a bot decision to release USE).
 *
 * USE latch: while `use.action === 'none'`, `use.endTick` holds the last tick on which USE was held (`startTick` the
 * tick of the last press), so a press edge is `held && use.endTick !== tick − 1`. The snapshot reads startTick/endTick
 * only while an action is in progress, so the latch is invisible to adapters.
 */
import { v3, v3dist } from '../core/math';
import { Btn, type PlayerState, type InputCommand, type WorldState, type ItemState } from '../sim/state';
import { LOUDNESS, type SimEventSink } from '../sim/events';
import type { CompiledMap } from '../world/types';
import { rectContains } from '../world/types';
import { horizontalSpeed } from '../world/movement';
import { applyDamage } from '../weapons/damage';
import { tryPickup } from '../weapons/items';
import { findPlayer } from '../sim/entities';
import { MODES } from './modes';
import { addMoney, ECON } from './economy';

export const BOMB = {
  plantTicks: 180, defuseTicks: 420, defuseKitTicks: 210, timerTicks: 35 * 60,
  defuseRange: 1.5, maxUseSpeed: 0.5, defuseSoundEvery: 20,
  explosionRadius: 12, explosionDamage: 500, explosionAp: 0.5,
  /** item ↔ feet overlap for the dropped-bomb pickup fallback */
  pickupReachXZ: 0.6,
} as const;

/** Site ('a' | 'b') whose plant rect contains (x, z), else null. */
export function siteAt(map: CompiledMap, x: number, z: number): 'a' | 'b' | null {
  if (rectContains(map.sites.a, x, z)) return 'a';
  if (rectContains(map.sites.b, x, z)) return 'b';
  return null;
}

/** Switching weapons (incl. the 1.0 s purchase deploy) or blind. */
function busy(p: PlayerState, tick: number): boolean { return tick < p.inv.switchEndsTick || tick < p.blindUntilTick; }
function still(p: PlayerState): boolean { return p.grounded && horizontalSpeed(p) < BOMB.maxUseSpeed; }

/** Plant conditions (§2.2), ignoring the USE button. */
export function canPlant(p: PlayerState, state: WorldState, map: CompiledMap): boolean {
  return MODES[state.cfg.mode].bomb && state.round.phase === 'LIVE' && !state.round.suddenDeath && p.alive && p.team === 'T' && p.hasBomb
    && state.bomb.state === 'carried' && siteAt(map, p.pos.x, p.pos.z) !== null && still(p) && !busy(p, state.tick);
}

/** Defuse conditions (§2.2), ignoring the USE button and whether someone else is already defusing. */
export function canDefuse(p: PlayerState, state: WorldState): boolean {
  const ph = state.round.phase;
  return MODES[state.cfg.mode].bomb && (ph === 'LIVE' || ph === 'PLANTED') && p.alive && p.team === 'CT' && state.bomb.state === 'planted'
    && v3dist(p.pos, state.bomb.pos) <= BOMB.defuseRange && still(p) && !busy(p, state.tick);
}

/** Ends an in-progress plant/defuse (progress reset), emitting the matching stop event once. */
function stopUse(p: PlayerState, out: SimEventSink, latchTick: number): void {
  if (p.use.action === 'plant') out.emit('bombPlantStop', { player: p.id });
  else if (p.use.action === 'defuse') out.emit('bombDefuseStop', { player: p.id });
  p.use.action = 'none'; p.use.endTick = latchTick;
}

function startPlant(p: PlayerState, state: WorldState, out: SimEventSink): void {
  const t = state.tick;
  p.use.action = 'plant'; p.use.startTick = t; p.use.endTick = t + BOMB.plantTicks; p.use.itemId = 0;
  out.emit('bombPlantStart', { player: p.id });
  out.emit('sound', { id: 'bomb_plant', pos: v3(p.pos.x, p.pos.y, p.pos.z), loudness: LOUDNESS.bomb_plant, player: p.id });
}

function startDefuse(p: PlayerState, state: WorldState, out: SimEventSink): void {
  const t = state.tick;
  p.use.action = 'defuse'; p.use.startTick = t; p.use.endTick = t + (p.hasKit ? BOMB.defuseKitTicks : BOMB.defuseTicks); p.use.itemId = 0;
  out.emit('bombDefuseStart', { player: p.id, kit: p.hasKit });
}

function someoneDefusing(state: WorldState, except: PlayerState): boolean {
  return state.players.some((q) => q !== except && q.alive && q.use.action === 'defuse');
}

function bombItem(state: WorldState): ItemState | undefined {
  return state.items.find((i) => i.kind === 'bomb' && i.id === state.bomb.itemId) ?? state.items.find((i) => i.kind === 'bomb');
}

function touches(p: PlayerState, it: ItemState): boolean {
  return Math.abs(p.pos.x - it.pos.x) <= BOMB.pickupReachXZ && Math.abs(p.pos.z - it.pos.z) <= BOMB.pickupReachXZ && it.pos.y >= p.pos.y - 0.5 && it.pos.y <= p.pos.y + 1.8;
}

/** A T takes the dropped bomb (emits itemPickup, bombPickup and the bomb_pickup sound). */
export function pickUpBomb(state: WorldState, p: PlayerState, out: SimEventSink): boolean {
  if (state.bomb.state !== 'dropped' || p.team !== 'T' || !p.alive) return false;
  const it = bombItem(state);
  if (!it) return false;
  state.items.splice(state.items.indexOf(it), 1);
  p.hasBomb = true;
  state.bomb.state = 'carried'; state.bomb.carrier = p.id; state.bomb.itemId = 0; state.bomb.pos = v3(p.pos.x, p.pos.y, p.pos.z);
  out.emit('itemPickup', { id: it.id, player: p.id, kind: 'bomb' });
  out.emit('bombPickup', { player: p.id });
  out.emit('sound', { id: 'bomb_pickup', pos: v3(p.pos.x, p.pos.y, p.pos.z), loudness: LOUDNESS.bomb_pickup, player: p.id });
  return true;
}

/**
 * USE intent for one alive player (sim.ts step 6, right before tickBomb, with that player's command).
 * Priority on USE: plant (T carrier in a site) → defuse (CT within 1.5 m of the planted bomb, one defuser at a time)
 * → pickup on the press edge.
 */
export function applyUseIntent(p: PlayerState, cmd: InputCommand, state: WorldState, map: CompiledMap, out: SimEventSink): void {
  if (!p.alive) return;
  const tick = state.tick;
  const held = (cmd.buttons & Btn.USE) !== 0;
  const u = p.use;
  if (u.action === 'plant' || u.action === 'defuse') {
    const ok = held && (u.action === 'plant' ? canPlant(p, state, map) : canDefuse(p, state));
    if (ok) return;
    stopUse(p, out, held ? tick : tick - 1);
    return;
  }
  if (!held) return;
  const edge = u.endTick !== tick - 1;
  if (canPlant(p, state, map)) { startPlant(p, state, out); return; }
  if (canDefuse(p, state) && !someoneDefusing(state, p)) { startDefuse(p, state, out); return; }
  u.endTick = tick;
  if (!edge) return;
  u.startTick = tick;
  tryPickup(state, p, false, out);
  if (state.bomb.state === 'dropped' && p.team === 'T') { const it = bombItem(state); if (it && touches(p, it)) pickUpBomb(state, p, out); }
}

function completePlant(p: PlayerState, state: WorldState, map: CompiledMap, out: SimEventSink): void {
  const t = state.tick;
  const site = siteAt(map, p.pos.x, p.pos.z) ?? (v3dist(p.pos, map.plantSpots.a) <= v3dist(p.pos, map.plantSpots.b) ? 'a' : 'b');
  state.bomb = { state: 'planted', carrier: 0, itemId: 0, pos: v3(p.pos.x, p.pos.y, p.pos.z), plantedTick: t, explodeTick: t + BOMB.timerTicks, site };
  for (const q of state.players) q.hasBomb = false;
  p.use.action = 'none'; p.use.endTick = t;
  p.stats.plants++;
  if (MODES[state.cfg.mode].economy) addMoney(state, p, ECON.plantBonus, 'plant', out);
  out.emit('bombPlanted', { player: p.id, pos: v3(p.pos.x, p.pos.y, p.pos.z), site });
}

function completeDefuse(p: PlayerState, state: WorldState, out: SimEventSink): void {
  const t = state.tick, b = state.bomb;
  b.state = 'defused';
  p.use.action = 'none'; p.use.endTick = t;
  p.stats.defuses++;
  if (MODES[state.cfg.mode].economy) addMoney(state, p, ECON.defuseBonus, 'defuse', out);
  out.emit('bombDefused', { player: p.id });
  out.emit('sound', { id: 'bomb_defused', pos: v3(b.pos.x, b.pos.y, b.pos.z), loudness: LOUDNESS.bomb_defused, player: p.id });
}

/** Explosion damage at distance `dist` (§2.2): round(500 · (1 − dist / 12)), ≥ 0. */
export function explosionDamage(dist: number): number {
  return Math.max(0, Math.round(BOMB.explosionDamage * (1 - dist / BOMB.explosionRadius)));
}

function explode(state: WorldState, out: SimEventSink): void {
  const b = state.bomb;
  b.state = 'exploded';
  for (const p of state.players) if (p.use.action === 'defuse') stopUse(p, out, state.tick);
  const pos = v3(b.pos.x, b.pos.y, b.pos.z);
  out.emit('bombExploded', { pos: v3(pos.x, pos.y, pos.z) });
  out.emit('sound', { id: 'bomb_explode', pos: v3(pos.x, pos.y, pos.z), loudness: LOUDNESS.bomb_explode, player: 0 });
  for (const p of state.players) {
    if (!p.alive) continue;
    const dist = v3dist(p.pos, pos);
    const dmg = explosionDamage(dist);
    if (dmg <= 0) continue;
    const dx = p.pos.x - pos.x, dz = p.pos.z - pos.z, hl = Math.hypot(dx, dz);
    const dir = hl > 1e-6 ? v3(dx / hl, 0, dz / hl) : v3(0, 0, -1);
    applyDamage(p, dmg, 'chest', BOMB.explosionAp, { attacker: 0, weapon: 'bomb', headshot: false, dir, point: v3(p.pos.x, p.pos.y + 1.2, p.pos.z) }, state, out);
  }
}

/**
 * Per-tick bomb logic (sim.ts step 6, after applyUseIntent): stop events for players killed mid-action this tick,
 * plant/defuse completion (ascending id; a defuse completing on the explosion tick wins), the defuse ticking sound
 * every 20 ticks, the explosion at `explodeTick` (bombExploded + global sound, applyDamage to everyone within 12 m,
 * both teams, through walls), the carried bomb's position, and a fallback auto-pickup of a dropped bomb for
 * auto-pickers (bots; the human iff cfg.options.autoPickup) in case weapons/items.tryPickup did not take it.
 */
export function tickBomb(state: WorldState, map: CompiledMap, out: SimEventSink): void {
  if (!MODES[state.cfg.mode].bomb) return;
  const tick = state.tick;
  for (const p of state.players) {
    // killed earlier this tick while planting/defusing: the death reset cleared `action` but not the timers
    if (!p.alive && p.deathTick === tick && p.use.action === 'none' && p.use.endTick >= tick && p.use.endTick > p.use.startTick) {
      out.emit(p.team === 'T' ? 'bombPlantStop' : 'bombDefuseStop', { player: p.id });
      p.use.endTick = tick - 1;
    }
  }
  for (const p of state.players) {
    if (!p.alive) continue;
    if (p.use.action === 'plant' && tick >= p.use.endTick) completePlant(p, state, map, out);
    else if (p.use.action === 'defuse') {
      if ((tick - p.use.startTick) % BOMB.defuseSoundEvery === 0) out.emit('sound', { id: 'bomb_defuse_tick', pos: v3(p.pos.x, p.pos.y, p.pos.z), loudness: LOUDNESS.bomb_defuse_tick, player: p.id });
      if (tick >= p.use.endTick && state.bomb.state === 'planted') completeDefuse(p, state, out);
    }
  }
  const b = state.bomb;
  if (b.state === 'planted' && tick >= b.explodeTick) explode(state, out);
  else if (b.state === 'carried') {
    let c = b.carrier ? findPlayer(state, b.carrier) : undefined;
    if (!c || !c.hasBomb || !c.alive) c = state.players.find((q) => q.alive && q.hasBomb);
    if (c) { b.carrier = c.id; b.pos.x = c.pos.x; b.pos.y = c.pos.y; b.pos.z = c.pos.z; }
  } else if (b.state === 'dropped') {
    const it = bombItem(state);
    if (it) for (const p of state.players) {
      if (p.alive && p.team === 'T' && (p.isBot || state.cfg.options.autoPickup) && touches(p, it)) { pickUpBomb(state, p, out); break; }
    }
  }
}
