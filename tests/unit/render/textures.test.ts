/** Texture recipes (§12.1 render/textures): deterministic for every MaterialId, sprite and icon. */
import { describe, it, expect } from 'vitest';
import { Rng } from '../../../src/core/rng';
import { paintTexture, MATERIAL_IDS, TRANSPARENT_MATERIALS } from '../../../src/render/textures/index';
import { paintSprite, SPRITE_IDS, SPRITE_SIZE } from '../../../src/render/textures/sprites';
import { paintIcon, ICON_KINDS } from '../../../src/render/textures/icons';
import { makeRecordingCtx, hashCalls } from '../../../src/render/textures/ctx';
import type { MaterialId } from '../../../src/world/types';

/** Stored once from the recipes (seed 1337); a recipe change must update these on purpose. */
const HASH_256: Record<MaterialId, number> = {
  concrete: 1835206191, concrete_base: 233692144, floor: 751982907, floor_stripe: 719065646, crate_wood: 2502429211, sandbag: 1760489558, metal: 1541267047,
  door_frame: 1983918888, ceiling: 2887008801, lamp: 28848570, site_marker: 2958203466, skin_t: 772481534, skin_ct: 115511962, gun_metal: 475207051, wood_stock: 1748830468,
};
const HASH_512: Partial<Record<MaterialId, number>> = { concrete: 3445495931, floor: 3434920472, skin_ct: 3802278074 };
const SPRITES: Record<string, number> = { blood_decal: 1484761649, bullet_hole: 1110295200, muzzle: 360285800, blob_shadow: 1693326027, smoke: 341784661, spark: 1988026506, ring: 2208117389 };
const ICONS: Record<string, number> = {
  knife: 4289375888, glock: 73593855, usp: 1887870567, deagle: 3630617291, mp5: 3100106991, ak47: 2764325779, m4a4: 1222927989, awp: 3411613662, he: 98315551, flash: 2577748665,
  c4: 1398205664, kit: 3038329048, helmet: 3525177229, kevlar: 2428709726, skull: 902666443,
};

function record(id: MaterialId, size: number): unknown[][] { const c = makeRecordingCtx(); paintTexture(id, size, new Rng(1337), c); return c.calls; }

describe('render/textures', () => {
  it('covers every MaterialId', () => {
    expect(MATERIAL_IDS.length).toBe(15);
    expect(new Set(MATERIAL_IDS).size).toBe(15);
    expect(Object.keys(HASH_256).sort()).toEqual([...MATERIAL_IDS].sort());
  });
  for (const id of MATERIAL_IDS) {
    it(`${id}: recording hash at 256² equals the stored value`, () => {
      const calls = record(id, 256);
      expect(calls.length).toBeGreaterThan(5);
      expect(hashCalls(calls)).toBe(HASH_256[id]);
      expect(hashCalls(record(id, 256))).toBe(HASH_256[id]); // same seed → same output
    });
  }
  for (const [id, h] of Object.entries(HASH_512)) it(`${id}: recording hash at 512² equals the stored value`, () => expect(hashCalls(record(id as MaterialId, 512))).toBe(h));

  it('a different seed changes the noisy recipes', () => {
    const c = makeRecordingCtx(); paintTexture('concrete', 256, new Rng(7), c);
    expect(hashCalls(c.calls)).not.toBe(HASH_256.concrete);
  });
  it('opaque recipes start by filling the whole texture; transparent ones never do', () => {
    for (const id of MATERIAL_IDS) {
      const calls = record(id, 256);
      const full = calls.some((c) => c[0] === 'fillRect' && c[1] === 0 && c[2] === 0 && c[3] === 256 && c[4] === 256);
      if (TRANSPARENT_MATERIALS.has(id)) expect(full, id).toBe(false); else expect(full, id).toBe(true);
    }
  });
  it('recipes only use finite numbers and leave globalAlpha at 1', () => {
    for (const id of MATERIAL_IDS) {
      const c = makeRecordingCtx(); paintTexture(id, 256, new Rng(1337), c);
      const bad = c.calls.find((call) => call.some((a) => typeof a === 'number' && !Number.isFinite(a)));
      expect(bad, id).toBeUndefined();
      expect(c.globalAlpha).toBe(1);
    }
  });
  for (const id of SPRITE_IDS) it(`sprite ${id} is deterministic`, () => {
    const c = makeRecordingCtx(); paintSprite(id, SPRITE_SIZE[id], new Rng(1337), c);
    expect(hashCalls(c.calls)).toBe(SPRITES[id]);
  });
  for (const id of ICON_KINDS) it(`icon ${id} is deterministic`, () => {
    const c = makeRecordingCtx(); paintIcon(id, 64, c);
    expect(c.calls.filter((x) => x[0] === 'fill').length).toBeGreaterThan(0);
    expect(hashCalls(c.calls)).toBe(ICONS[id]);
  });
});
