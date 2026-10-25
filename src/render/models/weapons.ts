/**
 * Weapon models from primitives (§10.2): one part list per WeaponId (+ C4) → either a Group of meshes with
 * named children 'muzzle' (Object3D), 'mag', 'slide' / 'bolt' (viewmodel, animated) or one merged
 * vertex-coloured BufferGeometry (third person, instanced). Origin = right-hand grip, muzzle toward −z, +y up.
 * Every model stays ≤ 200 triangles.
 */
import { BoxGeometry, CylinderGeometry, SphereGeometry, Group, Mesh, Object3D, Color, Float32BufferAttribute, Matrix4, Euler, Quaternion, Vector3, type BufferGeometry, type Material } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { WeaponId } from '../../sim/state';

export type WeaponModelId = WeaponId | 'c4';
export type PartMat = 'metal' | 'wood' | 'green' | 'silver' | 'olive' | 'dark' | 'blade' | 'red' | 'yellow' | 'lens' | 'lcd';
type PartName = 'slide' | 'bolt' | 'mag';
interface Part { g: 'box' | 'cyl' | 'sph'; d: number[]; p: [number, number, number]; r?: [number, number, number]; m: PartMat; n?: PartName }
interface Spec { parts: Part[]; muzzle: [number, number, number]; led?: [number, number, number] }

/** Colours used for third-person vertex colouring and for the untextured viewmodel parts (sRGB hex). */
export const PART_COLORS: Record<PartMat, string> = {
  metal: '#3c3f45', wood: '#6b4a2a', green: '#4f5a3d', silver: '#aeb3ba', olive: '#4a5233', dark: '#1e2023', blade: '#c9ccd1', red: '#c03030', yellow: '#d8b400', lens: '#203850', lcd: '#39ff88',
};

const B = (w: number, h: number, l: number, p: [number, number, number], m: PartMat, n?: PartName, r?: [number, number, number]): Part => ({ g: 'box', d: [w, h, l], p, m, n, r });
const C = (rad: number, len: number, p: [number, number, number], m: PartMat, r?: [number, number, number], n?: PartName): Part => ({ g: 'cyl', d: [rad, len], p, m, r, n });
const S = (rad: number, p: [number, number, number], m: PartMat): Part => ({ g: 'sph', d: [rad], p, m });

const PISTOL = (slideMat: PartMat, slideLen: number, h: number): Part[] => [
  B(0.03, 0.028, slideLen - 0.015, [0, 0.035, -slideLen / 2 + 0.012], 'metal'),
  B(0.032, h, slideLen, [0, 0.064, -slideLen / 2 + 0.012], slideMat, 'slide'),
  B(0.028, 0.105, 0.048, [0, -0.02, 0], 'dark', undefined, [15, 0, 0]),
  B(0.008, 0.022, 0.045, [0, 0.012, -0.04], 'metal'),
  B(0.026, 0.02, 0.04, [0, -0.078, 0.014], 'dark', 'mag', [15, 0, 0]),
];

export const WEAPON_SPECS: Record<WeaponModelId, Spec> = {
  knife: { parts: [B(0.006, 0.03, 0.18, [0, 0, -0.14], 'blade'), B(0.005, 0.016, 0.05, [0, 0.007, -0.25], 'blade'), C(0.016, 0.11, [0, 0, 0.0], 'dark'), B(0.02, 0.05, 0.012, [0, 0, -0.055], 'metal')], muzzle: [0, 0, -0.27] },
  glock: { parts: PISTOL('metal', 0.185, 0.03), muzzle: [0, 0.064, -0.18] },
  usp: { parts: [...PISTOL('metal', 0.18, 0.03), C(0.017, 0.15, [0, 0.064, -0.24], 'dark')], muzzle: [0, 0.064, -0.32] },
  deagle: { parts: [...PISTOL('silver', 0.25, 0.036).map((p, i) => (i === 2 ? { ...p, d: [0.032, 0.11, 0.055] } : p))], muzzle: [0, 0.064, -0.24] },
  mp5: {
    parts: [B(0.045, 0.06, 0.32, [0, 0.05, -0.12], 'metal'), B(0.012, 0.012, 0.05, [-0.03, 0.07, -0.2], 'metal', 'bolt'), B(0.03, 0.09, 0.045, [0, -0.01, 0.02], 'dark', undefined, [12, 0, 0]),
      B(0.03, 0.14, 0.05, [0, -0.04, -0.13], 'dark', 'mag', [-8, 0, 0]), B(0.03, 0.04, 0.16, [0.035, 0.04, -0.02], 'dark'), C(0.022, 0.22, [0, 0.055, -0.39], 'dark')],
    muzzle: [0, 0.055, -0.5],
  },
  ak47: {
    parts: [B(0.05, 0.065, 0.34, [0, 0.05, -0.08], 'metal'), B(0.012, 0.012, 0.04, [0.032, 0.06, -0.06], 'metal', 'bolt'), B(0.056, 0.055, 0.2, [0, 0.045, -0.34], 'wood'),
      C(0.01, 0.24, [0, 0.05, -0.54], 'metal'), C(0.009, 0.22, [0, 0.085, -0.36], 'metal'),
      B(0.035, 0.08, 0.06, [0, -0.005, -0.17], 'dark', 'mag', [5, 0, 0]), B(0.035, 0.08, 0.06, [0, -0.075, -0.155], 'dark', 'mag', [15, 0, 0]), B(0.035, 0.08, 0.06, [0, -0.14, -0.13], 'dark', 'mag', [25, 0, 0]),
      B(0.045, 0.085, 0.26, [0, 0.02, 0.2], 'wood', undefined, [-8, 0, 0]), B(0.032, 0.09, 0.04, [0, -0.02, 0.02], 'wood', undefined, [15, 0, 0])],
    muzzle: [0, 0.05, -0.66],
  },
  m4a4: {
    parts: [B(0.048, 0.07, 0.3, [0, 0.05, -0.07], 'metal'), B(0.05, 0.055, 0.22, [0, 0.05, -0.32], 'dark'), B(0.02, 0.025, 0.12, [0, 0.1, -0.05], 'metal'), C(0.01, 0.2, [0, 0.05, -0.53], 'metal'),
      B(0.03, 0.12, 0.055, [0, -0.03, -0.13], 'dark', 'mag', [8, 0, 0]), C(0.015, 0.16, [0, 0.055, 0.15], 'dark'), B(0.04, 0.09, 0.08, [0, 0.035, 0.24], 'dark'),
      B(0.03, 0.09, 0.04, [0, -0.015, 0.02], 'dark', undefined, [15, 0, 0]), B(0.02, 0.01, 0.03, [0, 0.088, 0.06], 'metal', 'bolt')],
    muzzle: [0, 0.05, -0.64],
  },
  awp: {
    parts: [B(0.055, 0.08, 0.6, [0, 0.03, 0.0], 'green'), C(0.013, 0.65, [0, 0.06, -0.6], 'metal'), C(0.022, 0.3, [0, 0.125, -0.12], 'metal'), C(0.024, 0.01, [0, 0.125, -0.275], 'lens'),
      B(0.05, 0.03, 0.02, [0, 0.1, -0.04], 'metal'), B(0.05, 0.03, 0.02, [0, 0.1, -0.2], 'metal'), B(0.012, 0.012, 0.06, [0.04, 0.07, 0.06], 'metal', 'bolt'),
      B(0.035, 0.05, 0.06, [0, -0.03, -0.08], 'dark', 'mag'), B(0.008, 0.12, 0.008, [0.02, -0.02, -0.38], 'metal', undefined, [-20, 0, 10]), B(0.008, 0.12, 0.008, [-0.02, -0.02, -0.38], 'metal', undefined, [-20, 0, -10])],
    muzzle: [0, 0.06, -0.93],
  },
  he: { parts: [S(0.06, [0, 0.02, -0.02], 'olive'), B(0.015, 0.08, 0.02, [0, 0.06, 0.03], 'metal'), C(0.018, 0.03, [0, 0.085, -0.02], 'metal', [90, 0, 0])], muzzle: [0, 0.02, -0.08] },
  flash: { parts: [C(0.035, 0.12, [0, 0.04, -0.02], 'silver', [90, 0, 0]), C(0.02, 0.025, [0, 0.11, -0.02], 'metal', [90, 0, 0]), B(0.012, 0.07, 0.015, [0.03, 0.06, -0.02], 'metal')], muzzle: [0, 0.04, -0.06] },
  c4: {
    parts: [B(0.3, 0.1, 0.2, [0, 0.05, 0], 'olive'), B(0.12, 0.012, 0.08, [0.06, 0.106, 0.02], 'dark'), B(0.06, 0.008, 0.03, [-0.07, 0.104, -0.04], 'lcd'),
      B(0.28, 0.012, 0.012, [0, 0.07, 0.105], 'red'), B(0.28, 0.012, 0.012, [0, 0.04, 0.105], 'yellow')],
    muzzle: [0, 0.1, 0], led: [-0.11, 0.105, 0.06],
  },
};

const _m = new Matrix4(), _q = new Quaternion(), _e = new Euler(), _v = new Vector3(), _one = new Vector3(1, 1, 1);
const DEG = Math.PI / 180;

function partGeometry(p: Part): BufferGeometry {
  if (p.g === 'box') return new BoxGeometry(p.d[0], p.d[1], p.d[2]);
  if (p.g === 'sph') return new SphereGeometry(p.d[0], 8, 6);
  const g = new CylinderGeometry(p.d[0], p.d[0], p.d[1], 8);
  g.rotateX(Math.PI / 2);
  return g;
}
function partMatrix(p: Part, out: Matrix4): Matrix4 {
  const r = p.r ?? [0, 0, 0];
  _q.setFromEuler(_e.set(r[0] * DEG, r[1] * DEG, r[2] * DEG));
  return out.compose(_v.set(p.p[0], p.p[1], p.p[2]), _q, _one);
}

export type WeaponMaterials = (m: PartMat) => Material;

/** Viewmodel / showcase group with named children ('muzzle', 'mag', 'slide' | 'bolt'). */
export function buildWeaponGroup(id: WeaponModelId, mats: WeaponMaterials): Group {
  const spec = WEAPON_SPECS[id];
  const g = new Group(); g.name = id;
  const named = new Map<PartName, Group>();
  for (const p of spec.parts) {
    const mesh = new Mesh(partGeometry(p), mats(p.m));
    partMatrix(p, _m); mesh.position.setFromMatrixPosition(_m); mesh.quaternion.setFromRotationMatrix(_m);
    let parent: Object3D = g;
    if (p.n) { let ng = named.get(p.n); if (!ng) { ng = new Group(); ng.name = p.n; named.set(p.n, ng); g.add(ng); } parent = ng; }
    parent.add(mesh);
  }
  const muzzle = new Object3D(); muzzle.name = 'muzzle'; muzzle.position.set(...spec.muzzle); g.add(muzzle);
  if (spec.led) { const led = new Object3D(); led.name = 'led'; led.position.set(...spec.led); g.add(led); }
  return g;
}

/** One merged, vertex-coloured geometry (third-person instancing). */
export function buildMergedWeapon(id: WeaponModelId): BufferGeometry {
  const geos: BufferGeometry[] = [];
  const c = new Color();
  for (const p of WEAPON_SPECS[id].parts) {
    const g = partGeometry(p).toNonIndexed();
    g.applyMatrix4(partMatrix(p, _m));
    c.set(PART_COLORS[p.m]);
    const n = g.getAttribute('position').count, col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
    g.setAttribute('color', new Float32BufferAttribute(col, 3));
    g.deleteAttribute('uv');
    geos.push(g);
  }
  const merged = mergeGeometries(geos, false);
  for (const g of geos) g.dispose();
  if (!merged) throw new Error(`merge failed for weapon ${id}`);
  return merged;
}

export function muzzleOffset(id: WeaponModelId, out: Vector3): Vector3 { return out.set(...WEAPON_SPECS[id].muzzle); }
export function ledOffset(out: Vector3): Vector3 { return out.set(...(WEAPON_SPECS.c4.led ?? [0, 0.1, 0])); }

/** Triangle count of a weapon model (tests / budget). */
export function weaponTriangles(id: WeaponModelId): number {
  let t = 0;
  for (const p of WEAPON_SPECS[id].parts) { const g = partGeometry(p); t += (g.index ? g.index.count : g.getAttribute('position').count) / 3; g.dispose(); }
  return t;
}
