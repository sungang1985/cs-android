/**
 * Simulation facade (§11.6, §11.8): exactly one fixed tick per step(), the §11.6 order, snapshot writing,
 * aim candidates, serialisation and hashing. Never imports ai/ (brains are injected).
 */
import { v3, wrapAngle, clamp } from '../core/math';
import { RngStreams } from '../core/rng';
import { EventBus } from '../core/events';
import type { CompiledMap } from '../world/types';
import type { StaticWorld } from '../world/collision';
import type { NavGraph } from '../nav/navgraph';
import { movePlayer, horizontalSpeed, eyePos } from '../world/movement';
import { WEAPONS } from '../weapons/defs';
import { activeWeaponId, activeSlotState } from '../weapons/inventory';
import { computeSpread, recoverRecoil, tickWeapon } from '../weapons/fire';
import { stepGrenades } from '../weapons/grenade';
import { tryPickup, pickupObjectives } from '../weapons/items';
import { createMatch, defaultProfiles } from '../rules/match';
import { tickRound } from '../rules/round';
import { tickBomb, applyUseIntent } from '../rules/bomb';
import { canBuyNow, buy } from '../rules/economy';
import { MODES } from '../rules/modes';
import type { BotBrain, BotBrainFactory, ThinkContext } from './brain';
import type { SimEvents, SimEnvelope, SimEventSink } from './events';
import {
  type WorldState, type MatchConfig, type BotProfile, type InputCommand, type RenderSnapshot, type AimCandidate, type MatchOptions, type PlayerState, type Difficulty,
  IDLE_COMMAND, cloneCommand, TEAM_INDEX, ROUND_PHASE_INDEX, BOMB_STATE_INDEX, USE_ACTION_INDEX, ITEM_KIND_INDEX, GRENADE_INDEX, SNAPSHOT_CAPACITY, weaponIndex, TICKS_PER_SEC, DT, Btn,
} from './state';
import { processDeaths } from './death';
import { computeCandidates } from './candidates';
import { findPlayer } from './entities';

export interface SimDeps { map: CompiledMap; world: StaticWorld; nav: NavGraph; brains: BotBrainFactory }

export class Simulation {
  readonly state: WorldState;
  readonly events: EventBus<SimEvents> = new EventBus<SimEvents>();
  private readonly streams: RngStreams;
  private readonly brains = new Map<Difficulty, BotBrain>();
  private tickEvents: SimEnvelope[] = [];
  private frozenBots = false;
  private readonly candidates: AimCandidate[] = [];
  private readonly sink: SimEventSink;
  private lastCmd: InputCommand = cloneCommand(IDLE_COMMAND);

  constructor(readonly deps: SimDeps, cfg: MatchConfig, profiles?: BotProfile[], restored?: WorldState) {
    this.streams = restored ? new RngStreams(cfg.seed, restored.rng) : new RngStreams(cfg.seed);
    const sink: SimEventSink = { emit: (k, e) => this.events.emit(k, e) };
    this.sink = sink;
    this.events.onAny((e) => { this.tickEvents.push(e); });
    this.state = restored ?? createMatch(cfg, deps.map, profiles ?? defaultProfiles(cfg), this.streams);
    this.events.tick = this.state.tick;
    this.events.clear(); this.tickEvents.length = 0;
  }

  private brainFor(d: Difficulty): BotBrain {
    let b = this.brains.get(d);
    if (!b) { b = this.deps.brains(d); this.brains.set(d, b); }
    return b;
  }

  private ctx(): ThinkContext {
    return { state: this.state, map: this.deps.map, world: this.deps.world, nav: this.deps.nav, rng: this.streams.get('ai'), tick: this.state.tick, out: this.sink };
  }

  /** Exactly one fixed tick in the §11.6 order. */
  step(cmd: InputCommand): void {
    const s = this.state;
    if (s.round.phase === 'MATCH_END') { this.events.tick = s.tick; return; }
    this.tickEvents.length = 0;
    this.events.tick = s.tick;
    this.lastCmd = cmd;
    const map = this.deps.map, world = this.deps.world;
    for (const p of s.players) { p.prevPos.x = p.pos.x; p.prevPos.y = p.pos.y; p.prevPos.z = p.pos.z; p.prevYaw = p.yaw; p.prevPitch = p.pitch; }

    // 1. round / mode
    const phaseBefore = s.round.phase;
    tickRound(s, map, this.streams, this.sink);
    if (s.round.phase === 'FREEZE' && phaseBefore !== 'FREEZE') this.deps.nav.clearCache();
    const frozen = s.round.phase === 'FREEZE' || s.round.phase === 'ROUND_END' || s.round.phase === 'WARMUP';

    // 2. bots think (team first, then by id)
    const commands = new Map<number, InputCommand>();
    const ctx = this.ctx();
    const botOrder = s.bots.map((m) => m.id).sort((a, b) => a - b);
    if (!this.frozenBots) {
      for (const team of ['T', 'CT'] as const) this.brainFor(this.difficultyOfTeam(team)).teamThink(team, ctx);
    }
    for (const id of botOrder) {
      const p = findPlayer(s, id); const mem = s.bots.find((m) => m.id === id)!;
      if (!p || !p.alive) continue;
      const c = this.frozenBots ? (() => { const k = cloneCommand(IDLE_COMMAND, s.tick); k.yaw = p.yaw; k.pitch = p.pitch; return k; })() : this.brainFor(mem.profile.difficulty).think(ctx, p, mem);
      commands.set(id, c);
    }
    const human = findPlayer(s, s.humanId);
    if (human) commands.set(human.id, cmd);

    // 3. movement
    for (const p of s.players) {
      const c = commands.get(p.id);
      if (!c) continue;
      if (!p.alive) { p.yaw = c.yaw; p.pitch = clamp(c.pitch, -1.55, 1.55); this.handleSpectate(p, c); continue; }
      const def = WEAPONS[activeWeaponId(p)];
      const maxSpeed = p.scoped && def.scopedSpeed ? def.scopedSpeed : def.speed;
      movePlayer(p, c, world, maxSpeed, frozen, s.tick, s, this.sink);
    }
    processDeaths(s, map, this.sink);

    // 4. weapons
    for (const p of s.players) {
      const c = commands.get(p.id);
      if (!c || !p.alive) continue;
      if (!frozen) tickWeapon(p, c, s, world, this.streams, this.sink);
      recoverRecoil(p, WEAPONS[activeWeaponId(p)]);
      if (c.buy) buy(p, c.buy, s, map, this.sink);
    }
    processDeaths(s, map, this.sink);

    // 5. grenades
    stepGrenades(s, world, this.sink);
    processDeaths(s, map, this.sink);

    // 6. items / bomb / use
    for (const p of s.players) {
      if (!p.alive) continue;
      if (p.isBot || s.cfg.options.autoPickup) tryPickup(s, p, true, this.sink);
      else pickupObjectives(s, p, this.sink); // bomb (T) / kit (CT) always; weapons only via USE
    }
    for (const p of s.players) { const c = commands.get(p.id); if (p.alive && c) applyUseIntent(p, c, s, map, this.sink); }
    tickBomb(s, map, this.sink);
    processDeaths(s, map, this.sink);

    // 7. (economy/scores are applied inside round/death) — 8. bot event delivery
    if (!this.frozenBots && this.tickEvents.length) {
      const events = this.tickEvents.slice();
      for (const e of events) for (const id of botOrder) {
        const p = findPlayer(s, id); const mem = s.bots.find((m) => m.id === id)!;
        if (!p || !p.alive) continue;
        this.brainFor(mem.profile.difficulty).onEvent(e, mem, p, ctx);
      }
    }
    s.rng = this.streams.serialize() as WorldState['rng'];
    s.tick++;
    this.events.tick = s.tick;
  }

  private handleSpectate(p: PlayerState, c: InputCommand): void {
    if (c.spectate === 0) return;
    const mates = this.state.players.filter((q) => q.alive && q.team === p.team);
    if (!mates.length) { p.spectating = 0; return; }
    const i = mates.findIndex((q) => q.id === p.spectating);
    p.spectating = mates[(i + c.spectate + mates.length) % mates.length].id;
  }

  private difficultyOfTeam(team: 'T' | 'CT'): Difficulty {
    const m = this.state.bots.find((b) => findPlayer(this.state, b.id)?.team === team);
    return m ? m.profile.difficulty : this.state.cfg.difficulty;
  }

  /** LOS-checked enemies in front of the human (§7.5); also emits `spotted` for the human. */
  aimCandidates(): AimCandidate[] { return computeCandidates(this.state, this.deps.world, this.candidates, this.sink); }

  setOptions(o: Partial<MatchOptions>): void { Object.assign(this.state.cfg.options, o); }
  freezeBots(b: boolean): void { this.frozenBots = b; }
  get botsFrozen(): boolean { return this.frozenBots; }

  /** Overwrites `out` in place (no allocation). */
  writeSnapshot(out: RenderSnapshot): void {
    const s = this.state; const t = s.tick;
    out.tick = t; out.time = t / TICKS_PER_SEC;
    let n = 0;
    const human = findPlayer(s, s.humanId);
    for (const p of s.players) {
      if (n >= SNAPSHOT_CAPACITY.players) break;
      const sp = out.players[n++];
      sp.id = p.id; sp.nameKey = p.nameKey; sp.team = TEAM_INDEX[p.team]; sp.alive = p.alive ? 1 : 0;
      sp.x = p.pos.x; sp.y = p.pos.y; sp.z = p.pos.z; sp.yaw = p.yaw; sp.pitch = p.pitch; sp.crouch = p.crouched ? 1 : 0;
      sp.weapon = weaponIndex(activeWeaponId(p)); sp.legPhase = p.legPhase; sp.hp = p.hp; sp.armor = p.armor; sp.helmet = p.helmet ? 1 : 0;
      sp.reloadT = p.reload ? clamp((t - p.reload.startTick) / Math.max(1, p.reload.endTick - p.reload.startTick), 0, 1) : -1;
      sp.scoped = p.scoped ? 1 : 0; sp.flinchT = p.lastDamage.tick >= 0 && t - p.lastDamage.tick < 9 ? (t - p.lastDamage.tick) / 9 : -1;
      sp.deathT = p.alive || p.deathTick < 0 ? -1 : (t - p.deathTick) / TICKS_PER_SEC;
      sp.hasBomb = p.hasBomb ? 1 : 0; sp.hasKit = p.hasKit ? 1 : 0; sp.using = p.use.action !== 'none' ? 1 : 0;
      sp.kills = p.stats.kills; sp.deaths = p.stats.deaths; sp.money = human && p.team === human.team ? p.money : -1;
    }
    out.playerCount = n;
    n = 0;
    for (const g of s.grenades) { if (n >= SNAPSHOT_CAPACITY.grenades) break; const o = out.grenades[n++]; o.id = g.id; o.kind = GRENADE_INDEX[g.kind]; o.x = g.pos.x; o.y = g.pos.y; o.z = g.pos.z; }
    out.grenadeCount = n;
    n = 0;
    for (const it of s.items) { if (n >= SNAPSHOT_CAPACITY.items) break; const o = out.items[n++]; o.id = it.id; o.kind = ITEM_KIND_INDEX[it.kind] as 0 | 1 | 2; o.weapon = it.weapon ? weaponIndex(it.weapon.id) : -1; o.x = it.pos.x; o.y = it.pos.y; o.z = it.pos.z; o.yaw = it.yaw; }
    out.itemCount = n;
    n = 0;
    for (const tg of s.targets) { if (n >= SNAPSHOT_CAPACITY.targets) break; const o = out.targets[n++]; o.id = tg.id; o.x = tg.pos.x; o.y = tg.pos.y; o.z = tg.pos.z; o.up = tg.up ? 1 : 0; }
    out.targetCount = n;
    const b = s.bomb;
    out.bomb.state = BOMB_STATE_INDEX[b.state] as RenderSnapshot['bomb']['state']; out.bomb.x = b.pos.x; out.bomb.y = b.pos.y; out.bomb.z = b.pos.z;
    out.bomb.remaining = b.state === 'planted' ? Math.max(0, (b.explodeTick - t) / TICKS_PER_SEC) : 0; out.bomb.carrier = b.carrier;
    const r = s.round;
    out.round.phase = ROUND_PHASE_INDEX[r.phase]; out.round.remaining = r.phaseEndsTick >= Number.MAX_SAFE_INTEGER ? -1 : Math.max(0, (r.phaseEndsTick - t) / TICKS_PER_SEC);
    out.round.roundNumber = r.roundNumber; out.round.scoreT = r.scoreT; out.round.scoreCT = r.scoreCT; out.round.suddenDeath = r.suddenDeath ? 1 : 0;
    let aT = 0, aCT = 0; for (const p of s.players) if (p.alive) { if (p.team === 'T') aT++; else aCT++; }
    out.round.aliveT = aT; out.round.aliveCT = aCT;
    const l = out.local;
    if (human) {
      const wid = activeWeaponId(human); const def = WEAPONS[wid]; const slot = activeSlotState(human);
      l.id = human.id; l.alive = human.alive ? 1 : 0; l.hp = human.hp; l.armor = human.armor; l.helmet = human.helmet ? 1 : 0; l.money = human.money;
      l.weapon = weaponIndex(wid); l.mag = slot ? slot.mag : wid === 'he' ? human.inv.he : wid === 'flash' ? human.inv.flash : 0; l.reserve = slot ? slot.reserve : 0;
      l.primary = human.inv.primary ? weaponIndex(human.inv.primary.id) : -1; l.pistol = weaponIndex(human.inv.pistol.id); l.he = human.inv.he; l.flash = human.inv.flash;
      l.selectedGrenade = GRENADE_INDEX[human.inv.selectedGrenade]; l.activeSlot = human.inv.active;
      l.aimOffsetYaw = human.aimOffset.yaw; l.aimOffsetPitch = human.aimOffset.pitch; l.spreadDeg = computeSpread(def, human);
      l.crosshairTarget = this.crosshairTarget(human); l.speed = horizontalSpeed(human); l.grounded = human.grounded ? 1 : 0; l.crouch = human.crouched ? 1 : 0;
      l.scoped = human.scoped; l.useAction = USE_ACTION_INDEX[human.use.action] as 0 | 1 | 2 | 3;
      l.useProgress = human.use.action !== 'none' ? clamp((t - human.use.startTick) / Math.max(1, human.use.endTick - human.use.startTick), 0, 1) : 0;
      l.canBuy = canBuyNow(human, s, this.deps.map) ? 1 : 0;
      l.buyWindowRemaining = MODES[s.cfg.mode].buyAnywhere ? -1 : Math.max(0, (r.buyWindowEndsTick - t) / TICKS_PER_SEC);
      l.hasBomb = human.hasBomb ? 1 : 0; l.hasKit = human.hasKit ? 1 : 0;
      const eye = eyePos(human); l.eyeX = eye.x; l.eyeY = eye.y; l.eyeZ = eye.z; l.x = human.pos.x; l.z = human.pos.z;
      l.throwHoldT = human.throwing ? (t - human.throwing.startTick) / TICKS_PER_SEC : -1;
      l.blindT = Math.max(0, (human.blindUntilTick - t) / TICKS_PER_SEC);
      const ld = human.lastDamage; l.damageT = ld.tick >= 0 && t - ld.tick < 30 ? (t - ld.tick) / TICKS_PER_SEC : -1;
      l.damageDirYaw = ld.tick >= 0 ? wrapAngle(Math.atan2(-(ld.from.x - human.pos.x), -(ld.from.z - human.pos.z)) - human.yaw) : 0;
      l.spectating = human.alive ? 0 : human.spectating;
      l.killerId = !human.alive && r.lastKill && r.lastKill.victim === human.id ? r.lastKill.killer : 0;
      const lk = r.lastKill;
      if (lk) { l.lastKill.killer = lk.killer; l.lastKill.victim = lk.victim; l.lastKill.headshot = lk.headshot ? 1 : 0; l.lastKill.weapon = weaponIndex(lk.weapon); l.lastKill.t = (t - lk.tick) / TICKS_PER_SEC; }
      else { l.lastKill.killer = 0; l.lastKill.victim = 0; l.lastKill.headshot = 0; l.lastKill.weapon = -1; l.lastKill.t = -1; }
    }
  }

  /** 0 none, 1 enemy, 2 teammate under the crosshair (look + aimOffset), ≤ 60 m. */
  private crosshairTarget(me: PlayerState): 0 | 1 | 2 {
    if (!me.alive) return 0;
    const eye = eyePos(me);
    const dir = v3(-Math.sin(me.yaw + me.aimOffset.yaw) * Math.cos(me.pitch + me.aimOffset.pitch), Math.sin(me.pitch + me.aimOffset.pitch), -Math.cos(me.yaw + me.aimOffset.yaw) * Math.cos(me.pitch + me.aimOffset.pitch));
    const wall = this.deps.world.raycast(eye, dir, 60);
    const maxT = wall ? wall.t : 60;
    let best: PlayerState | null = null, bestT = maxT;
    for (const p of this.state.players) {
      if (!p.alive || p.id === me.id) continue;
      const h = p.crouched ? 1.3 : 1.8;
      // cylinder test
      const ox = eye.x - p.pos.x, oz = eye.z - p.pos.z;
      const a = dir.x * dir.x + dir.z * dir.z, b = 2 * (ox * dir.x + oz * dir.z), c = ox * ox + oz * oz - 0.09;
      const disc = b * b - 4 * a * c; if (a < 1e-9 || disc < 0) continue;
      const t0 = (-b - Math.sqrt(disc)) / (2 * a); if (t0 < 0 || t0 > bestT) continue;
      const y = eye.y + dir.y * t0; if (y < p.pos.y || y > p.pos.y + h) continue;
      best = p; bestT = t0;
    }
    return best ? (best.team === me.team ? 2 : 1) : 0;
  }

  serialize(): string { return JSON.stringify(this.state); }

  static restore(json: string, deps: SimDeps): Simulation {
    const state = JSON.parse(json) as WorldState;
    state.pendingDeaths = [];
    return new Simulation(deps, state.cfg, undefined, state);
  }

  /** FNV-1a over canonical JSON (numbers rounded to 1e-6). */
  hash(): number {
    const json = JSON.stringify(this.state, (_k, v) => (typeof v === 'number' ? Math.round(v * 1e6) / 1e6 : v));
    let h = 2166136261 >>> 0;
    for (let i = 0; i < json.length; i++) { h ^= json.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h >>> 0;
  }

  get lastCommand(): InputCommand { return this.lastCmd; }
  get dt(): number { return DT; }
  /** Human's active weapon fire state helper for the input layer (semi-auto pulsing). */
  humanHoldsTrigger(): boolean { return (this.lastCmd.buttons & Btn.FIRE) !== 0; }
}
