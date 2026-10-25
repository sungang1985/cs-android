import { describe, it, expect } from 'vitest';
import { Perf } from '@/app/perf';

function run(p: Perf, frameMs: number, seconds: number, ticksPerFrame: number): void {
  for (let t = 0; t < seconds * 1000; t += frameMs) { for (let i = 0; i < ticksPerFrame; i++) p.sampleTick(0.5); p.sampleFrame(frameMs, 1); }
}

function tracked(fpsCap: number): { p: Perf; steps: string[] } {
  const p = new Perf(); p.fpsCap = fpsCap; const steps: string[] = []; p.onQualityStep = (q) => steps.push(q);
  return { p, steps };
}

describe('Perf auto quality', () => {
  it('a deliberate 30 fps cap is not mistaken for a slow device', () => {
    const { p, steps } = tracked(30);
    run(p, 1000 / 30, 60, 2);
    expect(steps).toEqual([]); expect(p.effective).toBe('medium');
  });
  it('steps down when frames really are slow (60 fps target)', () => {
    const { p, steps } = tracked(60);
    run(p, 25, 10, 1);
    expect(steps).toEqual(['low']);
  });
  it('steps down at a 30 fps cap when frames exceed that budget', () => {
    const { p, steps } = tracked(30);
    run(p, 50, 10, 3);
    expect(steps).toEqual(['low']);
  });
  it('tick samples do not dilute the frame / render histograms', () => {
    const p = new Perf(); p.auto = false;
    run(p, 1000 / 60, 2, 1);
    const s = p.stats(60);
    expect(s.frameMs.avg).toBeCloseTo(1000 / 60, 3);
    expect(s.renderMs.avg).toBeCloseTo(1, 5);
    expect(s.simMs.avg).toBeCloseTo(0.5, 5);
  });
});
