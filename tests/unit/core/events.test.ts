import { describe, it, expect } from 'vitest';
import { EventBus } from '@/core/events';

type E = { shot: { who: number }; death: { victim: number; killer: number } };

describe('EventBus', () => {
  it('buffers and drains in order with ticks', () => {
    const bus = new EventBus<E>();
    bus.tick = 5; bus.emit('shot', { who: 1 });
    bus.tick = 6; bus.emit('death', { victim: 2, killer: 1 });
    const got = bus.drain();
    expect(got.map((e) => e.type)).toEqual(['shot', 'death']);
    expect(got[1].tick).toBe(6);
    expect(bus.drain()).toEqual([]);
  });
  it('calls listeners synchronously and unsubscribes', () => {
    const bus = new EventBus<E>(); const seen: number[] = [];
    const off = bus.on('shot', (d) => seen.push(d.who));
    bus.emit('shot', { who: 1 }); off(); bus.emit('shot', { who: 2 });
    expect(seen).toEqual([1]);
  });
  it('guards re-entrancy in dev mode', () => {
    const bus = new EventBus<E>(); bus.guardReentrancy = true;
    bus.on('shot', () => bus.emit('death', { victim: 0, killer: 0 }));
    expect(() => bus.emit('shot', { who: 1 })).toThrow(/re-entrant/);
  });
});
