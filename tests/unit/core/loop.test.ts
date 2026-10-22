import { describe, it, expect } from 'vitest';
import { FixedLoop } from '@/core/loop';

function fakeClock() {
  let t = 0; const queue: Array<(ms: number) => void> = [];
  return {
    now: () => t,
    raf: (cb: (ms: number) => void) => { queue.push(cb); return queue.length; },
    caf: () => { queue.length = 0; },
    advance(ms: number) { t += ms; const cb = queue.shift(); if (cb) cb(t); },
  };
}

describe('FixedLoop', () => {
  it('runs exactly 60 steps per simulated second at 60 fps', () => {
    const clk = fakeClock(); let ticks = 0, renders = 0;
    const loop = new FixedLoop(() => ticks++, () => renders++, { now: clk.now, raf: clk.raf, caf: clk.caf });
    loop.start();
    for (let i = 0; i < 60; i++) clk.advance(1000 / 60);
    expect(ticks).toBe(60); expect(renders).toBe(60);
  });
  it('clamps a stall to maxSteps and drops the rest', () => {
    const clk = fakeClock(); let ticks = 0;
    const loop = new FixedLoop(() => ticks++, () => {}, { now: clk.now, raf: clk.raf, caf: clk.caf });
    loop.start();
    clk.advance(500);
    expect(ticks).toBeLessThanOrEqual(4);
    expect(loop.stats.droppedTime).toBeGreaterThan(0);
  });
  it('does not accumulate while paused, and timeScale speeds up', () => {
    const clk = fakeClock(); let ticks = 0;
    const loop = new FixedLoop(() => ticks++, () => {}, { now: clk.now, raf: clk.raf, caf: clk.caf });
    loop.start(); loop.pause(true);
    for (let i = 0; i < 30; i++) clk.advance(16.67);
    expect(ticks).toBe(0);
    loop.pause(false); loop.timeScale = 2;
    for (let i = 0; i < 30; i++) clk.advance(16.67);
    expect(ticks).toBeGreaterThanOrEqual(58); expect(ticks).toBeLessThanOrEqual(61);
  });
  it('alpha is in [0,1)', () => {
    const clk = fakeClock(); let lastAlpha = -1;
    const loop = new FixedLoop(() => {}, (a) => { lastAlpha = a; }, { now: clk.now, raf: clk.raf, caf: clk.caf });
    loop.start(); clk.advance(10); expect(lastAlpha).toBeGreaterThanOrEqual(0); expect(lastAlpha).toBeLessThan(1);
    clk.advance(10); expect(lastAlpha).toBeLessThan(1);
  });
});
