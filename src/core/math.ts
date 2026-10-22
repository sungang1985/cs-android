/**
 * Pure math helpers for the simulation. No DOM, no Three.js.
 * Vec3 is a plain object so state stays structuredClone/JSON safe.
 * Coordinate system: +X east, +Y up, +Z south (right-handed, matches Three.js). Yaw 0 looks toward -Z,
 * positive yaw turns left (counter-clockwise seen from above), pitch positive looks up. Angles in radians.
 */
export interface Vec3 { x: number; y: number; z: number }
export interface Vec2 { x: number; y: number }

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;
export const EPS = 1e-6;

export function v3(x = 0, y = 0, z = 0): Vec3 { return { x, y, z }; }
export function v3copy(a: Vec3): Vec3 { return { x: a.x, y: a.y, z: a.z }; }
export function v3set(out: Vec3, x: number, y: number, z: number): Vec3 { out.x = x; out.y = y; out.z = z; return out; }
export function v3assign(out: Vec3, a: Vec3): Vec3 { out.x = a.x; out.y = a.y; out.z = a.z; return out; }
export function v3add(a: Vec3, b: Vec3, out: Vec3 = v3()): Vec3 { out.x = a.x + b.x; out.y = a.y + b.y; out.z = a.z + b.z; return out; }
export function v3sub(a: Vec3, b: Vec3, out: Vec3 = v3()): Vec3 { out.x = a.x - b.x; out.y = a.y - b.y; out.z = a.z - b.z; return out; }
export function v3scale(a: Vec3, s: number, out: Vec3 = v3()): Vec3 { out.x = a.x * s; out.y = a.y * s; out.z = a.z * s; return out; }
export function v3addScaled(a: Vec3, b: Vec3, s: number, out: Vec3 = v3()): Vec3 { out.x = a.x + b.x * s; out.y = a.y + b.y * s; out.z = a.z + b.z * s; return out; }
export function v3dot(a: Vec3, b: Vec3): number { return a.x * b.x + a.y * b.y + a.z * b.z; }
export function v3cross(a: Vec3, b: Vec3, out: Vec3 = v3()): Vec3 {
  const x = a.y * b.z - a.z * b.y, y = a.z * b.x - a.x * b.z, z = a.x * b.y - a.y * b.x;
  out.x = x; out.y = y; out.z = z; return out;
}
export function v3len(a: Vec3): number { return Math.hypot(a.x, a.y, a.z); }
export function v3lenSq(a: Vec3): number { return a.x * a.x + a.y * a.y + a.z * a.z; }
export function v3dist(a: Vec3, b: Vec3): number { return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z); }
export function v3distSq(a: Vec3, b: Vec3): number { const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z; return dx * dx + dy * dy + dz * dz; }
/** Horizontal (XZ) distance. */
export function v3distXZ(a: Vec3, b: Vec3): number { return Math.hypot(a.x - b.x, a.z - b.z); }
export function v3norm(a: Vec3, out: Vec3 = v3()): Vec3 {
  const l = v3len(a);
  if (l < EPS) { out.x = 0; out.y = 0; out.z = 0; return out; }
  out.x = a.x / l; out.y = a.y / l; out.z = a.z / l; return out;
}
export function v3lerp(a: Vec3, b: Vec3, t: number, out: Vec3 = v3()): Vec3 {
  out.x = a.x + (b.x - a.x) * t; out.y = a.y + (b.y - a.y) * t; out.z = a.z + (b.z - a.z) * t; return out;
}
export function v3eq(a: Vec3, b: Vec3, eps = EPS): boolean { return Math.abs(a.x - b.x) <= eps && Math.abs(a.y - b.y) <= eps && Math.abs(a.z - b.z) <= eps; }

/** Unit forward vector for yaw/pitch (yaw 0 → -Z, yaw +90° → -X; pitch + looks up). */
export function dirFromYawPitch(yaw: number, pitch: number, out: Vec3 = v3()): Vec3 {
  const cp = Math.cos(pitch);
  out.x = -Math.sin(yaw) * cp; out.y = Math.sin(pitch); out.z = -Math.cos(yaw) * cp; return out;
}
/** Horizontal forward (ignores pitch). */
export function forwardXZ(yaw: number, out: Vec3 = v3()): Vec3 { out.x = -Math.sin(yaw); out.y = 0; out.z = -Math.cos(yaw); return out; }
/** Horizontal right vector for a yaw. */
export function rightXZ(yaw: number, out: Vec3 = v3()): Vec3 { out.x = Math.cos(yaw); out.y = 0; out.z = -Math.sin(yaw); return out; }
/** Yaw that looks along a direction (XZ). */
export function yawFromDir(d: Vec3): number { return Math.atan2(-d.x, -d.z); }
/** Pitch that looks along a direction. */
export function pitchFromDir(d: Vec3): number { return Math.atan2(d.y, Math.hypot(d.x, d.z)); }

export function clamp(v: number, lo: number, hi: number): number { return v < lo ? lo : v > hi ? hi : v; }
export function clamp01(v: number): number { return v < 0 ? 0 : v > 1 ? 1 : v; }
export function lerp(a: number, b: number, t: number): number { return a + (b - a) * t; }
export function inverseLerp(a: number, b: number, v: number): number { return a === b ? 0 : (v - a) / (b - a); }
export function remap(v: number, a0: number, a1: number, b0: number, b1: number): number { return lerp(b0, b1, clamp01(inverseLerp(a0, a1, v))); }
export function smoothstep(e0: number, e1: number, x: number): number { const t = clamp01((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); }
/** Exponential decay toward target, frame-rate independent: rate = fraction removed per second as 1/tau. */
export function damp(current: number, target: number, lambda: number, dt: number): number { return lerp(current, target, 1 - Math.exp(-lambda * dt)); }
/** Wrap an angle to (-PI, PI]. */
export function wrapAngle(a: number): number {
  a = a % (2 * Math.PI);
  if (a > Math.PI) a -= 2 * Math.PI; else if (a <= -Math.PI) a += 2 * Math.PI;
  return a;
}
/** Signed shortest difference b - a in (-PI, PI]. */
export function angleDelta(a: number, b: number): number { return wrapAngle(b - a); }
/** Move angle `a` toward `b` by at most `maxStep` radians. */
export function approachAngle(a: number, b: number, maxStep: number): number {
  const d = angleDelta(a, b);
  return Math.abs(d) <= maxStep ? b : a + Math.sign(d) * maxStep;
}
export function approach(a: number, b: number, maxStep: number): number {
  const d = b - a; return Math.abs(d) <= maxStep ? b : a + Math.sign(d) * maxStep;
}

/** Axis-aligned bounding box. */
export interface Aabb { min: Vec3; max: Vec3 }
export function aabb(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): Aabb {
  return { min: v3(Math.min(minX, maxX), Math.min(minY, maxY), Math.min(minZ, maxZ)), max: v3(Math.max(minX, maxX), Math.max(minY, maxY), Math.max(minZ, maxZ)) };
}
export function aabbFromCenter(c: Vec3, half: Vec3): Aabb { return { min: v3(c.x - half.x, c.y - half.y, c.z - half.z), max: v3(c.x + half.x, c.y + half.y, c.z + half.z) }; }
export function aabbOverlap(a: Aabb, b: Aabb): boolean {
  return a.min.x < b.max.x && a.max.x > b.min.x && a.min.y < b.max.y && a.max.y > b.min.y && a.min.z < b.max.z && a.max.z > b.min.z;
}
export function aabbContains(a: Aabb, p: Vec3): boolean {
  return p.x >= a.min.x && p.x <= a.max.x && p.y >= a.min.y && p.y <= a.max.y && p.z >= a.min.z && p.z <= a.max.z;
}
export function aabbCenter(a: Aabb, out: Vec3 = v3()): Vec3 { out.x = (a.min.x + a.max.x) / 2; out.y = (a.min.y + a.max.y) / 2; out.z = (a.min.z + a.max.z) / 2; return out; }
export function aabbExpand(a: Aabb, r: number): Aabb { return { min: v3(a.min.x - r, a.min.y - r, a.min.z - r), max: v3(a.max.x + r, a.max.y + r, a.max.z + r) }; }

/**
 * Ray vs AABB (slab method). Returns the entry distance t in [0, tMax] or null.
 * A ray starting inside the box returns 0.
 */
export function rayAabb(origin: Vec3, dir: Vec3, box: Aabb, tMax = Infinity): number | null {
  let tmin = 0, tmax = tMax;
  const o = [origin.x, origin.y, origin.z], d = [dir.x, dir.y, dir.z];
  const mn = [box.min.x, box.min.y, box.min.z], mx = [box.max.x, box.max.y, box.max.z];
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-12) {
      if (o[i] < mn[i] || o[i] > mx[i]) return null;
    } else {
      const inv = 1 / d[i];
      let t1 = (mn[i] - o[i]) * inv, t2 = (mx[i] - o[i]) * inv;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return null;
    }
  }
  return tmin;
}
/** Which face normal the ray hit on an AABB at point p (for decals). */
export function aabbFaceNormal(box: Aabb, p: Vec3, out: Vec3 = v3()): Vec3 {
  const dx = Math.min(Math.abs(p.x - box.min.x), Math.abs(p.x - box.max.x));
  const dy = Math.min(Math.abs(p.y - box.min.y), Math.abs(p.y - box.max.y));
  const dz = Math.min(Math.abs(p.z - box.min.z), Math.abs(p.z - box.max.z));
  out.x = 0; out.y = 0; out.z = 0;
  if (dx <= dy && dx <= dz) out.x = Math.abs(p.x - box.min.x) < Math.abs(p.x - box.max.x) ? -1 : 1;
  else if (dy <= dz) out.y = Math.abs(p.y - box.min.y) < Math.abs(p.y - box.max.y) ? -1 : 1;
  else out.z = Math.abs(p.z - box.min.z) < Math.abs(p.z - box.max.z) ? -1 : 1;
  return out;
}
/** Ray vs sphere. Returns nearest t >= 0 (<= tMax) or null. */
export function raySphere(origin: Vec3, dir: Vec3, center: Vec3, radius: number, tMax = Infinity): number | null {
  const lx = center.x - origin.x, ly = center.y - origin.y, lz = center.z - origin.z;
  const tca = lx * dir.x + ly * dir.y + lz * dir.z;
  const d2 = lx * lx + ly * ly + lz * lz - tca * tca;
  const r2 = radius * radius;
  if (d2 > r2) return null;
  const thc = Math.sqrt(r2 - d2);
  let t = tca - thc;
  if (t < 0) t = tca + thc;
  if (t < 0 || t > tMax) return null;
  return t;
}
/**
 * Ray vs vertical capsule-ish cylinder with hemispherical ends approximated as: a cylinder of radius r from
 * y0..y1 plus a sphere at the top (for head hits callers test a separate sphere). Returns t or null.
 */
export function rayVerticalCylinder(origin: Vec3, dir: Vec3, cx: number, cz: number, y0: number, y1: number, r: number, tMax = Infinity): number | null {
  // Solve in XZ: |o + t d - c|^2 = r^2
  const ox = origin.x - cx, oz = origin.z - cz;
  const a = dir.x * dir.x + dir.z * dir.z;
  const b = 2 * (ox * dir.x + oz * dir.z);
  const c = ox * ox + oz * oz - r * r;
  let tEnter: number;
  if (a < 1e-12) {
    if (c > 0) return null; // vertical ray outside cylinder
    tEnter = 0;
  } else {
    const disc = b * b - 4 * a * c;
    if (disc < 0) return null;
    const s = Math.sqrt(disc);
    const t1 = (-b - s) / (2 * a), t2 = (-b + s) / (2 * a);
    if (t2 < 0) return null;
    tEnter = t1 >= 0 ? t1 : 0; // inside → 0
    // Clip against y slab along the ray's cylinder interval [tEnter, t2]
    const yA = origin.y + dir.y * tEnter;
    if (yA >= y0 && yA <= y1) return tEnter <= tMax ? tEnter : null;
    // enters cylinder outside the y range: check cap planes
    if (Math.abs(dir.y) < 1e-12) return null;
    const tCap = yA < y0 ? (y0 - origin.y) / dir.y : (y1 - origin.y) / dir.y;
    if (tCap < tEnter || tCap > t2 || tCap > tMax || tCap < 0) return null;
    return tCap;
  }
  if (origin.y >= y0 && origin.y <= y1) return 0;
  if (Math.abs(dir.y) < 1e-12) return null;
  const tCap = origin.y < y0 ? (y0 - origin.y) / dir.y : (y1 - origin.y) / dir.y;
  return tCap >= 0 && tCap <= tMax ? tCap : null;
}

/** Fast integer hash (for golden tests and deterministic ids). */
export function hashInts(...nums: number[]): number {
  let h = 2166136261 >>> 0;
  for (const n of nums) {
    const x = Math.fround(n);
    const buf = new DataView(new ArrayBuffer(4)); buf.setFloat32(0, x);
    const u = buf.getUint32(0);
    h ^= u & 0xff; h = Math.imul(h, 16777619) >>> 0;
    h ^= (u >>> 8) & 0xff; h = Math.imul(h, 16777619) >>> 0;
    h ^= (u >>> 16) & 0xff; h = Math.imul(h, 16777619) >>> 0;
    h ^= (u >>> 24) & 0xff; h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}
