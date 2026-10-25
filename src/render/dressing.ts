/**
 * Render-only dressing (§10.3): High-preset point lights (sites, mid, CT spawn; 10 m, no shadows), the
 * onboarding marker ring (§2.4 setMarker) and the menu diorama used before any map is loaded.
 */
import { PointLight, Group, Mesh, RingGeometry, CircleGeometry, type Material } from 'three';
import { aabb, v3, type Vec3 } from '../core/math';
import type { CompiledMap, SolidDef } from '../world/types';

export function buildPointLights(map: Pick<CompiledMap, 'sites' | 'spawns' | 'bounds'>, count: number, intensity: number): Group {
  const g = new Group(); g.name = 'point-lights';
  if (count <= 0) return g;
  const c = (r: { x0: number; z0: number; x1: number; z1: number; y: number }) => v3((r.x0 + r.x1) / 2, r.y + 3, (r.z0 + r.z1) / 2);
  const ct = map.spawns.CT[0]?.pos ?? v3(0, 0, 0);
  const spots: Vec3[] = [c(map.sites.a), c(map.sites.b), v3((map.bounds.min.x + map.bounds.max.x) / 2, 3, (map.bounds.min.z + map.bounds.max.z) / 2), v3(ct.x, ct.y + 3, ct.z)];
  for (const s of spots.slice(0, count)) { const l = new PointLight('#ffe2b8', intensity, 10, 1.5); l.position.set(s.x, s.y, s.z); g.add(l); }
  return g;
}

/** Glowing, pulsing floor ring for the onboarding move target. */
export class Marker {
  readonly mesh: Mesh;
  private readonly core: Mesh;
  private on = false;
  constructor(ringMat: Material, coreMat: Material) {
    const g = new RingGeometry(0.55, 0.85, 32); g.rotateX(-Math.PI / 2);
    this.mesh = new Mesh(g, ringMat); this.mesh.visible = false; this.mesh.name = 'marker'; this.mesh.renderOrder = 2;
    const cg = new CircleGeometry(0.45, 24); cg.rotateX(-Math.PI / 2);
    this.core = new Mesh(cg, coreMat); this.mesh.add(this.core);
  }
  set(pos: Vec3 | null): void { this.on = pos !== null; this.mesh.visible = this.on; if (pos) this.mesh.position.set(pos.x, pos.y + 0.03, pos.z); }
  update(clock: number): void { if (!this.on) return; const s = 1 + 0.12 * Math.sin(clock * 4); this.mesh.scale.set(s, 1, s); this.core.scale.setScalar(0.6 + 0.4 * Math.abs(Math.sin(clock * 2))); }
  dispose(): void { this.mesh.geometry.dispose(); this.core.geometry.dispose(); }
}

/**
 * Minimal CompiledMap-shaped diorama (crates, sandbags, a wall corner, lamps, a site letter) so the main
 * menu has a cinematic backdrop before the app has compiled a map. Pure data built from core/math only.
 */
export function menuDiorama(): Pick<CompiledMap, 'solids' | 'renderHints' | 'floorY' | 'sites' | 'spawns' | 'bounds'> {
  const S = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, kind: SolidDef['kind'], material: SolidDef['material']): SolidDef => ({ box: aabb(x0, y0, z0, x1, y1, z1), kind, material, surface: 'concrete', penetrable: false, penetrationFactor: 0 });
  const solids: SolidDef[] = [
    S(0, 0, 0, 16, 3, 2, 'wall', 'concrete'), S(0, 0, 2, 2, 3, 16, 'wall', 'concrete'), S(14, 0, 2, 16, 3, 16, 'wall', 'concrete'),
    S(4, 0, 4, 6, 2, 6, 'tallcrate', 'crate_wood'), S(6.5, 0, 4.5, 7.5, 1, 5.5, 'lowcrate', 'crate_wood'), S(4, 2, 4, 5, 3, 5, 'lowcrate', 'crate_wood'),
    S(9, 0, 9, 11, 1.2, 10, 'sandbag', 'sandbag'), S(11, 0, 4, 12, 1.9, 8, 'lip', 'metal'), S(0, 4.5, 0, 16, 5, 16, 'ceiling', 'ceiling'),
  ];
  const bounds = aabb(0, 0, 0, 16, 5, 16);
  const site = { x0: 6, z0: 9, x1: 12, z1: 15, y: 0 };
  return {
    solids, bounds, floorY: () => 0, sites: { a: site, b: site }, spawns: { T: [{ pos: v3(8, 0, 12), yaw: 0 }], CT: [{ pos: v3(9, 0, 12), yaw: 0 }] },
    renderHints: {
      solids: solids.map((s) => ({ material: s.material, kind: s.kind, uvScale: 0.5 as const })),
      floorQuads: [{ rect: { x0: 0, z0: 0, x1: 16, z1: 16, y: 0 }, material: 'floor' }],
      ramps: [], doorFrames: [], lamps: [v3(4, 4.4, 8), v3(8, 4.4, 8), v3(12, 4.4, 8), v3(8, 4.4, 12)],
      siteDecals: [{ site: 'a', rect: site }], wallSigns: [{ site: 'a', pos: v3(14, 2.2, 12), yaw: 90 * Math.PI / 180 }],
      radarWalls: [], bounds, ceilingY: 4.5,
    },
  };
}
