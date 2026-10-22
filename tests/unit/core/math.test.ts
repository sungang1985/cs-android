import { describe, it, expect } from 'vitest';
import { v3, v3add, v3cross, v3norm, v3len, dirFromYawPitch, yawFromDir, pitchFromDir, wrapAngle, angleDelta, approachAngle, rayAabb, aabb, raySphere, rayVerticalCylinder, aabbFaceNormal, damp, DEG } from '@/core/math';

describe('vec3', () => {
  it('adds and normalises', () => {
    const r = v3add(v3(1, 2, 3), v3(1, 1, 1));
    expect(r).toEqual({ x: 2, y: 3, z: 4 });
    expect(v3len(v3norm(v3(3, 4, 0)))).toBeCloseTo(1);
    expect(v3norm(v3(0, 0, 0))).toEqual({ x: 0, y: 0, z: 0 });
  });
  it('cross product is right-handed', () => {
    expect(v3cross(v3(1, 0, 0), v3(0, 1, 0))).toEqual({ x: 0, y: 0, z: 1 });
  });
});

describe('angles', () => {
  it('yaw 0 looks down -Z and round-trips', () => {
    const d = dirFromYawPitch(0, 0);
    expect(d.z).toBeCloseTo(-1); expect(d.x).toBeCloseTo(0);
    for (const yaw of [0, 0.5, -2, 3]) for (const pitch of [0, 0.3, -1]) {
      const dir = dirFromYawPitch(yaw, pitch);
      expect(angleDelta(yawFromDir(dir), yaw)).toBeCloseTo(0, 5);
      expect(pitchFromDir(dir)).toBeCloseTo(pitch, 5);
    }
  });
  it('positive yaw turns left (toward -X)', () => {
    expect(dirFromYawPitch(90 * DEG, 0).x).toBeCloseTo(-1);
  });
  it('wraps and approaches', () => {
    expect(wrapAngle(Math.PI * 3)).toBeCloseTo(Math.PI);
    expect(angleDelta(3, -3)).toBeCloseTo(2 * Math.PI - 6);
    expect(approachAngle(0, 1, 0.25)).toBeCloseTo(0.25);
    expect(approachAngle(0, 0.1, 0.25)).toBeCloseTo(0.1);
  });
  it('damp is frame-rate independent', () => {
    let a = 0; for (let i = 0; i < 60; i++) a = damp(a, 1, 5, 1 / 60);
    let b = 0; for (let i = 0; i < 30; i++) b = damp(b, 1, 5, 1 / 30);
    expect(a).toBeCloseTo(b, 6);
  });
});

describe('ray casts', () => {
  const box = aabb(-1, 0, -1, 1, 2, 1);
  it('hits an AABB from outside and returns entry distance', () => {
    expect(rayAabb(v3(0, 1, -5), v3(0, 0, 1), box)).toBeCloseTo(4);
    expect(rayAabb(v3(0, 1, -5), v3(0, 0, -1), box)).toBeNull();
    expect(rayAabb(v3(0, 1, -5), v3(0, 0, 1), box, 3)).toBeNull();
    expect(rayAabb(v3(0, 1, 0), v3(0, 0, 1), box)).toBe(0);
    expect(rayAabb(v3(5, 1, 0), v3(0, 0, 1), box)).toBeNull();
  });
  it('face normal', () => {
    expect(aabbFaceNormal(box, v3(0, 1, -1))).toEqual({ x: 0, y: 0, z: -1 });
    expect(aabbFaceNormal(box, v3(1, 1, 0.2))).toEqual({ x: 1, y: 0, z: 0 });
  });
  it('sphere', () => {
    expect(raySphere(v3(0, 0, -5), v3(0, 0, 1), v3(0, 0, 0), 1)).toBeCloseTo(4);
    expect(raySphere(v3(0, 2, -5), v3(0, 0, 1), v3(0, 0, 0), 1)).toBeNull();
    expect(raySphere(v3(0, 0, 0), v3(0, 0, 1), v3(0, 0, 0), 1)).toBeCloseTo(1);
  });
  it('vertical cylinder (body hitbox)', () => {
    expect(rayVerticalCylinder(v3(0, 1, -5), v3(0, 0, 1), 0, 0, 0, 1.8, 0.4)).toBeCloseTo(4.6);
    expect(rayVerticalCylinder(v3(0, 3, -5), v3(0, 0, 1), 0, 0, 0, 1.8, 0.4)).toBeNull();
    // from above, straight down onto the top cap
    expect(rayVerticalCylinder(v3(0.1, 5, 0), v3(0, -1, 0), 0, 0, 0, 1.8, 0.4)).toBeCloseTo(3.2);
    // diagonal entering through the top cap
    const t = rayVerticalCylinder(v3(0, 3, -2), v3norm(v3(0, -1, 1)), 0, 0, 0, 1.8, 0.4);
    expect(t).not.toBeNull();
  });
});
