/**
 * Texture + material library for one quality preset (§10.1, §10.3): one CanvasTexture per MaterialId
 * (RepeatWrapping, mipmaps, sRGB, anisotropy 4 on High), Lambert on Low / Phong on Medium+. Rebuilt by
 * GameRenderer.setQuality; dispose() frees every texture and material it created.
 */
import { CanvasTexture, Color, MeshBasicMaterial, MeshLambertMaterial, MeshPhongMaterial, RepeatWrapping, SRGBColorSpace, ClampToEdgeWrapping, AdditiveBlending, type Material, type Texture } from 'three';
import { Rng } from '../core/rng';
import type { MaterialId } from '../world/types';
import { makeTexture, TRANSPARENT_MATERIALS } from './textures/index';
import { makeSprite, type SpriteId } from './textures/sprites';
import type { QualitySpec } from './quality';
import type { MapBucket } from './mapGeometry';

export type LitMaterial = MeshLambertMaterial | MeshPhongMaterial;
export interface LitOpts { map?: Texture | null; color?: string | Color; vertexColors?: boolean; emissive?: string; transparent?: boolean }

export class MaterialLib {
  private readonly textures = new Map<string, Texture>();
  private readonly mats: Material[] = [];
  private readonly cache = new Map<string, Material>();

  constructor(readonly spec: QualitySpec, private readonly maxAniso: number) {}

  texture(id: MaterialId): Texture {
    const key = 'm:' + id;
    let t = this.textures.get(key);
    if (!t) {
      const tex = new CanvasTexture(makeTexture(id, this.spec.texSize, new Rng(1337)));
      tex.wrapS = tex.wrapT = RepeatWrapping; tex.colorSpace = SRGBColorSpace;
      tex.anisotropy = Math.max(1, Math.min(this.spec.anisotropy, this.maxAniso));
      if (TRANSPARENT_MATERIALS.has(id)) tex.premultiplyAlpha = false;
      this.textures.set(key, tex); t = tex;
    }
    return t;
  }

  sprite(id: SpriteId): Texture {
    const key = 's:' + id;
    let t = this.textures.get(key);
    if (!t) {
      const tex = new CanvasTexture(makeSprite(id, new Rng(1337)));
      tex.wrapS = tex.wrapT = ClampToEdgeWrapping; tex.colorSpace = SRGBColorSpace;
      this.textures.set(key, tex); t = tex;
    }
    return t;
  }

  /** Lit material (Lambert on Low, Phong otherwise). */
  lit(o: LitOpts): LitMaterial {
    const params = { map: o.map ?? null, color: o.color ?? '#ffffff', vertexColors: o.vertexColors ?? false, transparent: o.transparent ?? false };
    const m = this.spec.phong ? new MeshPhongMaterial({ ...params, shininess: 12, specular: new Color('#1a1a1a') }) : new MeshLambertMaterial(params);
    if (o.emissive) m.emissive = new Color(o.emissive);
    this.mats.push(m);
    return m;
  }

  /** Cached lit material by key (shared between models). */
  shared(key: string, make: () => Material): Material {
    let m = this.cache.get(key);
    if (!m) { m = make(); this.cache.set(key, m); if (!this.mats.includes(m)) this.mats.push(m); }
    return m;
  }

  basic(params: ConstructorParameters<typeof MeshBasicMaterial>[0]): MeshBasicMaterial {
    const m = new MeshBasicMaterial(params); this.mats.push(m); return m;
  }

  additive(map: Texture | null, color = '#ffffff', opacity = 1): MeshBasicMaterial {
    return this.basic({ map, color, transparent: true, opacity, blending: AdditiveBlending, depthWrite: false, fog: false });
  }

  /** Material for one static-map bucket (§10.1 one texture per material; AO/tints in vertex colours). */
  mapMaterial(b: MapBucket): Material {
    return this.shared('map:' + b, () => {
      if (b === 'site_marker') return this.basic({ map: this.texture('site_marker'), transparent: true, alphaTest: 0.05, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
      return this.lit({ map: this.texture(b), vertexColors: true });
    });
  }

  /** Untextured white lit material for instanced meshes that carry per-instance colours. */
  plain(): Material { return this.shared('plain', () => this.lit({})); }
  /** Untextured lit material driven by vertex colours (merged weapon / prop geometry). */
  vertexLit(): Material { return this.shared('vertexLit', () => this.lit({ vertexColors: true })); }

  dispose(): void {
    for (const t of this.textures.values()) t.dispose();
    for (const m of this.mats) m.dispose();
    this.textures.clear(); this.cache.clear(); this.mats.length = 0;
  }
}
