/**
 * Pure DSP primitives used to synthesise every sound effect offline into Float32Array buffers.
 * No AudioContext here, so sound recipes can be unit-tested in Node and rendered once at load time.
 */
import { Rng } from '../core/rng';

export const SAMPLE_RATE = 44100;

export type Mono = Float32Array;

export function silence(seconds: number, sr = SAMPLE_RATE): Mono { return new Float32Array(Math.max(1, Math.round(seconds * sr))); }

/** White noise in [-1, 1] from a seeded RNG (deterministic). */
export function whiteNoise(seconds: number, rng: Rng, sr = SAMPLE_RATE): Mono {
  const out = silence(seconds, sr);
  for (let i = 0; i < out.length; i++) out[i] = rng.next() * 2 - 1;
  return out;
}

/** Pink-ish noise (Paul Kellet's economy filter). */
export function pinkNoise(seconds: number, rng: Rng, sr = SAMPLE_RATE): Mono {
  const out = silence(seconds, sr);
  let b0 = 0, b1 = 0, b2 = 0;
  for (let i = 0; i < out.length; i++) {
    const w = rng.next() * 2 - 1;
    b0 = 0.99765 * b0 + w * 0.099046; b1 = 0.963 * b1 + w * 0.2965164; b2 = 0.57 * b2 + w * 1.0526913;
    out[i] = (b0 + b1 + b2 + w * 0.1848) * 0.25;
  }
  return out;
}

export type Wave = 'sine' | 'square' | 'saw' | 'triangle';

/**
 * Oscillator with optional frequency sweep: freq(t) is evaluated per sample, so chirps/pitch drops work.
 */
export function oscillator(seconds: number, freq: number | ((t: number) => number), wave: Wave = 'sine', sr = SAMPLE_RATE, phase0 = 0): Mono {
  const out = silence(seconds, sr);
  let phase = phase0;
  const f = typeof freq === 'number' ? () => freq : freq;
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    phase += (2 * Math.PI * f(t)) / sr;
    const p = phase % (2 * Math.PI);
    switch (wave) {
      case 'sine': out[i] = Math.sin(p); break;
      case 'square': out[i] = p < Math.PI ? 1 : -1; break;
      case 'saw': out[i] = (p / Math.PI) - 1; break;
      case 'triangle': out[i] = 1 - 4 * Math.abs(Math.round(p / (2 * Math.PI) - 0.25) - (p / (2 * Math.PI) - 0.25)); break;
    }
  }
  return out;
}

/** Multiply by an exponentially decaying envelope: e^(-t/tau). */
export function expDecay(buf: Mono, tau: number, sr = SAMPLE_RATE): Mono {
  for (let i = 0; i < buf.length; i++) buf[i] *= Math.exp(-(i / sr) / tau);
  return buf;
}

/** Linear ADSR envelope (seconds); sustain is a level 0..1. */
export function adsr(buf: Mono, a: number, d: number, s: number, r: number, sr = SAMPLE_RATE): Mono {
  const n = buf.length, A = a * sr, D = d * sr, R = r * sr;
  for (let i = 0; i < n; i++) {
    let g: number;
    if (i < A) g = i / Math.max(1, A);
    else if (i < A + D) g = 1 - (1 - s) * ((i - A) / Math.max(1, D));
    else if (i >= n - R) g = s * ((n - i) / Math.max(1, R));
    else g = s;
    buf[i] *= g;
  }
  return buf;
}

export type BiquadType = 'lowpass' | 'highpass' | 'bandpass' | 'peaking' | 'notch';

/** Biquad filter (RBJ cookbook), in place. */
export function biquad(buf: Mono, type: BiquadType, freq: number, q = 0.707, gainDb = 0, sr = SAMPLE_RATE): Mono {
  const w0 = (2 * Math.PI * Math.min(freq, sr / 2 - 1)) / sr;
  const cos = Math.cos(w0), sin = Math.sin(w0);
  const alpha = sin / (2 * q);
  const A = Math.pow(10, gainDb / 40);
  let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number;
  switch (type) {
    case 'lowpass': b0 = (1 - cos) / 2; b1 = 1 - cos; b2 = (1 - cos) / 2; a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha; break;
    case 'highpass': b0 = (1 + cos) / 2; b1 = -(1 + cos); b2 = (1 + cos) / 2; a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha; break;
    case 'bandpass': b0 = alpha; b1 = 0; b2 = -alpha; a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha; break;
    case 'notch': b0 = 1; b1 = -2 * cos; b2 = 1; a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha; break;
    case 'peaking': b0 = 1 + alpha * A; b1 = -2 * cos; b2 = 1 - alpha * A; a0 = 1 + alpha / A; a1 = -2 * cos; a2 = 1 - alpha / A; break;
  }
  b0 /= a0; b1 /= a0; b2 /= a0; a1 /= a0; a2 /= a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < buf.length; i++) {
    const x0 = buf[i];
    const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x0; y2 = y1; y1 = y0;
    buf[i] = y0;
  }
  return buf;
}

/** Scale in place. */
export function gain(buf: Mono, g: number): Mono { for (let i = 0; i < buf.length; i++) buf[i] *= g; return buf; }

/** Sum buffers (optionally offset in seconds) into a new buffer long enough to hold all. */
export function mix(parts: Array<{ buf: Mono; at?: number; gain?: number }>, sr = SAMPLE_RATE): Mono {
  let len = 1;
  for (const p of parts) len = Math.max(len, Math.round((p.at ?? 0) * sr) + p.buf.length);
  const out = new Float32Array(len);
  for (const p of parts) {
    const off = Math.round((p.at ?? 0) * sr), g = p.gain ?? 1;
    for (let i = 0; i < p.buf.length; i++) out[off + i] += p.buf[i] * g;
  }
  return out;
}

/** Peak-normalise to `peak` (default 0.9). */
export function normalize(buf: Mono, peak = 0.9): Mono {
  let m = 0; for (let i = 0; i < buf.length; i++) m = Math.max(m, Math.abs(buf[i]));
  if (m > 1e-9) { const g = peak / m; for (let i = 0; i < buf.length; i++) buf[i] *= g; }
  return buf;
}

/** tanh soft clipper with drive. */
export function softClip(buf: Mono, drive = 2): Mono { for (let i = 0; i < buf.length; i++) buf[i] = Math.tanh(buf[i] * drive) / Math.tanh(drive); return buf; }

/** Simple feedback-delay "room" tail (comb). */
export function echo(buf: Mono, delaySec: number, feedback: number, wet = 0.3, sr = SAMPLE_RATE): Mono {
  const d = Math.max(1, Math.round(delaySec * sr));
  const extra = Math.round(sr * Math.min(2, delaySec * 8));
  const out = new Float32Array(buf.length + extra);
  out.set(buf);
  for (let i = d; i < out.length; i++) out[i] += out[i - d] * feedback * wet;
  return out;
}

/** Fade the last `seconds` to zero (avoids clicks). */
export function fadeOut(buf: Mono, seconds: number, sr = SAMPLE_RATE): Mono {
  const n = Math.min(buf.length, Math.round(seconds * sr));
  for (let i = 0; i < n; i++) buf[buf.length - 1 - i] *= i / n;
  return buf;
}
export function fadeIn(buf: Mono, seconds: number, sr = SAMPLE_RATE): Mono {
  const n = Math.min(buf.length, Math.round(seconds * sr));
  for (let i = 0; i < n; i++) buf[i] *= i / n;
  return buf;
}

/** RMS level (tests, loudness matching). */
export function rms(buf: Mono): number { let s = 0; for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i]; return Math.sqrt(s / Math.max(1, buf.length)); }
/** Dominant frequency estimate via zero crossings (tests). */
export function zeroCrossingFreq(buf: Mono, sr = SAMPLE_RATE): number {
  let c = 0; for (let i = 1; i < buf.length; i++) if ((buf[i - 1] < 0) !== (buf[i] < 0)) c++;
  return (c / 2) / (buf.length / sr);
}
