/**
 * Versioned localStorage wrapper. Every read is wrapped in try/catch with a default (private mode,
 * blocked storage, quota) and values are JSON. Keys are namespaced `cs.v1.<name>`.
 */
export type PersistKey = 'settings' | 'layout' | 'stats' | 'onboarding' | 'match' | 'locale' | 'loadout' | 'lastSettings';

const PREFIX = 'cs.v1.';

interface StorageLike { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }

let storage: StorageLike | null | undefined;
function store(): StorageLike | null {
  if (storage !== undefined) return storage;
  try {
    const s = (globalThis as { localStorage?: StorageLike }).localStorage;
    if (!s) { storage = null; return null; }
    const probe = PREFIX + '__probe';
    s.setItem(probe, '1'); s.removeItem(probe);
    storage = s;
  } catch { storage = null; }
  return storage;
}

/** Replace the backing store (tests). Pass null to simulate unavailable storage. */
export function setStorageForTests(s: StorageLike | null): void { storage = s; }

export const persist = {
  get<T>(key: PersistKey, def: T): T {
    try {
      const raw = store()?.getItem(PREFIX + key);
      if (raw == null) return def;
      const parsed = JSON.parse(raw) as T;
      return parsed === null || parsed === undefined ? def : parsed;
    } catch { return def; }
  },
  set<T>(key: PersistKey, value: T): boolean {
    try { const s = store(); if (!s) return false; s.setItem(PREFIX + key, JSON.stringify(value)); return true; } catch { return false; }
  },
  remove(key: PersistKey): void {
    try { store()?.removeItem(PREFIX + key); } catch { /* ignore */ }
  },
  /** Shallow-merge an object value. */
  update<T extends object>(key: PersistKey, patch: Partial<T>, def: T): T {
    const merged = { ...persist.get<T>(key, def), ...patch };
    persist.set(key, merged);
    return merged;
  },
  available(): boolean { return store() !== null; },
};
