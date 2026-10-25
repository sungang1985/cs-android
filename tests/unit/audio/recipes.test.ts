import { describe, it, expect } from 'vitest';
import { BANK_IDS, RECIPE_SPEC, renderRecipe, recipeSeed, variantCount, recipeSampleRate, type BankId } from '@/audio/recipes';
import { biquadSweep, loopCrossfade, crackle, zeroCrossingFreq, whiteNoise, biquad, biquadCoeffs, SAMPLE_RATE } from '@/audio/dsp';
import { Rng } from '@/core/rng';

const SOUND_IDS = ['fire_glock', 'fire_usp', 'fire_deagle', 'fire_mp5', 'fire_ak', 'fire_m4', 'fire_awp', 'knife_swing', 'knife_hit', 'knife_stab', 'reload_out', 'reload_in', 'reload_bolt', 'switch_weapon', 'dryfire',
  'footstep_concrete', 'footstep_metal', 'footstep_wood', 'footstep_sand', 'jump', 'land', 'impact_concrete', 'impact_wood', 'impact_metal', 'impact_sand', 'bullet_whiz', 'death',
  'he_pin', 'he_bounce', 'he_explode', 'flash_explode', 'bomb_plant', 'bomb_defuse_tick', 'bomb_defused', 'bomb_explode', 'bomb_pickup'];

/** §9.2 voice gains, copied from the table (the recipe spec must match). */
const TABLE_GAIN: Partial<Record<BankId, number>> = {
  fire_glock: 0.8, fire_usp: 0.5, fire_deagle: 1.0, fire_mp5: 0.55, fire_ak: 0.9, fire_m4: 0.85, fire_awp: 1.0, knife_swing: 0.5, knife_hit: 0.7, knife_stab: 0.7,
  reload_out: 0.6, switch_weapon: 0.4, dryfire: 0.5, footstep_concrete: 0.35, jump: 0.4, land: 0.5, hit_body: 0.7, hit_head: 0.8, hit_armor: 0.6, hitmarker: 0.3, headshot_ding: 0.5,
  impact_metal: 0.5, bullet_whiz: 0.4, death: 0.7, he_explode: 1.0, flash_explode: 1.0, flash_ring: 0.15, bomb_beep: 0.5, bomb_plant: 0.6, bomb_explode: 1.0,
  round_start: 0.5, round_win: 0.6, round_lose: 0.6, buy: 0.5, buy_denied: 0.5, ui_tap: 0.3, ui_back: 0.3, radio_spotted: 0.4, ambient_hum: 0.12,
};

describe('recipes (§9.2)', () => {
  it('covers every SoundId and listener cue exactly once', () => {
    expect(new Set(BANK_IDS).size).toBe(BANK_IDS.length);
    expect(new Set(Object.keys(RECIPE_SPEC))).toEqual(new Set(BANK_IDS));
    for (const id of SOUND_IDS) expect(BANK_IDS).toContain(id);
    expect(BANK_IDS.length).toBe(SOUND_IDS.length + 18);
  });
  it('voice gains follow the table; 2 variants for shots, footsteps, impacts and hits', () => {
    for (const [id, g] of Object.entries(TABLE_GAIN)) expect(RECIPE_SPEC[id as BankId].gain, id).toBe(g);
    for (const id of BANK_IDS) {
      const two = id.startsWith('fire_') || id.startsWith('footstep_') || id.startsWith('impact_') || id.startsWith('hit_');
      expect(variantCount(id), id).toBe(two ? 2 : 1);
    }
    expect(recipeSampleRate('ambient_hum')).toBe(22050);
    expect(recipeSampleRate('fire_ak')).toBe(SAMPLE_RATE);
  });
  for (const id of BANK_IDS) {
    it(`${id}: finite, peak ≤ 1, duration per spec, deterministic`, () => {
      const s = RECIPE_SPEC[id];
      for (let v = 0; v < s.variants; v++) {
        const a = renderRecipe(id, v);
        let peak = 0;
        for (let i = 0; i < a.length; i++) { const x = a[i]; if (!Number.isFinite(x)) throw new Error(`${id}[${v}] sample ${i} = ${x}`); if (Math.abs(x) > peak) peak = Math.abs(x); }
        expect(peak).toBeLessThanOrEqual(1.0);
        expect(peak).toBeGreaterThan(0.3);
        const ms = (a.length / s.sampleRate) * 1000;
        expect(ms).toBeGreaterThanOrEqual(s.ms * 0.9 - 2);
        expect(ms).toBeLessThanOrEqual(s.ms * 1.1 + 2);
        expect(renderRecipe(id, v)).toEqual(a);
      }
      if (s.variants === 2) expect(renderRecipe(id, 1)).not.toEqual(renderRecipe(id, 0));
    });
  }
  it('seeds are 1337 + variant · 7919 + hash(id)', () => {
    expect(recipeSeed('fire_ak', 1) - recipeSeed('fire_ak', 0)).toBe(7919);
    expect(recipeSeed('fire_ak', 0)).not.toBe(recipeSeed('fire_m4', 0));
  });
  it('loops are seamless (flash_ring, ambient_hum): the wrap step is no larger than the steps inside', () => {
    for (const id of ['flash_ring', 'ambient_hum'] as const) {
      const b = renderRecipe(id, 0);
      let maxStep = 0; for (let i = 1; i < b.length; i++) maxStep = Math.max(maxStep, Math.abs(b[i] - b[i - 1]));
      expect(Math.abs(b[0] - b[b.length - 1]), id).toBeLessThanOrEqual(maxStep * 1.05);
    }
  });
  it('the suppressed USP is darker than the Glock; the AWP is the longest shot', () => {
    expect(zeroCrossingFreq(renderRecipe('fire_usp', 0))).toBeLessThan(zeroCrossingFreq(renderRecipe('fire_glock', 0)));
    const lens = BANK_IDS.filter((id) => id.startsWith('fire_')).map((id) => renderRecipe(id, 0).length);
    expect(Math.max(...lens)).toBe(renderRecipe('fire_awp', 0).length);
  });
});

describe('dsp extensions', () => {
  it('biquadCoeffs matches biquad', () => {
    const x = whiteNoise(0.05, new Rng(3));
    const ref = biquad(x.slice(), 'bandpass', 1000, 2);
    const c = biquadCoeffs('bandpass', 1000, 2);
    const y = x.slice(); let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < y.length; i++) { const x0 = y[i]; const o = c[0] * x0 + c[1] * x1 + c[2] * x2 - c[3] * y1 - c[4] * y2; x2 = x1; x1 = x0; y2 = y1; y1 = o; y[i] = o; }
    for (let i = 0; i < y.length; i++) expect(y[i]).toBeCloseTo(ref[i], 5);
  });
  it('biquadSweep moves the passband over time', () => {
    const b = biquadSweep(whiteNoise(1, new Rng(4)), 'lowpass', 8000, 200);
    const n = b.length;
    expect(zeroCrossingFreq(b.subarray(0, n / 5))).toBeGreaterThan(2 * zeroCrossingFreq(b.subarray((4 * n) / 5)));
  });
  it('loopCrossfade returns the loop length; crackle is deterministic', () => {
    expect(loopCrossfade(new Float32Array(1000).fill(1), 0.01, 0.002).length).toBe(Math.round(0.01 * SAMPLE_RATE));
    expect(crackle(0.1, 5, new Rng(9))).toEqual(crackle(0.1, 5, new Rng(9)));
  });
});
