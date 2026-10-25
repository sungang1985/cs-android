/**
 * Effect sprites (§10.1 last rows). The MaterialId union is frozen, so sprites use their own id set.
 * Pure recipes over Ctx2D (transparent canvas; nothing paints a background).
 */
import type { Rng } from '../../core/rng';
import type { Ctx2D } from './ctx';
import { radialBlob } from './paint';

export type SpriteId = 'blood_decal' | 'bullet_hole' | 'muzzle' | 'blob_shadow' | 'smoke' | 'spark' | 'ring';
export const SPRITE_IDS: readonly SpriteId[] = ['blood_decal', 'bullet_hole', 'muzzle', 'blob_shadow', 'smoke', 'spark', 'ring'];
export const SPRITE_SIZE: Record<SpriteId, number> = { blood_decal: 128, bullet_hole: 64, muzzle: 128, blob_shadow: 64, smoke: 64, spark: 32, ring: 128 };

export function paintSprite(id: SpriteId, size: number, rng: Rng, ctx: Ctx2D): void {
  const c = size / 2;
  ctx.globalAlpha = 1;
  switch (id) {
    case 'blood_decal':
      for (let i = 0; i < 6; i++) {
        const r = size * rng.range(0.12, 0.3), a = rng.range(0, Math.PI * 2), d = i === 0 ? 0 : size * rng.range(0.08, 0.28);
        radialBlob(ctx, c + Math.cos(a) * d, c + Math.sin(a) * d, r, 'rgba(122,15,15,0.95)', 'rgba(122,15,15,0)');
      }
      break;
    case 'bullet_hole': {
      radialBlob(ctx, c, c, size * 0.42, 'rgba(90,90,90,0.55)', 'rgba(90,90,90,0)');
      ctx.strokeStyle = 'rgba(30,30,30,0.7)'; ctx.lineWidth = size / 40;
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2 + rng.range(-0.3, 0.3), r0 = size * 0.12, r1 = size * rng.range(0.25, 0.42);
        ctx.beginPath(); ctx.moveTo(c + Math.cos(a) * r0, c + Math.sin(a) * r0); ctx.lineTo(c + Math.cos(a) * r1, c + Math.sin(a) * r1); ctx.stroke();
      }
      ctx.fillStyle = '#0a0a0a'; ctx.beginPath(); ctx.arc(c, c, size * 0.13, 0, Math.PI * 2); ctx.fill();
      break;
    }
    case 'muzzle': {
      ctx.fillStyle = 'rgba(255,179,71,0.9)';
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2 + rng.range(-0.2, 0.2), len = size * rng.range(0.35, 0.49), w = 0.22;
        ctx.beginPath(); ctx.moveTo(c + Math.cos(a - w) * size * 0.1, c + Math.sin(a - w) * size * 0.1); ctx.lineTo(c + Math.cos(a) * len, c + Math.sin(a) * len); ctx.lineTo(c + Math.cos(a + w) * size * 0.1, c + Math.sin(a + w) * size * 0.1); ctx.closePath(); ctx.fill();
      }
      const g = ctx.createRadialGradient(c, c, 0, c, c, c);
      g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.3, 'rgba(255,179,71,0.85)'); g.addColorStop(1, 'rgba(255,179,71,0)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, size, size);
      break;
    }
    case 'blob_shadow': radialBlob(ctx, c, c, c, 'rgba(0,0,0,0.6)', 'rgba(0,0,0,0)'); break;
    case 'smoke': radialBlob(ctx, c, c, c, 'rgba(200,200,200,0.55)', 'rgba(200,200,200,0)'); break;
    case 'spark': radialBlob(ctx, c, c, c, 'rgba(255,255,255,1)', 'rgba(255,255,255,0)'); break;
    case 'ring': {
      const g = ctx.createRadialGradient(c, c, size * 0.28, c, c, c);
      g.addColorStop(0, 'rgba(255,213,79,0)'); g.addColorStop(0.45, 'rgba(255,213,79,1)'); g.addColorStop(0.6, 'rgba(255,255,255,1)'); g.addColorStop(1, 'rgba(255,213,79,0)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, size, size);
      break;
    }
  }
  ctx.globalAlpha = 1;
}

export function makeSprite(id: SpriteId, rng: Rng): HTMLCanvasElement {
  const size = SPRITE_SIZE[id];
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) paintSprite(id, size, rng, ctx);
  return canvas;
}
