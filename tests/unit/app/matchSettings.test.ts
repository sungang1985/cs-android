import { describe, it, expect, beforeEach } from 'vitest';
import { buildMatchConfig } from '@/app/matchSettings';
import { persist, setStorageForTests } from '@/platform/persist';
import { DEFAULT_SETTINGS } from '@/settings/types';

function memStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); } };
}

describe('buildMatchConfig', () => {
  beforeEach(() => setStorageForTests(memStorage()));
  it('remembers the user choice (including random) for normal matches', () => {
    const cfg = buildMatchConfig({ mode: 'defusal', humanTeam: 'random' as never, difficulty: 'hard' }, DEFAULT_SETTINGS, 7, () => 0.9);
    expect(cfg.humanTeam).toBe('CT');
    expect(persist.get<Record<string, unknown> | null>('lastSettings', null)).toMatchObject({ mode: 'defusal', humanTeam: 'random', difficulty: 'hard' });
  });
  it('training (forced T) does not overwrite lastSettings', () => {
    buildMatchConfig({ mode: 'tdm', humanTeam: 'CT' }, DEFAULT_SETTINGS, 1, () => 0);
    const cfg = buildMatchConfig({ mode: 'training' }, DEFAULT_SETTINGS, 2, () => 0);
    expect(cfg.mode).toBe('training'); expect(cfg.humanTeam).toBe('T');
    expect(persist.get<Record<string, unknown> | null>('lastSettings', null)).toMatchObject({ mode: 'tdm', humanTeam: 'CT' });
  });
  it('first-run training leaves lastSettings empty', () => {
    buildMatchConfig({ mode: 'training' }, DEFAULT_SETTINGS, 2, () => 0);
    expect(persist.get('lastSettings', null)).toBeNull();
  });
});
