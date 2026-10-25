import { describe, it, expect } from 'vitest';
import { WEAPON_INDEX } from '@/sim/state';
import { iconUrl, iconImg, ICON_IDS } from '@/ui/icons';
import { itemIcon } from '@/ui/buyMenu';

describe('icons', () => {
  it('every WeaponId and the bomb / kit / helmet / skull glyphs have a cached data URL', () => {
    for (const id of [...WEAPON_INDEX, 'bomb', 'kit', 'helmet', 'kevlar', 'skull', 'headshot'] as const) {
      expect(ICON_IDS).toContain(id);
      const a = iconUrl(id);
      expect(a.startsWith('data:image/')).toBe(true);
      expect(iconUrl(id)).toBe(a);                 // cached
    }
    expect(iconUrl('ak47', '#E04545')).not.toBe(iconUrl('ak47'));
    expect(iconImg('awp').dataset.icon).toBe('awp');
    expect(itemIcon('kevlar_helmet')).toBe('helmet'); expect(itemIcon('defuse_kit')).toBe('kit'); expect(itemIcon('c4')).toBe('bomb');
  });
});
