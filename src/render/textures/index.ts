/** Procedural textures (§10.1). DAY-0 STUB: flat colours; L6 implements the recipes. */
import type { Rng } from '../../core/rng';
import type { MaterialId } from '../../world/types';
import type { Ctx2D } from './ctx';

export const BASE_COLORS: Record<MaterialId, string> = {
  concrete: '#8d8f93', concrete_base: '#7a7c80', floor: '#4a4d52', floor_stripe: '#5a5a3a', crate_wood: '#9a6b3a', sandbag: '#8b8358', metal: '#6b7078',
  door_frame: '#3f4a6b', ceiling: '#2a2c30', lamp: '#ffffff', site_marker: '#ffd54f', skin_t: '#c8a24a', skin_ct: '#3d6fb5', gun_metal: '#2f3136', wood_stock: '#6b4a2a',
};

/** Pure recipe over a minimal Ctx2D (tests inject a recording fake). STUB: base colour + noise speckles. */
export function paintTexture(id: MaterialId, size: number, rng: Rng, ctx: Ctx2D): void {
  ctx.fillStyle = BASE_COLORS[id];
  ctx.fillRect(0, 0, size, size);
  ctx.globalAlpha = 0.15;
  for (let i = 0; i < 60; i++) { ctx.fillStyle = rng.chance(0.5) ? '#000' : '#fff'; ctx.fillRect(rng.int(0, size - 4), rng.int(0, size - 4), 4, 4); }
  ctx.globalAlpha = 1;
}

export function makeTexture(id: MaterialId, size: number, rng: Rng): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) paintTexture(id, size, rng, ctx);
  return canvas;
}
