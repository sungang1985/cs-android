import { describe, it, expect } from 'vitest';
import { whiteNoise, pinkNoise, oscillator, expDecay, adsr, biquad, mix, normalize, rms, zeroCrossingFreq, softClip, echo, fadeOut } from '@/audio/dsp';
import { Rng } from '@/core/rng';

describe('dsp', () => {
  it('oscillator frequency is accurate and sweeps', () => {
    const s = oscillator(1, 440);
    expect(Math.abs(zeroCrossingFreq(s) - 440)).toBeLessThan(2);
    const chirp = oscillator(0.5, (t) => 880 - 800 * t);
    expect(zeroCrossingFreq(chirp.subarray(0, 4410))).toBeGreaterThan(zeroCrossingFreq(chirp.subarray(4410 * 4, 4410 * 5)));
  });
  it('noise is deterministic and roughly zero-mean', () => {
    const a = whiteNoise(0.1, new Rng(1)), b = whiteNoise(0.1, new Rng(1));
    expect(a).toEqual(b);
    let m = 0; for (const v of a) m += v; expect(Math.abs(m / a.length)).toBeLessThan(0.05);
    expect(rms(pinkNoise(0.2, new Rng(2)))).toBeGreaterThan(0.05);
  });
  it('envelopes decay', () => {
    const s = expDecay(new Float32Array(44100).fill(1), 0.1);
    expect(s[0]).toBeCloseTo(1); expect(s[44100 - 1]).toBeLessThan(0.001);
    const e = adsr(new Float32Array(1000).fill(1), 0.002, 0.002, 0.5, 0.002);
    expect(e[0]).toBe(0); expect(e[500]).toBeCloseTo(0.5); expect(e[999]).toBeCloseTo(0, 1);
  });
  it('lowpass removes highs, highpass removes lows', () => {
    const lo = oscillator(0.5, 100), hi = oscillator(0.5, 8000);
    const mixed = mix([{ buf: lo }, { buf: hi }]);
    const lp = biquad(Float32Array.from(mixed), 'lowpass', 500);
    expect(zeroCrossingFreq(lp.subarray(4410))).toBeCloseTo(100, -1);
    const hp = biquad(Float32Array.from(mixed), 'highpass', 2000);
    expect(zeroCrossingFreq(hp.subarray(4410))).toBeCloseTo(8000, -2);
  });
  it('mix offsets, normalises, clips and fades', () => {
    const m = mix([{ buf: new Float32Array([1, 1]) }, { buf: new Float32Array([1]), at: 1 / 44100, gain: 0.5 }]);
    expect(Array.from(m)).toEqual([1, 1.5]);
    expect(Math.max(...normalize(new Float32Array([0.1, -0.2])))).toBeCloseTo(0.45);
    expect(softClip(new Float32Array([1]), 2)[0]).toBeCloseTo(1); expect(softClip(new Float32Array([0.2]), 2)[0]).toBeGreaterThan(0.2);
    const e = echo(new Float32Array([1, 0, 0, 0]), 2 / 44100, 0.5, 1);
    expect(e[2]).toBeCloseTo(0.5); expect(e[4]).toBeCloseTo(0.25);
    const f = fadeOut(new Float32Array(10).fill(1), 5 / 44100);
    expect(f[9]).toBe(0); expect(f[0]).toBe(1);
  });
});
