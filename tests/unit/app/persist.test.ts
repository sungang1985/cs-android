import { describe, it, expect, beforeEach } from 'vitest';
import { persist, setStorageForTests } from '@/app/persist';

function memStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); }, map: m };
}

describe('persist', () => {
  beforeEach(() => setStorageForTests(memStorage()));
  it('round-trips JSON with defaults', () => {
    expect(persist.get('settings', { a: 1 })).toEqual({ a: 1 });
    persist.set('settings', { a: 2, b: 'x' });
    expect(persist.get('settings', { a: 1 })).toEqual({ a: 2, b: 'x' });
    expect(persist.update('settings', { a: 3 }, { a: 0 })).toEqual({ a: 3, b: 'x' });
    persist.remove('settings');
    expect(persist.get('settings', null)).toBeNull();
  });
  it('survives unavailable or corrupt storage', () => {
    setStorageForTests(null);
    expect(persist.set('stats', { k: 1 })).toBe(false);
    expect(persist.get('stats', 7)).toBe(7);
    const s = memStorage(); setStorageForTests(s);
    s.setItem('cs.v1.stats', '{not json');
    expect(persist.get('stats', 9)).toBe(9);
  });
});
