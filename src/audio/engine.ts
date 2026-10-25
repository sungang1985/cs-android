/**
 * AudioEngine (§9.3). WebAudio graph:
 *   voices → { weapons, impacts, foley, explosions } → sfx (1.0, highpass 90 Hz) ─┐
 *   ui (0.7) ─────────────────────────────────────────────────────────────────────┼→ master (0.8) → "deafened" lowpass → compressor (−12 dB, 4:1) → out
 *   ambient (0.12) ───────────────────────────────────────────────────────────────┘
 * Voice chain: AudioBufferSource → Gain → [Biquad lowpass only when occluded / distant] → [Panner (equalpower,
 * inverse, ref 1.5, max = loudness, rolloff 1.2)] → bus. World audio comes ONLY from `sound` events; the engine
 * adds listener-relative cues (hit feedback, flash ring, bomb beeps, round stingers, buy, UI clicks). Shot,
 * footstep, reload, impact and grenadeBounce events are ignored for playback. Pure decisions live in mixer.ts.
 */
import { v3, v3copy, type Vec3 } from '../core/math';
import type { SimEnvelope, SimEvents } from '../sim/events';
import type { SnapLocal, Team } from '../sim/state';
import type { StaticWorld } from '../world/collision';
import { SoundBank } from './bank';
import { RECIPE_SPEC, type BankId } from './recipes';
import {
  BOMB_TIMER_SEC, BUS_GAIN, DEAFEN_SEC, DedupeClock, EAR_RING_RANGE, RadioLimiter, REF_DISTANCE, ROLLOFF, UI_SOUNDS, VOICE_LIMIT,
  applyOcclusion, beepInterval, busFor, hitCue, pickVictim, planWorldSound, roundCue, variantFor, volumeGain, type BusId,
} from './mixer';

export interface AudioEngineOptions {
  /** Context factory (tests inject a fake). Default: new AudioContext({ latencyHint: 'interactive' }). */
  createContext?: () => AudioContext;
  /** A prebuilt bank (tests); otherwise rendered on the first unlock(). */
  bank?: SoundBank;
}

interface Voice { src: AudioBufferSourceNode; nodes: AudioNode[]; priority: number; ended: boolean; id: BankId }
interface PlayOpts { variant?: number; gain: number; priority: number; pos?: Vec3 | null; lowpass?: number | null; maxDistance?: number; refDistance?: number; bus?: BusId; dedupe?: boolean; dedupeKey?: string }

const TICKS = 60;
/** How far the bomb-beep clock may run ahead of the last known event tick when syncTick() is never called (covers quiet frames). */
const MAX_EXTRAPOLATE_SEC = 0.5;
const BEEP_MAX_DISTANCE = 40;
const SOURCE_LIFT = 0.3;
/** Gesture events that may unlock/resume the context (touch activation lands on pointerup/touchend, not pointerdown). */
const RETRY_EVENTS = ['pointerdown', 'pointerup', 'touchend', 'keydown'] as const;

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private bank: SoundBank | null;
  private bankPromise: Promise<void> | null = null;
  private buses: Record<BusId, GainNode> | null = null;
  private master: GainNode | null = null;
  private sfx: GainNode | null = null;
  private deafLp: BiquadFilterNode | null = null;
  private volumes = { master: 80, sfx: 100, ui: 70 };
  private voices: Voice[] = [];
  private readonly dedupe = new DedupeClock();
  private readonly radio = new RadioLimiter();
  private readonly listener = { pos: v3(0, 1.65, 0), fwd: v3(0, 0, -1), up: v3(0, 1, 0) };
  private world: StaticWorld | null = null;
  private localTeam: Team | null = null;
  private teamExplicit = false;
  private localId = 1;
  private simTick = 0; private simTickAt = 0;
  /** syncTick() drives the beep clock exactly: no wall-clock extrapolation (a paused sim must stay silent). */
  private synced = false;
  private beep: { explodeTick: number; nextTick: number; pos: Vec3 } | null = null;
  private ring: { src: AudioBufferSourceNode; gain: GainNode } | null = null;
  private ambient: { src: AudioBufferSourceNode; gain: GainNode } | null = null;
  private ambientWanted = false;
  private retryArmed = false;
  private readonly createContext: () => AudioContext;
  /** Loading-screen progress while the bank renders (done, total). */
  onProgress: ((done: number, total: number) => void) | null = null;

  private readonly onVisibility = () => { if (typeof document === 'undefined') return; if (document.hidden) this.suspend(); else this.resume(); };
  private readonly onRetry = () => {
    const ctx = this.ctx;
    if (!ctx) { void this.unlock().then(() => { if (this.unlocked) this.disarmRetry(); }); return; }
    if (ctx.state === 'running') { this.disarmRetry(); return; }
    if (ctx.state !== 'closed') void ctx.resume().then(() => { if (ctx.state === 'running') this.disarmRetry(); }, () => undefined);
  };

  constructor(opts: AudioEngineOptions = {}) {
    this.bank = opts.bank ?? null;
    this.createContext = opts.createContext ?? (() => {
      const Ctor = (globalThis as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext ?? (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) throw new Error('WebAudio unavailable');
      return new Ctor({ latencyHint: 'interactive' });
    });
  }

  // ───────── lifecycle ─────────
  /** Creates/resumes the context on a user gesture (idempotent) and renders the bank once. */
  async unlock(): Promise<void> {
    if (!this.ctx) {
      try { this.ctx = this.createContext(); } catch { return; }
      this.buildGraph();
      if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.onVisibility);
    }
    try { await this.ctx.resume(); } catch { /* resumed later by a gesture */ }
    if (this.ctx.state !== 'running') this.armRetry();
    if (!this.bank && !this.bankPromise) {
      const ctx = this.ctx;
      this.bankPromise = SoundBank.build(ctx, (d, t) => this.onProgress?.(d, t)).then((b) => { this.bank = b; if (this.ambientWanted) this.ensureAmbient(); });
    }
    if (this.bankPromise) await this.bankPromise;
    if (this.ambientWanted) this.ensureAmbient();
  }
  /**
   * Unlocks on the first user gesture anywhere (§9.3 "retried on first touch"): first launch goes straight into the
   * onboarding training match without a Play tap. Idempotent; the listeners go away once the context runs.
   */
  arm(): void { if (!this.unlocked) this.armRetry(); }
  get unlocked(): boolean { return this.ctx?.state === 'running'; }
  get ready(): boolean { return !!this.ctx && !!this.bank && !!this.buses; }
  suspend(): void { if (this.ctx && this.ctx.state === 'running') void this.ctx.suspend().catch(() => undefined); }
  resume(): void { if (this.ctx && this.ctx.state !== 'running' && this.ctx.state !== 'closed') void this.ctx.resume().catch(() => undefined); }

  /** Per-match: the static world for occlusion; resets the per-match cue state. */
  setWorld(world: StaticWorld): void {
    this.world = world;
    this.beep = null; this.simTick = 0; this.simTickAt = this.now(); this.dedupe.clear(); this.radio.clear(); this.stopRing();
    if (!this.teamExplicit) this.localTeam = null;
  }
  /** The human's team for round win/lose stingers (call on match start and after the half swap). */
  setLocalTeam(team: Team | null): void { this.localTeam = team; this.teamExplicit = team !== null; }
  /** Optional: the current sim tick (exact bomb-beep timing; otherwise extrapolated from event ticks). */
  syncTick(tick: number): void { this.synced = true; this.noteTick(tick); this.advanceBeep(tick); }

  setVolumes(v: { master: number; sfx: number; ui: number }): void { this.volumes = { ...v }; this.applyVolumes(); }
  getVolumes(): { master: number; sfx: number; ui: number } { return this.volumes; }

  setListener(p: { pos: Vec3; fwd: Vec3; up: Vec3 }): void {
    const l = this.listener;
    l.pos.x = p.pos.x; l.pos.y = p.pos.y; l.pos.z = p.pos.z; l.fwd.x = p.fwd.x; l.fwd.y = p.fwd.y; l.fwd.z = p.fwd.z; l.up.x = p.up.x; l.up.y = p.up.y; l.up.z = p.up.z;
    const ctx = this.ctx;
    if (ctx) {
      const L = ctx.listener;
      if (L.positionX) {
        L.positionX.value = l.pos.x; L.positionY.value = l.pos.y; L.positionZ.value = l.pos.z;
        L.forwardX.value = l.fwd.x; L.forwardY.value = l.fwd.y; L.forwardZ.value = l.fwd.z; L.upX.value = l.up.x; L.upY.value = l.up.y; L.upZ.value = l.up.z;
      } else {
        L.setPosition(l.pos.x, l.pos.y, l.pos.z); L.setOrientation(l.fwd.x, l.fwd.y, l.fwd.z, l.up.x, l.up.y, l.up.z);
      }
    }
    if (this.beep && !this.synced) this.advanceBeep(this.estimateTick());
  }

  // ───────── events ─────────
  handle(e: SimEnvelope, local: SnapLocal): void {
    this.localId = local.id;
    this.noteTick(e.tick);
    switch (e.type) {
      case 'sound': this.worldSound(e.data as SimEvents['sound'], e.tick); break;
      case 'hit': {
        const c = hitCue(e.data as SimEvents['hit'], local.id);
        if (c) this.play(c.id, { variant: c.variant, gain: RECIPE_SPEC[c.id].gain, priority: 10 });
        break;
      }
      case 'blinded': { const d = e.data as SimEvents['blinded']; if (d.player === local.id && d.seconds > 0) this.startRing(d.seconds, 1); break; }
      case 'bombPlanted': {
        const d = e.data as SimEvents['bombPlanted'];
        this.beep = { explodeTick: e.tick + BOMB_TIMER_SEC * TICKS, nextTick: e.tick, pos: v3copy(d.pos) }; this.advanceBeep(e.tick);
        if (this.radio.line(e.tick / TICKS)) this.play('radio_bomb', { gain: RECIPE_SPEC.radio_bomb.gain, priority: 2 });
        break;
      }
      case 'bombDefused': this.beep = null; break;
      case 'bombExploded': this.beep = null; this.deafen(); break;
      case 'roundPhase': {
        const d = e.data as SimEvents['roundPhase'];
        if (d.phase === 'FREEZE' || d.phase === 'WARMUP') this.beep = null;
        const id = roundCue('roundPhase', d, this.localTeam);
        if (id) this.play(id, { gain: RECIPE_SPEC[id].gain, priority: 10 });
        break;
      }
      case 'roundEnd': { const id = roundCue('roundEnd', e.data as SimEvents['roundEnd'], this.localTeam); if (id) this.play(id, { gain: RECIPE_SPEC[id].gain, priority: 10 }); break; }
      case 'buy': { const d = e.data as SimEvents['buy']; if (d.player === local.id) { const id: BankId = d.ok ? 'buy' : 'buy_denied'; this.play(id, { gain: RECIPE_SPEC[id].gain, priority: 10 }); } break; }
      case 'spotted': {
        const d = e.data as SimEvents['spotted'];
        if (d.by === local.id) { if (!this.teamExplicit) this.localTeam = d.team; break; }
        if (this.localTeam && d.team === this.localTeam && this.radio.spotted(d.enemy, e.tick / TICKS)) this.play('radio_spotted', { gain: RECIPE_SPEC.radio_spotted.gain, priority: 2 });
        break;
      }
      default: break; // shot, footstep, reload, impact, grenadeBounce…: visuals/HUD only
    }
  }

  ui(id: 'tap' | 'back' | 'buy' | 'denied'): void { const b = UI_SOUNDS[id]; this.play(b, { gain: RECIPE_SPEC[b].gain, priority: 10, dedupe: false }); }

  startAmbient(): void { this.ambientWanted = true; this.ensureAmbient(); }
  stopAmbient(): void {
    this.ambientWanted = false;
    const a = this.ambient, ctx = this.ctx;
    if (!a || !ctx) return;
    const t = ctx.currentTime;
    a.gain.gain.cancelScheduledValues(t); a.gain.gain.setValueAtTime(a.gain.gain.value, t); a.gain.gain.linearRampToValueAtTime(0, t + 0.5);
    try { a.src.stop(t + 0.55); } catch { /* already stopped */ }
    this.ambient = null;
  }

  /** Debug/e2e: bank and voice counters. */
  stats(): { ready: boolean; state: string; buffers: number; bytes: number; voices: number } {
    this.reapVoices();
    return { ready: this.ready, state: this.ctx?.state ?? 'none', buffers: this.bank?.count ?? 0, bytes: this.bank?.totalBytes ?? 0, voices: this.voices.length };
  }

  // ───────── internals ─────────
  private now(): number { return this.ctx ? this.ctx.currentTime : 0; }

  private noteTick(tick: number): void {
    if (tick > this.simTick || tick < this.simTick - 600) { this.simTick = tick; this.simTickAt = this.now(); }
  }
  private estimateTick(): number { return this.simTick + Math.min(MAX_EXTRAPOLATE_SEC, Math.max(0, this.now() - this.simTickAt)) * TICKS; }

  private buildGraph(): void {
    const c = this.ctx!;
    const master = c.createGain();
    const deaf = c.createBiquadFilter(); deaf.type = 'lowpass'; deaf.frequency.value = 20000; deaf.Q.value = 0.707;
    const comp = c.createDynamicsCompressor(); comp.threshold.value = -12; comp.ratio.value = 4;
    master.connect(deaf); deaf.connect(comp); comp.connect(c.destination);
    const sfx = c.createGain();
    const hp = c.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 90;
    sfx.connect(hp); hp.connect(master);
    const mk = (to: AudioNode) => { const g = c.createGain(); g.connect(to); return g; };
    this.buses = { weapons: mk(sfx), impacts: mk(sfx), foley: mk(sfx), explosions: mk(sfx), ui: mk(master), ambient: mk(master) };
    this.master = master; this.sfx = sfx; this.deafLp = deaf;
    this.applyVolumes();
  }

  private applyVolumes(): void {
    if (!this.master || !this.sfx || !this.buses) return;
    this.master.gain.value = BUS_GAIN.master * volumeGain(this.volumes.master);
    this.sfx.gain.value = BUS_GAIN.sfx * volumeGain(this.volumes.sfx);
    this.buses.ui.gain.value = BUS_GAIN.ui * volumeGain(this.volumes.ui);
    this.buses.ambient.gain.value = BUS_GAIN.ambient * volumeGain(this.volumes.sfx);
  }

  private worldSound(d: SimEvents['sound'], tick: number): void {
    if (!this.ready) return;
    let plan = planWorldSound(d, this.localId, this.listener.pos, RECIPE_SPEC[d.id].gain);
    if (!plan.play) return;
    if (plan.occlusionTest && this.world) plan = applyOcclusion(plan, this.world.lineOfSight(this.listener.pos, { x: d.pos.x, y: d.pos.y + SOURCE_LIFT, z: d.pos.z }));
    const variant = variantFor(tick, d.player, this.bank!.variants(d.id));
    // The 25 ms same-id skip is for bots spraying: the player's own (unpanned) sounds are deduped only among themselves.
    const own = !plan.panned && d.player !== 0 && d.player === this.localId;
    this.play(d.id, { variant, gain: plan.gain, priority: plan.priority, pos: plan.panned ? d.pos : null, lowpass: plan.lowpass, maxDistance: plan.maxDistance, dedupeKey: own ? `${d.id}#own` : undefined });
    if (d.id === 'he_explode' && plan.dist < EAR_RING_RANGE) this.startRing(2, 3500 / 4000);
  }

  private reapVoices(): void { if (this.voices.some((v) => v.ended)) this.voices = this.voices.filter((v) => !v.ended); }

  private play(id: BankId, o: PlayOpts): AudioBufferSourceNode | null {
    const ctx = this.ctx, bank = this.bank, buses = this.buses;
    if (!ctx || !bank || !buses || ctx.state !== 'running') return null;
    const buf = bank.get(id, o.variant ?? 0);
    if (!buf) return null;
    if (o.dedupe !== false && !this.dedupe.allow(o.dedupeKey ?? id, ctx.currentTime)) return null;
    this.reapVoices();
    if (this.voices.length >= VOICE_LIMIT) {
      const i = pickVictim(this.voices, o.priority);
      if (i < 0) return null;
      const victim = this.voices[i];
      victim.ended = true;
      try { victim.src.stop(); } catch { /* already stopped */ }
      this.voices.splice(i, 1);
    }
    const src = ctx.createBufferSource(); src.buffer = buf;
    const g = ctx.createGain(); g.gain.value = o.gain;
    src.connect(g);
    const nodes: AudioNode[] = [src, g];
    let tail: AudioNode = g;
    if (o.lowpass) { const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = o.lowpass; f.Q.value = 0.707; tail.connect(f); tail = f; nodes.push(f); }
    if (o.pos) {
      const p = ctx.createPanner();
      p.panningModel = 'equalpower'; p.distanceModel = 'inverse'; p.refDistance = o.refDistance ?? REF_DISTANCE; p.maxDistance = Math.max(p.refDistance + 0.01, o.maxDistance ?? 100); p.rolloffFactor = ROLLOFF;
      if (p.positionX) { p.positionX.value = o.pos.x; p.positionY.value = o.pos.y; p.positionZ.value = o.pos.z; } else p.setPosition(o.pos.x, o.pos.y, o.pos.z);
      tail.connect(p); tail = p; nodes.push(p);
    }
    tail.connect(buses[o.bus ?? busFor(id)]);
    const v: Voice = { src, nodes, priority: o.priority, ended: false, id };
    src.onended = () => { v.ended = true; for (const n of nodes) { try { n.disconnect(); } catch { /* ignore */ } } };
    src.start();
    this.voices.push(v);
    return src;
  }

  private advanceBeep(nowTick: number): void {
    const b = this.beep;
    if (!b) return;
    let played = false;
    while (nowTick >= b.nextTick) {
      const remaining = (b.explodeTick - b.nextTick) / TICKS;
      if (remaining <= 0) { b.nextTick = Infinity; break; }
      if (!played) { this.play('bomb_beep', { gain: RECIPE_SPEC.bomb_beep.gain, priority: 5, pos: b.pos, maxDistance: BEEP_MAX_DISTANCE, refDistance: 3, dedupe: false }); played = true; }
      b.nextTick += Math.max(1, Math.round(beepInterval(remaining) * TICKS));
    }
  }

  /** Flash ring (and the HE "ear ring" at playbackRate 0.875 = 3.5 kHz): a looped 4 kHz sine fading over `seconds`. */
  private startRing(seconds: number, rate: number): void {
    const ctx = this.ctx, buf = this.bank?.get('flash_ring'), buses = this.buses;
    if (!ctx || !buf || !buses || ctx.state !== 'running') return;
    this.stopRing();
    const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true; src.playbackRate.value = rate;
    const g = ctx.createGain(); const t = ctx.currentTime;
    g.gain.setValueAtTime(RECIPE_SPEC.flash_ring.gain, t); g.gain.linearRampToValueAtTime(0, t + seconds);
    src.connect(g); g.connect(buses.explosions);
    src.start(); src.stop(t + seconds + 0.05);
    const ring = { src, gain: g };
    src.onended = () => { try { src.disconnect(); g.disconnect(); } catch { /* ignore */ } if (this.ring === ring) this.ring = null; };
    this.ring = ring;
  }
  private stopRing(): void { const r = this.ring; if (!r) return; this.ring = null; try { r.src.stop(); } catch { /* ignore */ } }

  /** "Deafened": the master lowpass drops after the bomb explodes and recovers over 2 s. */
  private deafen(): void {
    const ctx = this.ctx, f = this.deafLp;
    if (!ctx || !f) return;
    const t = ctx.currentTime;
    f.frequency.cancelScheduledValues(t); f.frequency.setValueAtTime(350, t); f.frequency.exponentialRampToValueAtTime(20000, t + DEAFEN_SEC);
  }

  private ensureAmbient(): void {
    const ctx = this.ctx, buf = this.bank?.get('ambient_hum'), buses = this.buses;
    if (this.ambient || !ctx || !buf || !buses) return;
    const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
    const g = ctx.createGain(); const t = ctx.currentTime;
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(1, t + 1.0);
    src.connect(g); g.connect(buses.ambient); src.start();
    this.ambient = { src, gain: g };
  }

  private armRetry(): void {
    if (this.retryArmed || typeof window === 'undefined') return;
    this.retryArmed = true;
    for (const t of RETRY_EVENTS) window.addEventListener(t, this.onRetry, true);
  }
  private disarmRetry(): void {
    if (!this.retryArmed) return;
    this.retryArmed = false;
    for (const t of RETRY_EVENTS) window.removeEventListener(t, this.onRetry, true);
  }
}
