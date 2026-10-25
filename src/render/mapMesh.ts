/**
 * Static map meshes (§10.1, §10.3): one merged BufferGeometry per bucket of mapGeometry.ts (≤ 8 draw calls),
 * with per-vertex AO / tint colours.
 */
import { BufferGeometry, Float32BufferAttribute, Mesh, Group } from 'three';
import type { CompiledMap } from '../world/types';
import { buildMapGeometry, MAP_BUCKETS, type MapBucket } from './mapGeometry';
import type { MaterialLib } from './materials';

export class MapMesh {
  readonly group = new Group();
  readonly meshes = new Map<MapBucket, Mesh>();
  triangles = 0;
  constructor(map: Pick<CompiledMap, 'solids' | 'renderHints' | 'floorY' | 'sites'>, lib: MaterialLib) {
    this.group.name = 'map';
    const geo = buildMapGeometry(map);
    for (const k of MAP_BUCKETS) {
      const b = geo[k]; if (b.idx.length === 0) continue;
      const g = new BufferGeometry();
      g.setAttribute('position', new Float32BufferAttribute(b.pos, 3));
      g.setAttribute('normal', new Float32BufferAttribute(b.nrm, 3));
      g.setAttribute('uv', new Float32BufferAttribute(b.uv, 2));
      g.setAttribute('color', new Float32BufferAttribute(b.col, 3));
      g.setIndex(b.idx);
      g.computeBoundingSphere();
      const m = new Mesh(g, lib.mapMaterial(k));
      m.name = 'map:' + k; m.matrixAutoUpdate = false; m.updateMatrix();
      if (k === 'site_marker') m.renderOrder = 1;
      this.group.add(m); this.meshes.set(k, m);
      this.triangles += b.idx.length / 3;
    }
  }
  dispose(): void { for (const m of this.meshes.values()) m.geometry.dispose(); this.meshes.clear(); }
}
