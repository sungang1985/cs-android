/**
 * Deterministic PRNG (sfc32) with named sub-streams. All state is plain numbers so it can live inside
 * serialisable world state (structuredClone / JSON) and be restored exactly.
 */
export interface RngState { a: number; b: number; c: number; d: number }

function splitmix32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
    return (z ^ (z >>> 15)) >>> 0;
  };
}

/** FNV-1a of a string → 32-bit, used to derive sub-stream seeds from names. */
export function hashString(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}

export class Rng {
  state: RngState;

  constructor(seed: number | RngState) {
    if (typeof seed === 'number') {
      const sm = splitmix32(seed);
      this.state = { a: sm(), b: sm(), c: sm(), d: sm() };
      for (let i = 0; i < 12; i++) this.nextU32(); // warm up
    } else {
      this.state = { a: seed.a >>> 0, b: seed.b >>> 0, c: seed.c >>> 0, d: seed.d >>> 0 };
    }
  }

  /** Uniform 32-bit integer. */
  nextU32(): number {
    const s = this.state;
    const t = (s.a + s.b + s.d) >>> 0;
    s.d = (s.d + 1) >>> 0;
    s.a = (s.b ^ (s.b >>> 9)) >>> 0;
    s.b = (s.c + (s.c << 3)) >>> 0;
    s.c = ((s.c << 21) | (s.c >>> 11)) >>> 0;
    s.c = (s.c + t) >>> 0;
    return t;
  }
  /** Uniform float in [0, 1). */
  next(): number { return this.nextU32() / 4294967296; }
  /** Uniform float in [lo, hi). */
  range(lo: number, hi: number): number { return lo + (hi - lo) * this.next(); }
  /** Uniform integer in [lo, hi] inclusive. */
  int(lo: number, hi: number): number { return lo + Math.floor(this.next() * (hi - lo + 1)); }
  /** Bernoulli trial. */
  chance(p: number): boolean { return this.next() < p; }
  /** Symmetric uniform in [-s, s]. */
  spread(s: number): number { return (this.next() * 2 - 1) * s; }
  /** Gaussian via Box–Muller (consumes two draws). */
  gauss(mu = 0, sigma = 1): number {
    let u = 0, v = 0;
    while (u === 0) u = this.next();
    v = this.next();
    return mu + sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  pick<T>(arr: readonly T[]): T { return arr[Math.floor(this.next() * arr.length)]; }
  /** In-place Fisher–Yates shuffle. */
  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(this.next() * (i + 1)); const t = arr[i]; arr[i] = arr[j]; arr[j] = t; }
    return arr;
  }
  /** Independent child stream derived from this stream's seed and a name (does not advance this stream). */
  fork(name: string): Rng { return new Rng((hashString(name) ^ this.state.a ^ Math.imul(this.state.c, 0x9e3779b1)) >>> 0); }
  clone(): Rng { return new Rng(this.state); }
}

/** Named RNG streams (fire, spread, ai, spawn, ...) so systems do not perturb each other. */
export class RngStreams {
  private readonly streams = new Map<string, Rng>();
  constructor(public readonly seed: number, state?: Record<string, RngState>) {
    if (state) for (const [k, v] of Object.entries(state)) this.streams.set(k, new Rng(v));
  }
  get(name: string): Rng {
    let r = this.streams.get(name);
    if (!r) { r = new Rng((this.seed ^ hashString(name)) >>> 0); this.streams.set(name, r); }
    return r;
  }
  /** Plain-object snapshot of every stream's state (for serialisation). */
  serialize(): Record<string, RngState> {
    const out: Record<string, RngState> = {};
    for (const [k, v] of this.streams) out[k] = { ...v.state };
    return out;
  }
}
