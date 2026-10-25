/** Radar projection (§8.1): rotates with the player so forward is up; quality presets table. */
import { describe, it, expect } from 'vitest';
import { Radar } from '../../../src/render/radar';
import { QUALITY, resolveQuality } from '../../../src/render/quality';

describe('render/radar', () => {
  it('forward is up for any yaw (§0: forward = (−sin yaw, −cos yaw))', () => {
    for (const yaw of [0, Math.PI / 2, -Math.PI / 2, Math.PI, 0.7]) {
      const p = Radar.project(10 - Math.sin(yaw) * 5, 10 - Math.cos(yaw) * 5, 10, 10, yaw, 2, 50);
      expect(p.x).toBeCloseTo(50, 6); expect(p.y).toBeCloseTo(40, 6);
    }
  });
  it('right of the player is right on the radar', () => {
    const yaw = 0.3, rx = Math.cos(yaw), rz = -Math.sin(yaw); // §0 right vector
    const p = Radar.project(rx * 4, rz * 4, 0, 0, yaw, 2, 50);
    expect(p.x).toBeCloseTo(58, 6); expect(p.y).toBeCloseTo(50, 6);
  });
});

describe('render/quality', () => {
  it('presets match §10.3', () => {
    expect(QUALITY.low).toMatchObject({ texSize: 256, phong: false, pointLights: 0, particles: 60, decals: 32, tracers: 32 });
    expect(QUALITY.medium).toMatchObject({ texSize: 512, phong: true, pointLights: 0, particles: 150, decals: 96, tracers: 64 });
    expect(QUALITY.high).toMatchObject({ texSize: 512, phong: true, pointLights: 4, particles: 300, decals: 200, tracers: 64, anisotropy: 4 });
    expect(resolveQuality('auto')).toBe('medium');
  });
});
