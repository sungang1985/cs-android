/** Quality / team rebuilds (§10.3, §13): corpses keep their tip-over direction; viewmodel rebuilds don't grow the MaterialLib. */
import { describe, it, expect } from 'vitest';
import { Texture } from 'three';
import { MaterialLib } from '../../../src/render/materials';
import { QUALITY } from '../../../src/render/quality';
import { SharedBatches } from '../../../src/render/models/props';
import { CharacterSystem } from '../../../src/render/models/humanoid';
import { Viewmodel } from '../../../src/render/viewmodel';
import { createSnapshot, type RenderSnapshot } from '../../../src/sim/state';

/** MaterialLib without canvas textures (node). */
class TestLib extends MaterialLib {
  constructor() { super(QUALITY.low, 1); }
  override texture(): Texture { return new Texture(); }
  override sprite(): Texture { return new Texture(); }
  get materialCount(): number { return (this as unknown as { mats: unknown[] }).mats.length; }
}

function corpseSnap(): RenderSnapshot {
  const s = createSnapshot();
  s.playerCount = 1;
  const p = s.players[0];
  p.id = 5; p.team = 0; p.alive = 0; p.x = 3; p.y = 0; p.z = 4; p.yaw = 0.4; p.pitch = 0; p.weapon = -1; p.deathT = 2; p.flinchT = -1;
  return s;
}

describe('render rebuilds', () => {
  it('a rebuilt CharacterSystem keeps each corpse\'s death direction', () => {
    const lib = new TestLib(), shared = new SharedBatches(lib);
    const opts = { hidden: () => false, clock: 0, dt: 1 / 60, showAll: false };
    const a = new CharacterSystem(lib, shared), s = corpseSnap();
    a.onDeath(5, { x: 1, y: 0, z: 0 });
    a.onDeath(9, { x: 0, y: 0, z: -1 }); // death of a player not yet in any snapshot
    a.update(s, s, 1, opts);
    expect(a.views.get(5)!.deathDir!.x).toBeCloseTo(1);
    const b = new CharacterSystem(lib, shared);
    b.restoreDeathDirs(a.deathDirs());
    b.update(s, s, 1, opts);
    const d = b.views.get(5)!.deathDir!;
    expect(d).not.toBeNull(); expect(d.x).toBeCloseTo(1); expect(d.z).toBeCloseTo(0);
    expect(b.deathDirs().get(9)!.z).toBeCloseTo(-1);
  });
  it('viewmodel rebuilds (team swap) reuse the muzzle-flash material', () => {
    const lib = new TestLib();
    new Viewmodel(lib, 0).dispose();
    const n = lib.materialCount;
    for (let i = 0; i < 4; i++) new Viewmodel(lib, (i & 1) as 0 | 1).dispose();
    expect(lib.materialCount).toBe(n);
  });
});
