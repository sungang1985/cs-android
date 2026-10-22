import { describe, it, expect } from 'vitest';
import { Rng, RngStreams } from '@/core/rng';

describe('Rng', () => {
  it('is deterministic for a seed and restorable from plain state', () => {
    const a = new Rng(42), b = new Rng(42);
    const seqA = Array.from({ length: 5 }, () => a.next());
    const seqB = Array.from({ length: 5 }, () => b.next());
    expect(seqA).toEqual(seqB);
    const snap = structuredClone(a.state);
    const more = Array.from({ length: 5 }, () => a.next());
    const c = new Rng(snap);
    expect(Array.from({ length: 5 }, () => c.next())).toEqual(more);
  });
  it('produces a roughly uniform distribution', () => {
    const r = new Rng(7); const buckets = new Array(10).fill(0);
    for (let i = 0; i < 20000; i++) buckets[Math.floor(r.next() * 10)]++;
    for (const b of buckets) expect(b).toBeGreaterThan(1700);
    for (const b of buckets) expect(b).toBeLessThan(2300);
  });
  it('gauss has the requested moments', () => {
    const r = new Rng(3); let s = 0, s2 = 0; const n = 20000;
    for (let i = 0; i < n; i++) { const g = r.gauss(2, 0.5); s += g; s2 += g * g; }
    const mean = s / n, sd = Math.sqrt(s2 / n - mean * mean);
    expect(mean).toBeCloseTo(2, 1); expect(sd).toBeCloseTo(0.5, 1);
  });
  it('int range is inclusive and chance works', () => {
    const r = new Rng(9); const seen = new Set<number>();
    for (let i = 0; i < 1000; i++) seen.add(r.int(1, 3));
    expect([...seen].sort()).toEqual([1, 2, 3]);
    let hits = 0; for (let i = 0; i < 10000; i++) if (r.chance(0.25)) hits++;
    expect(hits / 10000).toBeCloseTo(0.25, 1);
  });
  it('named streams are independent and serialisable', () => {
    const s1 = new RngStreams(123);
    const fire1 = [s1.get('fire').next(), s1.get('fire').next()];
    s1.get('ai').next();
    const snap = s1.serialize();
    const s2 = new RngStreams(123, structuredClone(snap));
    expect(s2.get('fire').next()).toBe(s1.get('fire').next());
    const s3 = new RngStreams(123);
    expect([s3.get('fire').next(), s3.get('fire').next()]).toEqual(fire1);
    // consuming 'ai' never changes 'fire'
    const s4 = new RngStreams(123); for (let i = 0; i < 50; i++) s4.get('ai').next();
    expect([s4.get('fire').next(), s4.get('fire').next()]).toEqual(fire1);
  });
});
