/**
 * Tiny 6 × 6 test map (12 × 12 m): one room with a low crate, used by unit tests and stubs.
 */
import type { MapSource } from '../world/types';

export const BOX: MapSource = {
  id: 'box',
  name: { zh: '测试房', en: 'Box' },
  cellSize: 2, width: 6, height: 6,
  grid: [
    '######',
    '#TT.A#',
    '#T.c.#',
    '#..C.#',
    '#B.CC#',
    '######',
  ],
  wallHeight: 3.0, ceilingY: 4.5, lintelY: 2.6,
  props: {
    X: { height: 2.0, inset: 0, material: 'crate_wood', surface: 'wood', penetrable: true, penetrationFactor: 0.4, kind: 'tallcrate', blocksLos: 'full' },
    c: { height: 1.0, inset: 0.5, material: 'crate_wood', surface: 'wood', penetrable: true, penetrationFactor: 0.6, kind: 'lowcrate', blocksLos: 'low' },
    '~': { height: 1.2, inset: 0, material: 'sandbag', surface: 'sand', penetrable: true, penetrationFactor: 0.6, kind: 'sandbag', blocksLos: 'low' },
    L: { height: 1.9, inset: 0, material: 'metal', surface: 'metal', penetrable: false, penetrationFactor: 0, kind: 'lip', blocksLos: 'low' },
  },
  platforms: [],
  ramps: [],
  areas: [
    { id: 't_spawn', rect: [1, 1, 2, 2] }, { id: 'ct_spawn', rect: [3, 3, 4, 4] },
    { id: 'site_a', rect: [4, 1, 4, 1] }, { id: 'site_b', rect: [1, 4, 1, 4] }, { id: 'mid', rect: [2, 2, 3, 3] },
  ],
  sites: { a: [4, 1, 4, 1], b: [1, 4, 1, 4] },
  plantSpots: { a: [4, 1], b: [1, 4] },
  spawns: {
    T: [{ cell: [1, 1], yawDeg: -135 }, { cell: [2, 1], yawDeg: -135 }, { cell: [1, 2], yawDeg: -135 }],
    CT: [{ cell: [4, 4], yawDeg: 45 }, { cell: [3, 4], yawDeg: 45 }, { cell: [3, 3], yawDeg: 45 }],
  },
  holdSpots: [{ id: 'hold_mid', cell: [2, 3], yawDeg: 0, team: 'both', crouch: false }],
  chokes: [],
  materials: { wall: 'concrete', wallBase: 'concrete_base', floor: 'floor', site: 'floor_stripe', ceiling: 'ceiling', door: 'door_frame' },
  training: { sealed: [], targets: [[4, 1], [4, 2], [3, 1]], onboardingCell: [3, 2] },
};
