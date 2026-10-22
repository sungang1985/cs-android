/** Sound recipes (§9.2). DAY-0 STUB: short generic bursts per id; L7 implements every recipe on dsp.ts. */
import { Rng } from '../core/rng';
import type { SoundId } from '../sim/events';
import { whiteNoise, expDecay, biquad, normalize, oscillator, mix } from './dsp';

export type BankId = SoundId | 'hitmarker' | 'headshot_ding' | 'hit_body' | 'hit_head' | 'hit_armor' | 'flash_ring' | 'bomb_beep' | 'round_start' | 'round_win' | 'round_lose' | 'buy' | 'buy_denied' | 'ui_tap' | 'ui_back' | 'radio_spotted' | 'radio_bomb' | 'radio_rotate' | 'ambient_hum';

export const BANK_IDS: readonly BankId[] = [
  'fire_glock', 'fire_usp', 'fire_deagle', 'fire_mp5', 'fire_ak', 'fire_m4', 'fire_awp', 'knife_swing', 'knife_hit', 'knife_stab', 'reload_out', 'reload_in', 'reload_bolt', 'switch_weapon', 'dryfire',
  'footstep_concrete', 'footstep_metal', 'footstep_wood', 'footstep_sand', 'jump', 'land', 'impact_concrete', 'impact_wood', 'impact_metal', 'impact_sand', 'bullet_whiz', 'death',
  'he_pin', 'he_bounce', 'he_explode', 'flash_explode', 'bomb_plant', 'bomb_defuse_tick', 'bomb_defused', 'bomb_explode', 'bomb_pickup',
  'hitmarker', 'headshot_ding', 'hit_body', 'hit_head', 'hit_armor', 'flash_ring', 'bomb_beep', 'round_start', 'round_win', 'round_lose', 'buy', 'buy_denied', 'ui_tap', 'ui_back', 'radio_spotted', 'radio_bomb', 'radio_rotate', 'ambient_hum',
];

export function renderRecipe(id: BankId, variant: number): Float32Array {
  const rng = new Rng(1337 + variant * 7919 + hash(id));
  if (id.startsWith('fire_')) return normalize(mix([{ buf: expDecay(biquad(whiteNoise(0.12, rng), 'lowpass', 3000), 0.03) }, { buf: expDecay(oscillator(0.08, (t) => Math.max(40, 150 - 1200 * t), 'sine'), 0.03), gain: 0.6 }]), 0.9);
  if (id.startsWith('footstep_') || id === 'jump' || id === 'land') return normalize(expDecay(biquad(whiteNoise(0.08, rng), 'lowpass', 900), 0.02), 0.4);
  if (id.startsWith('impact_')) return normalize(expDecay(biquad(whiteNoise(0.06, rng), 'bandpass', 2500, 1), 0.015), 0.5);
  if (id === 'he_explode' || id === 'bomb_explode') return normalize(expDecay(biquad(whiteNoise(1.2, rng), 'lowpass', 300), 0.3), 1);
  if (id === 'ambient_hum') return normalize(biquad(whiteNoise(2.0, rng), 'lowpass', 120), 0.12);
  if (id === 'bomb_beep') return normalize(expDecay(oscillator(0.05, 2500, 'square'), 0.02), 0.5);
  return normalize(expDecay(oscillator(0.08, 1200 + (hash(id) % 800)), 0.03), 0.5);
}

function hash(s: string): number { let h = 2166136261 >>> 0; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h >>> 0; }
