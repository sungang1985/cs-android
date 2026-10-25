/** Quality presets (§10.3). The app resolves 'auto' (app/perf.ts); the renderer only implements the presets. */
import type { QualityPreset } from '../settings/types';

export interface QualitySpec { texSize: 256 | 512; phong: boolean; pointLights: number; particles: number; decals: number; tracers: number; anisotropy: number }

export const QUALITY: Record<'low' | 'medium' | 'high', QualitySpec> = {
  low: { texSize: 256, phong: false, pointLights: 0, particles: 60, decals: 32, tracers: 32, anisotropy: 1 },
  medium: { texSize: 512, phong: true, pointLights: 0, particles: 150, decals: 96, tracers: 64, anisotropy: 1 },
  high: { texSize: 512, phong: true, pointLights: 4, particles: 300, decals: 200, tracers: 64, anisotropy: 4 },
};

export function resolveQuality(q: QualityPreset): 'low' | 'medium' | 'high' { return q === 'low' || q === 'high' ? q : 'medium'; }
