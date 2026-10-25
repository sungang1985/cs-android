/**
 * Sound recipes (§9.2), pure: every BankId is a deterministic function of (id, variant) built on audio/dsp.ts,
 * seeded with `new Rng(1337 + variant · 7919 + hash(id))` (never the match seed, never Math.random). Output is
 * mono, peak ≤ 0.95, at 44.1 kHz (ambient_hum: a 2 s seamless loop at 22.05 kHz). The voice gain of the table
 * is NOT baked in: the engine applies RECIPE_SPEC[id].gain. 'fire_distant_*' are not ids: the engine puts the
 * same buffers through a 600 Hz lowpass beyond 25 m.
 */
import { Rng } from '../core/rng';
import type { SoundId } from '../sim/events';
import {
  SAMPLE_RATE, whiteNoise, pinkNoise, oscillator, adsr, expDecay, biquad, biquadSweep, softClip, mix, echo, gain, normalize, fadeIn, fadeOut,
  loopCrossfade, crackle, type Mono, type Wave,
} from './dsp';

export type BankId = SoundId | 'hitmarker' | 'headshot_ding' | 'hit_body' | 'hit_head' | 'hit_armor' | 'flash_ring' | 'bomb_beep' | 'round_start' | 'round_win' | 'round_lose' | 'buy' | 'buy_denied' | 'ui_tap' | 'ui_back' | 'radio_spotted' | 'radio_bomb' | 'radio_rotate' | 'ambient_hum';

export const BANK_IDS: readonly BankId[] = [
  'fire_glock', 'fire_usp', 'fire_deagle', 'fire_mp5', 'fire_ak', 'fire_m4', 'fire_awp', 'knife_swing', 'knife_hit', 'knife_stab', 'reload_out', 'reload_in', 'reload_bolt', 'switch_weapon', 'dryfire',
  'footstep_concrete', 'footstep_metal', 'footstep_wood', 'footstep_sand', 'jump', 'land', 'impact_concrete', 'impact_wood', 'impact_metal', 'impact_sand', 'bullet_whiz', 'death',
  'he_pin', 'he_bounce', 'he_explode', 'flash_explode', 'bomb_plant', 'bomb_defuse_tick', 'bomb_defused', 'bomb_explode', 'bomb_pickup',
  'hitmarker', 'headshot_ding', 'hit_body', 'hit_head', 'hit_armor', 'flash_ring', 'bomb_beep', 'round_start', 'round_win', 'round_lose', 'buy', 'buy_denied', 'ui_tap', 'ui_back', 'radio_spotted', 'radio_bomb', 'radio_rotate', 'ambient_hum',
];

export interface RecipeSpec { /** nominal duration (ms) per the §9.2 table */ ms: number; /** voice gain before the bus */ gain: number; variants: 1 | 2; sampleRate: number }

const SR = SAMPLE_RATE, AMBIENT_SR = 22050;
function spec(ms: number, g: number, variants: 1 | 2 = 1, sampleRate = SR): RecipeSpec { return { ms, gain: g, variants, sampleRate }; }

/** §9.2: durations, voice gains, variants (2 for shots, footsteps, impacts and hits). */
export const RECIPE_SPEC: Record<BankId, RecipeSpec> = {
  fire_glock: spec(60, 0.8, 2), fire_usp: spec(60, 0.5, 2), fire_deagle: spec(260, 1.0, 2), fire_mp5: spec(45, 0.55, 2), fire_ak: spec(210, 0.9, 2), fire_m4: spec(160, 0.85, 2), fire_awp: spec(950, 1.0, 2),
  knife_swing: spec(120, 0.5), knife_hit: spec(60, 0.7), knife_stab: spec(85, 0.7),
  reload_out: spec(95, 0.6), reload_in: spec(130, 0.6), reload_bolt: spec(165, 0.6), switch_weapon: spec(85, 0.4), dryfire: spec(15, 0.5),
  footstep_concrete: spec(60, 0.35, 2), footstep_metal: spec(200, 0.35, 2), footstep_wood: spec(60, 0.35, 2), footstep_sand: spec(80, 0.35, 2), jump: spec(80, 0.4), land: spec(80, 0.5),
  impact_concrete: spec(120, 0.5, 2), impact_wood: spec(60, 0.5, 2), impact_metal: spec(250, 0.5, 2), impact_sand: spec(60, 0.5, 2), bullet_whiz: spec(120, 0.4), death: spec(400, 0.7),
  he_pin: spec(155, 1.0), he_bounce: spec(250, 1.0), he_explode: spec(700, 1.0), flash_explode: spec(200, 1.0),
  bomb_plant: spec(480, 0.6), bomb_defuse_tick: spec(25, 0.6), bomb_defused: spec(650, 0.6), bomb_explode: spec(1600, 1.0), bomb_pickup: spec(80, 0.6),
  hitmarker: spec(15, 0.3), headshot_ding: spec(100, 0.5), hit_body: spec(70, 0.7, 2), hit_head: spec(70, 0.8, 2), hit_armor: spec(60, 0.6, 2),
  flash_ring: spec(250, 0.15), bomb_beep: spec(40, 0.5), round_start: spec(240, 0.5), round_win: spec(500, 0.6), round_lose: spec(500, 0.6),
  buy: spec(120, 0.5), buy_denied: spec(120, 0.5), ui_tap: spec(10, 0.3), ui_back: spec(10, 0.3),
  radio_spotted: spec(330, 0.4), radio_bomb: spec(330, 0.4), radio_rotate: spec(330, 0.4), ambient_hum: spec(2000, 0.12, 1, AMBIENT_SR),
};

export function variantCount(id: BankId): number { return RECIPE_SPEC[id].variants; }
export function recipeSampleRate(id: BankId): number { return RECIPE_SPEC[id].sampleRate; }

// ───────── shorthand (§9.1 mapping) — all durations in ms ─────────
const sec = (ms: number) => ms / 1000;
const noise = (ms: number, rng: Rng) => whiteNoise(sec(ms), rng);
const pink = (ms: number, rng: Rng) => pinkNoise(sec(ms), rng);
/** brown = pinkNoise + biquad lowpass 200 Hz */
const brown = (ms: number, rng: Rng, sr = SR) => normalize(biquad(pinkNoise(sec(ms), rng, sr), 'lowpass', 200, 0.707, 0, sr), 1);
/** tone f0 → f1 (exponential sweep) */
const tone = (ms: number, f0: number, f1 = f0, wave: Wave = 'sine') => oscillator(sec(ms), f1 === f0 ? f0 : (t: number) => f0 * Math.pow(f1 / f0, t / sec(ms)), wave);
const env = (b: Mono, aMs: number, dMs: number, s = 0, rMs = 0) => adsr(b, sec(aMs), sec(dMs), s, sec(rMs));
const decay = (b: Mono, tauMs: number) => expDecay(b, sec(tauMs));
const lp = (b: Mono, f: number, q = 0.707) => biquad(b, 'lowpass', f, q);
const hp = (b: Mono, f: number, q = 0.707) => biquad(b, 'highpass', f, q);
const bp = (b: Mono, f: number, q = 1) => biquad(b, 'bandpass', f, q);
/** distort amount 0..1 → tanh drive 1..5 */
const distort = (b: Mono, amount: number) => softClip(b, 1 + 4 * amount);
const click = (ms: number, rng: Rng) => decay(noise(ms, rng), ms / 3);
type Part = { buf: Mono; at?: number; gain?: number };
const layer = (...parts: Part[]) => mix(parts.map((p) => ({ buf: p.buf, at: sec(p.at ?? 0), gain: p.gain ?? 1 })));
/** declick + peak-normalise (peak ≤ 0.95) */
const finish = (b: Mono, peak = 0.95) => normalize(fadeOut(fadeIn(b, 0.0005), Math.min(0.004, b.length / SR / 4)), peak);
const metalClick = (rng: Rng) => layer({ buf: decay(tone(8, 2400), 3) }, { buf: decay(hp(noise(15, rng), 3000), 5), gain: 0.7 });
const note = (ms: number, f: number, wave: Wave) => env(tone(ms, f, f, wave), 4, 20, 0.7, 40);

// ───────── building blocks shared by several ids ─────────
function shot(rng: Rng, o: { noiseMs: number; filt: (b: Mono) => Mono; f0: number; f1: number; toneMs: number; drive?: number; tailMs?: number; tailLp?: number }): Mono {
  const p = rng.range(0.97, 1.03);
  const body = env(o.filt(noise(o.noiseMs, rng)), 1, o.noiseMs - 1);
  const thump = decay(tone(o.toneMs, o.f0 * p, o.f1 * p), o.toneMs / 2.5);
  let b = layer({ buf: body }, { buf: thump, gain: 0.9 }, { buf: click(1, rng), gain: 0.6 });
  if (o.drive) b = distort(b, o.drive);
  if (o.tailMs) { let tail = decay(brown(o.tailMs, rng), o.tailMs / 3); if (o.tailLp) tail = lp(tail, o.tailLp); b = layer({ buf: b }, { buf: tail, at: 8, gain: 0.45 }); }
  return b;
}
function footstep(rng: Rng, kind: 'concrete' | 'metal' | 'wood' | 'sand'): Mono {
  const p = rng.range(0.9, 1.1); // pitch ±10 %
  switch (kind) {
    case 'concrete': return layer({ buf: env(lp(noise(60, rng), 900 * p), 2, 55) }, { buf: decay(tone(30, 90 * p), 12), gain: 0.8 });
    case 'metal': return layer({ buf: env(bp(noise(50, rng), 1800 * p, 3), 1, 45) }, { buf: decay(tone(200, 320 * p), 60), gain: 0.35 });
    case 'wood': return layer({ buf: env(lp(noise(60, rng), 500 * p), 2, 55) }, { buf: decay(tone(40, 180 * p), 15), gain: 0.7 });
    case 'sand': return layer({ buf: env(lp(noise(80, rng), 700 * p), 8, 70) }, { buf: hp(crackle(sec(70), 6, rng), 1500), gain: 0.25 });
  }
}
function impactMetal(rng: Rng): Mono {
  const p = rng.range(0.95, 1.05);
  return layer({ buf: decay(tone(250, 1400 * p), 70), gain: 0.5 }, { buf: decay(tone(250, 2100 * p), 50), gain: 0.4 }, { buf: decay(noise(15, rng), 4), gain: 0.6 });
}
function hitBody(rng: Rng): Mono { return layer({ buf: env(lp(brown(70, rng), 500), 1, 65) }, { buf: decay(tone(70, 110, 60), 25), gain: 0.8 }); }
function explosion(rng: Rng, ms: number, sub: boolean): Mono {
  const body = distort(env(biquadSweep(brown(ms, rng), 'lowpass', 300, 80), 2, ms - 2), 0.9);
  const parts: Part[] = [{ buf: decay(body, ms / 3) }, { buf: decay(crackle(sec(300), 40, rng), 120), gain: 0.5 }, { buf: decay(lp(noise(60, rng), 2500), 15), gain: 0.6 }];
  if (sub) parts.push({ buf: decay(tone(ms, 20), ms / 2.5), gain: 0.8 });
  return layer(...parts);
}
function blips(rng: Rng, dirs: readonly (1 | -1)[]): Mono {
  const parts: Part[] = dirs.map((d, i) => ({ buf: env(biquadSweep(noise(90, rng), 'bandpass', d > 0 ? 400 : 1200, d > 0 ? 1200 : 400, 4), 10, 30, 0.6, 30), at: i * 120 }));
  return layer(...parts);
}

type Recipe = (rng: Rng, variant: number) => Mono;
const R: Record<BankId, Recipe> = {
  fire_glock: (r) => shot(r, { noiseMs: 60, filt: (b) => lp(b, 4000), f0: 180, f1: 60, toneMs: 40 }),
  fire_usp: (r) => lp(shot(r, { noiseMs: 60, filt: (b) => lp(b, 4000), f0: 180, f1: 60, toneMs: 40 }), 1800),
  fire_deagle: (r) => shot(r, { noiseMs: 110, filt: (b) => lp(b, 2500), f0: 120, f1: 40, toneMs: 80, drive: 0.6, tailMs: 250 }),
  fire_mp5: (r) => lp(shot(r, { noiseMs: 45, filt: (b) => bp(b, 3000, 1), f0: 220, f1: 90, toneMs: 25 }), 2000),
  fire_ak: (r) => shot(r, { noiseMs: 90, filt: (b) => lp(b, 3000), f0: 150, f1: 55, toneMs: 60, drive: 0.5, tailMs: 200 }),
  fire_m4: (r) => shot(r, { noiseMs: 70, filt: (b) => bp(b, 2200, 0.9), f0: 200, f1: 70, toneMs: 50, tailMs: 150 }),
  fire_awp: (r) => fadeOut(echo(shot(r, { noiseMs: 180, filt: (b) => lp(b, 1500), f0: 90, f1: 30, toneMs: 150, drive: 0.8, tailMs: 600, tailLp: 800 }), 0.08, 0.35, 1).slice(0, Math.round(0.95 * SR)), 0.15),
  knife_swing: (r) => env(biquadSweep(pink(120, r), 'bandpass', 700, 2200, 1.5), 45, 75),
  knife_hit: (r) => layer({ buf: env(noise(40, r), 1, 38) }, { buf: decay(tone(60, 400, 200), 20), gain: 0.8 }),
  knife_stab: (r) => layer({ buf: env(noise(40, r), 1, 38) }, { buf: decay(tone(60, 400, 200), 20), gain: 0.8 }, { buf: normalize(decay(lp(noise(80, r), 300), 30), 0.9), at: 5, gain: 0.9 }, { buf: decay(tone(80, 70), 25), at: 5, gain: 0.6 }),
  reload_out: (r) => layer({ buf: metalClick(r) }, { buf: metalClick(r), at: 40 }, { buf: metalClick(r), at: 80 }),
  reload_in: (r) => layer({ buf: metalClick(r) }, { buf: metalClick(r), at: 40 }, { buf: metalClick(r), at: 80 }, { buf: decay(tone(50, 60), 18), at: 80, gain: 0.9 }),
  reload_bolt: (r) => layer({ buf: env(bp(noise(150, r), 900, 1.2), 20, 125) }, { buf: metalClick(r), at: 150, gain: 0.9 }),
  switch_weapon: (r) => layer({ buf: decay(noise(12, r), 3), gain: 0.8 }, { buf: env(lp(noise(80, r), 2000), 10, 65), at: 5, gain: 0.7 }),
  dryfire: (r) => layer({ buf: decay(tone(15, 1800), 4) }, { buf: decay(noise(5, r), 1.5), gain: 0.5 }),
  footstep_concrete: (r) => footstep(r, 'concrete'),
  footstep_metal: (r) => footstep(r, 'metal'),
  footstep_wood: (r) => footstep(r, 'wood'),
  footstep_sand: (r) => footstep(r, 'sand'),
  jump: (r) => env(lp(noise(80, r), 400), 10, 70),
  land: (r) => layer({ buf: gain(footstep(r, 'concrete'), 1.5) }, { buf: decay(tone(80, 50), 30), gain: 1.2 }),
  impact_concrete: (r) => layer({ buf: env(bp(noise(40, r), 2500, 1), 1, 38) }, { buf: hp(crackle(sec(120), 10, r), 2000), gain: 0.5 }),
  impact_wood: (r) => layer({ buf: env(lp(noise(50, r), 1200), 1, 48) }, { buf: decay(tone(60, 180), 18), gain: 0.8 }),
  impact_metal: (r) => impactMetal(r),
  impact_sand: (r) => env(lp(noise(60, r), 700), 2, 56),
  bullet_whiz: (r) => env(biquadSweep(noise(120, r), 'bandpass', 2500, 1200, 2), 40, 80),
  death: (r) => layer({ buf: distort(lp(env(tone(200, 180, 90, 'saw'), 5, 190), 1000), 0.5), gain: 0.7 }, { buf: decay(lp(brown(300, r), 150), 90), at: 100 }),
  he_pin: (r) => layer({ buf: metalClick(r) }, { buf: decay(tone(150, 1600), 45), at: 6, gain: 0.45 }),
  he_bounce: (r) => normalize(impactMetal(r), 0.95 * 0.5),
  he_explode: (r) => explosion(r, 700, false),
  flash_explode: (r) => layer({ buf: env(hp(noise(200, r), 2000), 1, 195) }, { buf: decay(tone(150, 2400), 60), gain: 0.5 }),
  // 4 kHz × 0.25 s = 1,000 whole cycles → loops seamlessly; the engine envelopes it over the blind duration
  flash_ring: () => oscillator(0.25, 4000, 'sine'),
  bomb_beep: () => lp(env(tone(40, 2500, 2500, 'square'), 1, 6, 0.8, 10), 7000),
  bomb_plant: (r) => layer(...[0, 110, 220, 330].map((at) => ({ buf: note(60, 1200, 'square'), at, gain: 0.5 })), { buf: env(bp(noise(480, r), 600, 2), 40, 80, 0.6, 120), gain: 0.4 }),
  bomb_defuse_tick: (r) => layer({ buf: decay(hp(noise(25, r), 2000), 6) }, { buf: decay(tone(20, 3000), 5), gain: 0.3 }),
  bomb_defused: () => layer({ buf: decay(tone(300, 1318.5), 100) }, { buf: decay(tone(300, 1046.5), 100), at: 150 }, { buf: decay(tone(350, 880), 120), at: 300 }),
  bomb_explode: (r) => explosion(r, 1600, true),
  bomb_pickup: (r) => layer({ buf: env(lp(noise(80, r), 1500), 5, 70) }, { buf: metalClick(r), at: 60, gain: 0.8 }),
  hitmarker: () => env(tone(15, 1400, 1400, 'square'), 1, 13),
  headshot_ding: () => layer({ buf: decay(tone(100, 1800), 35) }, { buf: decay(tone(80, 2700), 25), gain: 0.6 }),
  hit_body: (r) => hitBody(r),
  // variant 0 = helmet tink, variant 1 = wet (the engine picks by `hit.armored`)
  hit_head: (r, v) => v === 0 ? layer({ buf: hitBody(r) }, { buf: decay(tone(60, 2600), 15), gain: 0.5 }) : layer({ buf: hitBody(r) }, { buf: env(bp(noise(60, r), 1000, 2), 2, 55), gain: 0.9 }),
  hit_armor: (r) => layer({ buf: decay(tone(60, 900 * r.range(0.97, 1.03)), 18) }, { buf: decay(noise(20, r), 5), gain: 0.5 }),
  round_start: () => layer({ buf: lp(note(120, 660, 'square'), 4000) }, { buf: lp(note(120, 880, 'square'), 4000), at: 120 }),
  round_win: () => layer({ buf: note(150, 523.25, 'triangle') }, { buf: note(150, 659.25, 'triangle'), at: 150 }, { buf: env(tone(200, 783.99, 783.99, 'triangle'), 4, 30, 0.7, 120), at: 300 }),
  round_lose: () => layer({ buf: note(150, 392, 'triangle') }, { buf: note(150, 311.13, 'triangle'), at: 150 }, { buf: env(tone(200, 261.63, 261.63, 'triangle'), 4, 30, 0.7, 120), at: 300 }),
  buy: () => layer({ buf: env(tone(60, 1200), 2, 20, 0.6, 20) }, { buf: env(tone(60, 1800), 2, 20, 0.6, 30), at: 60 }),
  buy_denied: () => lp(env(tone(120, 200, 200, 'square'), 3, 20, 0.7, 40), 2000),
  ui_tap: () => decay(tone(10, 3000), 3),
  ui_back: () => decay(tone(10, 1500), 3),
  radio_spotted: (r) => blips(r, [1, 1, 1]),
  radio_bomb: (r) => blips(r, [1, 1, -1]),
  radio_rotate: (r) => blips(r, [-1, 1, -1]),
  ambient_hum: (r) => {
    // 2.2 s rendered, 0.2 s cross-faded into the head → a 2.0 s seamless loop; the 50 Hz hum has 100 whole cycles
    const n = brown(2200, r, AMBIENT_SR);
    const bed = biquad(n, 'lowpass', 120, 0.707, 0, AMBIENT_SR);
    const hum = oscillator(2.2, 50, 'sine', AMBIENT_SR), h2 = oscillator(2.2, 100, 'sine', AMBIENT_SR);
    const sum = new Float32Array(bed.length);
    const peak = bed.reduce((m, v) => Math.max(m, Math.abs(v)), 1e-9);
    for (let i = 0; i < sum.length; i++) sum[i] = (bed[i] / peak) * 0.7 + hum[i] * 0.25 + h2[i] * 0.08;
    return normalize(loopCrossfade(sum, 2.0, 0.2, AMBIENT_SR), 0.95);
  },
};

/** Ids whose buffer must not be declicked at the ends (loops). */
const LOOPS: ReadonlySet<BankId> = new Set<BankId>(['flash_ring', 'ambient_hum']);

export function recipeSeed(id: BankId, variant: number): number { return (1337 + variant * 7919 + hash(id)) >>> 0; }

export function renderRecipe(id: BankId, variant: number): Float32Array {
  const rng = new Rng(recipeSeed(id, variant));
  const raw = R[id](rng, variant);
  if (LOOPS.has(id)) return normalize(raw, 0.95);
  return id === 'he_bounce' ? finish(raw, 0.95 * 0.5) : finish(raw);
}

function hash(s: string): number { let h = 2166136261 >>> 0; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h >>> 0; }
