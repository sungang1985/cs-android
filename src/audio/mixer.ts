/**
 * Pure mixing decisions of the audio engine (§9.3), testable without an AudioContext: bus routing, volume
 * curve, variant selection, voice priority/stealing, the same-id dedupe window, world-sound planning
 * (own sounds unpanned, bot footsteps ≤ 14 m, gunfire always, distant lowpass > 25 m, global sounds),
 * occlusion, the bomb-beep interval and the listener-relative cues derived from specific events.
 */
import { clamp, v3dist, type Vec3 } from '../core/math';
import type { SimEvents } from '../sim/events';
import type { Team } from '../sim/state';
import type { BankId } from './recipes';

export type BusId = 'weapons' | 'impacts' | 'foley' | 'explosions' | 'ui' | 'ambient';

export const VOICE_LIMIT = 24;
export const DEDUPE_SEC = 0.025;
export const BOT_FOOTSTEP_RANGE = 14;
export const DISTANT_RANGE = 25;
export const DISTANT_LOWPASS = 600;
export const OCCLUDED_LOWPASS = 700;
export const OCCLUDED_GAIN = 0.5;          // −6 dB
export const REF_DISTANCE = 1.5;
export const ROLLOFF = 1.2;
export const GLOBAL_LOUDNESS = 1000;
export const BOMB_TIMER_SEC = 35;
export const EAR_RING_RANGE = 4;
export const DEAFEN_SEC = 2;
export const BUS_GAIN = { master: 0.8, sfx: 1.0, ui: 0.7, ambient: 0.12 } as const;

export function busFor(id: BankId): BusId {
  if (id === 'ambient_hum') return 'ambient';
  if (id.startsWith('fire_') || id.startsWith('knife_') || id.startsWith('reload_') || id === 'switch_weapon' || id === 'dryfire') return 'weapons';
  if (id.startsWith('impact_') || id.startsWith('hit_') || id === 'bullet_whiz' || id === 'he_bounce' || id === 'hitmarker' || id === 'headshot_ding') return 'impacts';
  if (id === 'he_explode' || id === 'flash_explode' || id === 'bomb_explode' || id === 'flash_ring') return 'explosions';
  if (id.startsWith('round_') || id === 'buy' || id === 'buy_denied' || id === 'ui_tap' || id === 'ui_back' || id.startsWith('radio_')) return 'ui';
  return 'foley';
}

/** Settings slider 0–100 → gain (v / 100)². */
export function volumeGain(v: number): number { const x = clamp(v, 0, 100) / 100; return x * x; }

/** Deterministic variant choice for world sounds: (tick + player) % variants (no RNG). */
export function variantFor(tick: number, player: number, variants: number): number {
  if (variants <= 1) return 0;
  return (((tick + player) % variants) + variants) % variants;
}

/** Voice priority = gain / distance (distance floored at 1 m; unpanned voices count as 1 m). */
export function voicePriority(gain: number, dist: number): number { return gain / Math.max(1, dist); }

/** With every voice busy: index of the lowest-priority voice to steal for a new one of `priority`, or −1 to drop the new one. */
export function pickVictim(voices: ReadonlyArray<{ priority: number }>, priority: number): number {
  let lo = -1, loP = Infinity;
  for (let i = 0; i < voices.length; i++) if (voices[i].priority < loP) { loP = voices[i].priority; lo = i; }
  return lo >= 0 && loP < priority ? lo : -1;
}

/** WebAudio PannerNode 'inverse' distance gain (for priority estimates and tests). */
export function inverseDistanceGain(d: number, ref = REF_DISTANCE, max = 10000, rolloff = ROLLOFF): number {
  const dc = clamp(d, ref, Math.max(ref, max));
  return ref / (ref + rolloff * (dc - ref));
}

/** "The same id within 25 ms is skipped" (bots spraying). */
export class DedupeClock {
  private readonly last = new Map<string, number>();
  constructor(private readonly window = DEDUPE_SEC) {}
  allow(id: string, now: number): boolean {
    const t = this.last.get(id);
    if (t !== undefined && now - t < this.window && now >= t) return false;
    this.last.set(id, now);
    return true;
  }
  clear(): void { this.last.clear(); }
}

export interface WorldSoundPlan { play: boolean; panned: boolean; gain: number; lowpass: number | null; occlusionTest: boolean; dist: number; priority: number; maxDistance: number }

/**
 * Sounds emitted at the emitting player's own body/weapon. For the local player these play unpanned; his
 * impacts, whizzes and grenade bursts stay positioned in the world.
 */
export function isBodySound(id: BankId): boolean {
  return id.startsWith('fire_') || id.startsWith('knife_') || id.startsWith('reload_') || id.startsWith('footstep_') || id === 'switch_weapon' || id === 'dryfire'
    || id === 'he_pin' || id === 'jump' || id === 'land' || id === 'death' || id === 'bomb_plant' || id === 'bomb_defuse_tick' || id === 'bomb_pickup';
}

/** Decides how a `sound` event is played relative to the listener (occlusion is applied afterwards). */
export function planWorldSound(s: SimEvents['sound'], localId: number, listener: Vec3, baseGain: number): WorldSoundPlan {
  const own = s.player !== 0 && s.player === localId && isBodySound(s.id);
  const global = s.loudness >= GLOBAL_LOUDNESS;
  const dist = own || global ? 0 : v3dist(s.pos, listener);
  const gunfire = s.id.startsWith('fire_');
  const plan: WorldSoundPlan = { play: true, panned: !own && !global, gain: baseGain, lowpass: null, occlusionTest: !own && !global, dist, priority: voicePriority(baseGain, dist), maxDistance: Math.max(REF_DISTANCE + 0.01, Math.min(s.loudness, 200)) };
  if (own || global) return plan;
  if (s.id.startsWith('footstep_') && dist > BOT_FOOTSTEP_RANGE) plan.play = false;
  else if (!gunfire && dist > s.loudness) plan.play = false;   // beyond its hearing radius; gunfire is always a cue
  if (gunfire && dist > DISTANT_RANGE) plan.lowpass = DISTANT_LOWPASS;
  return plan;
}

/** Blocked line of sight at play start → lowpass 700 Hz and −6 dB. */
export function applyOcclusion(plan: WorldSoundPlan, lineOfSight: boolean): WorldSoundPlan {
  if (lineOfSight) return plan;
  return { ...plan, lowpass: Math.min(plan.lowpass ?? OCCLUDED_LOWPASS, OCCLUDED_LOWPASS), gain: plan.gain * OCCLUDED_GAIN, priority: plan.priority * OCCLUDED_GAIN };
}

/** Bomb beep period (s): 1.0 · (remaining / 35)^1.6 + 0.05. */
export function beepInterval(remainingSec: number): number { return 1.0 * Math.pow(clamp(remainingSec, 0, BOMB_TIMER_SEC) / BOMB_TIMER_SEC, 1.6) + 0.05; }

/** Listener-relative hit feedback: the victim's cue wins over the attacker's (self-damage). */
export function hitCue(h: SimEvents['hit'], localId: number): { id: BankId; variant: number } | null {
  if (h.victim === localId) {
    if (h.zone === 'head') return { id: 'hit_head', variant: h.armored ? 0 : 1 };
    return { id: h.armored ? 'hit_armor' : 'hit_body', variant: 0 };
  }
  if (h.attacker === localId) return { id: h.zone === 'head' ? 'headshot_ding' : 'hitmarker', variant: 0 };
  return null;
}

/** Round stingers: round_start on LIVE; round_win/lose on roundEnd against the local team (draw/unknown → none). */
export function roundCue(type: 'roundPhase' | 'roundEnd', data: SimEvents['roundPhase'] | SimEvents['roundEnd'], localTeam: Team | null): BankId | null {
  if (type === 'roundPhase') return (data as SimEvents['roundPhase']).phase === 'LIVE' ? 'round_start' : null;
  const w = (data as SimEvents['roundEnd']).winner;
  if (!w || !localTeam) return null;
  return w === localTeam ? 'round_win' : 'round_lose';
}

/**
 * Radio stand-ins: a teammate (not the human) spotting an enemy unseen for ≥ 10 s plays `radio_spotted`;
 * at most one radio line every 4 s.
 */
export class RadioLimiter {
  private lastLine = -Infinity;
  private readonly seen = new Map<number, number>();
  constructor(private readonly gapSec = 4, private readonly forgetSec = 10) {}
  spotted(enemy: number, now: number): boolean {
    const prev = this.seen.get(enemy);
    this.seen.set(enemy, now);
    if (prev !== undefined && now - prev < this.forgetSec) return false;
    return this.line(now);
  }
  line(now: number): boolean { if (now - this.lastLine < this.gapSec) return false; this.lastLine = now; return true; }
  clear(): void { this.seen.clear(); this.lastLine = -Infinity; }
}

/** UI click ids → bank ids. */
export const UI_SOUNDS: Record<'tap' | 'back' | 'buy' | 'denied', BankId> = { tap: 'ui_tap', back: 'ui_back', buy: 'buy', denied: 'buy_denied' };
