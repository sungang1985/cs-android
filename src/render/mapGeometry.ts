/**
 * Static map geometry (§10.1, §10.3, §3.5 render hints), pure (no three/DOM): builds one vertex bucket per
 * draw material from `map.solids` + `map.renderHints`. `mapMesh.ts` turns each bucket into one merged
 * BufferGeometry, so the static map costs ≤ 8 draw calls:
 *   concrete (walls + dark-tinted ceiling) · concrete_base (lowest wall band) · floor · floor_stripe (site borders)
 *   crate_wood · sandbag · metal (platform, lips, ramps, corrugated wall band, door frames/lintels tinted) ·
 *   site_marker (unlit atlas: site letters on floor + wall signs, lamp panels).
 * UVs are world metres × uvScale (0.5 → 1 repeat / 2 m) except crates (per-face 0..1) and the base band
 * (v spans the band). Vertex colours carry AO (×0.75 within 0.5 m of floor–wall seams) and tints; they are
 * linear multipliers (sRGB factor^2.2) because three treats vertex colours as linear.
 */
import type { Aabb } from '../core/math';
import type { CompiledMap, SolidDef, MaterialId, WorldRect } from '../world/types';

export type MapBucket = 'concrete' | 'concrete_base' | 'floor' | 'floor_stripe' | 'crate_wood' | 'sandbag' | 'metal' | 'site_marker';
export const MAP_BUCKETS: readonly MapBucket[] = ['concrete', 'concrete_base', 'floor', 'floor_stripe', 'crate_wood', 'sandbag', 'metal', 'site_marker'];
export interface GeoBucket { pos: number[]; nrm: number[]; uv: number[]; col: number[]; idx: number[] }
export type MapGeometry = Record<MapBucket, GeoBucket>;
export type MapInput = Pick<CompiledMap, 'solids' | 'renderHints' | 'floorY' | 'sites'>;

/** sRGB factor → linear multiplier. */
export const lin = (v: number): number => Math.pow(v, 2.2);
type Col = [number, number, number];
const WHITE: Col = [1, 1, 1];
export const TINT = {
  door: [lin(0.59), lin(0.66), lin(0.89)] as Col,
  corrugated: [lin(0.8), lin(0.86), lin(0.96)] as Col,
  ceiling: [lin(0.4), lin(0.4), lin(0.42)] as Col,
};
export const AO = { factor: 0.75, dist: 0.5 } as const;
export const BAND = { base: 0.8, corrugated: 2.4, stripe: 0.35 } as const;

/** Bucket for a solid's material (null = not drawn). */
export function bucketFor(m: MaterialId | null): MapBucket | null {
  switch (m) {
    case null: return null;
    case 'concrete': case 'concrete_base': case 'ceiling': return m === 'concrete_base' ? 'concrete_base' : 'concrete';
    case 'floor': return 'floor';
    case 'floor_stripe': return 'floor_stripe';
    case 'crate_wood': return 'crate_wood';
    case 'sandbag': return 'sandbag';
    case 'site_marker': case 'lamp': return 'site_marker';
    default: return 'metal';
  }
}
/** Solids the renderer draws (seals are invisible, ramp steps are covered by wedges). */
export function isDrawn(s: SolidDef): boolean { return s.material !== null && s.kind !== 'seal' && s.kind !== 'ramp-step'; }

function newBucket(): GeoBucket { return { pos: [], nrm: [], uv: [], col: [], idx: [] }; }

type V3 = [number, number, number];
function pushQuad(b: GeoBucket, p: V3[], n: V3, uv: number[], col: Col[]): void {
  const base = b.pos.length / 3;
  for (let i = 0; i < 4; i++) { b.pos.push(p[i][0], p[i][1], p[i][2]); b.nrm.push(n[0], n[1], n[2]); b.uv.push(uv[2 * i], uv[2 * i + 1]); b.col.push(col[i][0], col[i][1], col[i][2]); }
  b.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
}
function pushTri(b: GeoBucket, p: V3[], n: V3, uv: number[], col: Col): void {
  const base = b.pos.length / 3;
  for (let i = 0; i < 3; i++) { b.pos.push(p[i][0], p[i][1], p[i][2]); b.nrm.push(n[0], n[1], n[2]); b.uv.push(uv[2 * i], uv[2 * i + 1]); b.col.push(col[0], col[1], col[2]); }
  b.idx.push(base, base + 1, base + 2);
}
function mul(a: Col, k: number): Col { return [a[0] * k, a[1] * k, a[2] * k]; }
function aoAt(heightAboveFloor: number): number { return lin(AO.factor + (1 - AO.factor) * Math.min(1, Math.max(0, heightAboveFloor / AO.dist))); }

/** Distance in XZ from a point to a box footprint. */
function footDist(b: Aabb, x: number, z: number): number {
  const dx = Math.max(b.min.x - x, 0, x - b.max.x), dz = Math.max(b.min.z - z, 0, z - b.max.z);
  return Math.hypot(dx, dz);
}

interface FaceOpts { bucket: MapBucket; tint: Col; perFaceUv: boolean; ao: boolean; wallBands: boolean; uvScale: number }

export function buildMapGeometry(map: MapInput): MapGeometry {
  const out = {} as MapGeometry;
  for (const k of MAP_BUCKETS) out[k] = newBucket();
  const hints = map.renderHints;
  const bounds = hints.bounds;
  const eps = 1e-3;

  // ── solids ──
  map.solids.forEach((s, i) => {
    if (!isDrawn(s)) return;
    const h = hints.solids[i] ?? { material: s.material, kind: s.kind, uvScale: 0.5 };
    const kind = h.kind, mat = h.material;
    const bucket = bucketFor(mat); if (!bucket) return;
    const b = s.box;
    const crate = mat === 'crate_wood';
    const tint: Col = kind === 'ceiling' ? TINT.ceiling : mat === 'door_frame' ? TINT.door : WHITE;
    const o: FaceOpts = { bucket, tint, perFaceUv: crate, ao: kind !== 'ceiling' && kind !== 'lintel', wallBands: kind === 'wall', uvScale: h.uvScale };
    if (kind === 'ceiling') { bottomFace(out[bucket], b, o); return; }
    const onBoundary = (axis: 'x' | 'z', side: -1 | 1) => (axis === 'x' ? (side < 0 ? b.min.x <= bounds.min.x + eps : b.max.x >= bounds.max.x - eps) : (side < 0 ? b.min.z <= bounds.min.z + eps : b.max.z >= bounds.max.z - eps));
    for (const [nx, nz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      if (onBoundary(nx !== 0 ? 'x' : 'z', (nx + nz) as -1 | 1)) continue;
      verticalFace(out, b, nx, nz, o, map.floorY);
    }
    if (kind !== 'platform') topFace(out[bucket], b, o);
    if (kind === 'lintel') bottomFace(out[bucket], b, o);
  });

  // ── backdrop: the map perimeter is closed up to the ceiling (from the A platform the eye is above the 3 m
  //    outer walls, so the void between wall tops and the ceiling must not read as a hole). Inward-facing,
  //    corrugated-metal cladding on the bounds planes; below the wall tops it is hidden inside the walls.
  {
    const b = bounds, top = hints.ceilingY, tint = TINT.corrugated;
    const P = (x: number, y: number, z: number): V3 => [x, y, z];
    const sides: [V3[], V3][] = [
      [[P(b.min.x, 0, b.max.z), P(b.min.x, 0, b.min.z), P(b.min.x, top, b.min.z), P(b.min.x, top, b.max.z)], [1, 0, 0]],
      [[P(b.max.x, 0, b.min.z), P(b.max.x, 0, b.max.z), P(b.max.x, top, b.max.z), P(b.max.x, top, b.min.z)], [-1, 0, 0]],
      [[P(b.min.x, 0, b.min.z), P(b.max.x, 0, b.min.z), P(b.max.x, top, b.min.z), P(b.min.x, top, b.min.z)], [0, 0, 1]],
      [[P(b.max.x, 0, b.max.z), P(b.min.x, 0, b.max.z), P(b.min.x, top, b.max.z), P(b.max.x, top, b.max.z)], [0, 0, -1]],
    ];
    for (const [q, n] of sides) {
      const r: V3 = [n[2], 0, -n[0]];
      const u = (p: V3) => (p[0] * r[0] + p[2] * r[2]) * 2;
      pushQuad(out.metal, q, n, [u(q[0]), q[0][1] * 0.1, u(q[1]), q[1][1] * 0.1, u(q[2]), q[2][1] * 0.1, u(q[3]), q[3][1] * 0.1], [tint, tint, tint, tint]);
    }
  }

  // ── floors (rectilinear grid so AO and site borders get their own vertices) ──
  const aoSolids = map.solids.filter((s) => isDrawn(s) && s.kind !== 'ceiling' && s.kind !== 'lintel');
  const covering = map.solids.filter((s) => (isDrawn(s) && s.kind !== 'ceiling') || s.kind === 'ramp-step');
  const levelLines = new Map<number, { x: number[]; z: number[] }>();
  for (const fq of hints.floorQuads) {
    const r = fq.rect, y = r.y;
    const level = aoSolids.filter((s) => s.box.min.y <= y + 0.01 && s.box.max.y >= y + 0.2);
    const cover = covering.filter((s) => s.box.min.y <= y + 0.01 && s.box.max.y > y + 0.01);
    const sites = hints.siteDecals.filter((d) => Math.abs(d.rect.y - y) < 0.01).map((d) => d.rect);
    // grid lines are shared by every floor quad of this level, so neighbouring quads (greedy rectangles) get
    // identical vertices along their common edges (no T-junction sparkles)
    const key = Math.round(y * 1000);
    let lines = levelLines.get(key);
    if (!lines) {
      const gx = new Set<number>(), gz = new Set<number>();
      const ax = (v: number) => gx.add(Math.round(v * 1000) / 1000), az = (v: number) => gz.add(Math.round(v * 1000) / 1000);
      for (const q of hints.floorQuads) if (Math.abs(q.rect.y - y) < 0.01) { ax(q.rect.x0); ax(q.rect.x1); az(q.rect.z0); az(q.rect.z1); }
      for (const s of level) { const bb = s.box; ax(bb.min.x); ax(bb.max.x); ax(bb.min.x - AO.dist); ax(bb.max.x + AO.dist); az(bb.min.z); az(bb.max.z); az(bb.min.z - AO.dist); az(bb.max.z + AO.dist); }
      for (const s of cover) { ax(s.box.min.x); ax(s.box.max.x); az(s.box.min.z); az(s.box.max.z); }
      for (const sr of sites) { ax(sr.x0); ax(sr.x1); ax(sr.x0 + BAND.stripe); ax(sr.x1 - BAND.stripe); az(sr.z0); az(sr.z1); az(sr.z0 + BAND.stripe); az(sr.z1 - BAND.stripe); }
      for (let v = Math.floor(bounds.min.x / 4) * 4; v < bounds.max.x; v += 4) ax(v);
      for (let v = Math.floor(bounds.min.z / 4) * 4; v < bounds.max.z; v += 4) az(v);
      lines = { x: [...gx], z: [...gz] }; levelLines.set(key, lines);
    }
    const xs = new Set<number>([r.x0, r.x1, ...lines.x.filter((v) => v > r.x0 && v < r.x1)]);
    const zs = new Set<number>([r.z0, r.z1, ...lines.z.filter((v) => v > r.z0 && v < r.z1)]);
    const X = [...xs].sort((a, c) => a - c), Z = [...zs].sort((a, c) => a - c);
    const nx = X.length, nz = Z.length;
    const ao = new Float32Array(nx * nz);
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
      let d = Infinity;
      for (const s of level) { const dd = footDist(s.box, X[i], Z[j]); if (dd < d) d = dd; }
      ao[j * nx + i] = aoAt(d);
    }
    const inside = (sr: WorldRect, x: number, z: number, inset: number) => x > sr.x0 + inset && x < sr.x1 - inset && z > sr.z0 + inset && z < sr.z1 - inset;
    const floorBucket = bucketFor(fq.material) ?? 'floor';
    for (let j = 0; j + 1 < nz; j++) for (let i = 0; i + 1 < nx; i++) {
      const x0 = X[i], x1 = X[i + 1], z0 = Z[j], z1 = Z[j + 1], cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
      if (cover.some((s) => cx > s.box.min.x && cx < s.box.max.x && cz > s.box.min.z && cz < s.box.max.z)) continue;
      const stripe = sites.some((sr) => inside(sr, cx, cz, 0) && !inside(sr, cx, cz, BAND.stripe));
      const bk = out[stripe ? 'floor_stripe' : floorBucket];
      const a00 = ao[j * nx + i], a10 = ao[j * nx + i + 1], a01 = ao[(j + 1) * nx + i], a11 = ao[(j + 1) * nx + i + 1];
      pushQuad(bk, [[x0, y, z1], [x1, y, z1], [x1, y, z0], [x0, y, z0]], [0, 1, 0],
        [x0 * 0.5, -z1 * 0.5, x1 * 0.5, -z1 * 0.5, x1 * 0.5, -z0 * 0.5, x0 * 0.5, -z0 * 0.5],
        [[a01, a01, a01], [a11, a11, a11], [a10, a10, a10], [a00, a00, a00]]);
    }
  }

  // ── ramps: wedges over the stair boxes ──
  for (const rp of hints.ramps) {
    const d: V3 = rp.ascend === 'e' ? [1, 0, 0] : rp.ascend === 'w' ? [-1, 0, 0] : rp.ascend === 's' ? [0, 0, 1] : [0, 0, -1];
    const w: V3 = [-d[2], 0, d[0]];
    const hw = rp.width / 2, L = rp.length, o = rp.origin;
    const P = (side: number, along: number, y: number): V3 => [o.x + w[0] * side * hw + d[0] * along * L, y, o.z + w[2] * side * hw + d[2] * along * L];
    const l0 = P(-1, 0, rp.from), l1 = P(1, 0, rp.from), h1 = P(1, 1, rp.to), h0 = P(-1, 1, rp.to);
    const rise = rp.to - rp.from, slope = Math.hypot(L, rise);
    const n: V3 = [-d[0] * rise / slope, L / slope, -d[2] * rise / slope];
    // order so the face is CCW seen from above
    const quad = cross3(sub3(l1, l0), sub3(h1, l1))[1] > 0 ? [l0, l1, h1, h0] : [l1, l0, h0, h1];
    const sw = (p: V3) => (p[0] * w[0] + p[2] * w[2]) * 0.5;
    pushQuad(out.metal, quad, n, quad.flatMap((p) => [sw(p), (p === h0 || p === h1 ? slope : 0) * 0.5]), [WHITE, WHITE, WHITE, WHITE]);
    for (const side of [-1, 1]) {
      const a = P(side, 0, rp.from), bTop = P(side, 1, rp.to), bBot = P(side, 1, rp.from);
      const sn: V3 = [w[0] * side, 0, w[2] * side];
      const tri = cross3(sub3(bBot, a), sub3(bTop, bBot)).reduce((acc, v, k) => acc + v * sn[k], 0) > 0 ? [a, bBot, bTop] : [a, bTop, bBot];
      pushTri(out.metal, tri, sn, tri.flatMap((p) => [(p[0] * d[0] + p[2] * d[2]) * 0.5, p[1] * 0.5]), WHITE);
    }
  }

  // ── door frames: 2 jambs + header at both faces of each door cell (no jamb between twin door cells) ──
  const df0: FaceOpts = { bucket: 'metal', tint: TINT.door, perFaceUv: false, ao: false, wallBands: false, uvScale: 0.5 };
  for (const df of hints.doorFrames) {
    const alongZ = df.axis === 'z', half = df.width / 2, fy = df.pos.y;
    const twin = (side: number) => hints.doorFrames.some((o) => o !== df && o.axis === df.axis && Math.abs((alongZ ? o.pos.x - df.pos.x : o.pos.z - df.pos.z) - side * df.width) < 0.1 && Math.abs(alongZ ? o.pos.z - df.pos.z : o.pos.x - df.pos.x) < 0.1);
    for (const face of [-1, 1]) {
      const f = face * half, lo = Math.min(f - face * 0.13, f + face * 0.03), hi = Math.max(f - face * 0.13, f + face * 0.03);
      const box = (a0: number, a1: number, y0: number, y1: number): Aabb => alongZ
        ? { min: { x: df.pos.x + a0, y: y0, z: df.pos.z + lo }, max: { x: df.pos.x + a1, y: y1, z: df.pos.z + hi } }
        : { min: { x: df.pos.x + lo, y: y0, z: df.pos.z + a0 }, max: { x: df.pos.x + hi, y: y1, z: df.pos.z + a1 } };
      const parts: Aabb[] = [box(-half, half, fy + df.height - 0.1, fy + df.height + 0.08)];
      if (!twin(-1)) parts.push(box(-half, -half + 0.12, fy, fy + df.height));
      if (!twin(1)) parts.push(box(half - 0.12, half, fy, fy + df.height));
      for (const bb of parts) {
        for (const [nx, nz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) verticalFace(out, bb, nx, nz, df0, map.floorY);
        topFace(out.metal, bb, df0); bottomFace(out.metal, bb, df0);
      }
    }
  }

  // ── site letters (floor decal + wall signs) and lamp panels: unlit atlas (site_marker texture, 2×2 tiles) ──
  const tile = (tx: number, ty: number) => ({ u0: tx * 0.5, u1: tx * 0.5 + 0.5, v0: 1 - (ty + 1) * 0.5, v1: 1 - ty * 0.5 });
  for (const sd of hints.siteDecals) {
    const t = tile(sd.site === 'a' ? 0 : 1, 0), r = sd.rect;
    const cx = (r.x0 + r.x1) / 2, cz = (r.z0 + r.z1) / 2, hs = 1.3, y = r.y + 0.02;
    pushQuad(out.site_marker, [[cx - hs, y, cz + hs], [cx + hs, y, cz + hs], [cx + hs, y, cz - hs], [cx - hs, y, cz - hs]], [0, 1, 0], [t.u0, t.v0, t.u1, t.v0, t.u1, t.v1, t.u0, t.v1], [WHITE, WHITE, WHITE, WHITE]);
  }
  for (const ws of hints.wallSigns) {
    const t = tile(ws.site === 'a' ? 0 : 1, 0);
    const n: V3 = [-Math.sin(ws.yaw), 0, -Math.cos(ws.yaw)];
    const rgt: V3 = [n[2], 0, -n[0]];
    const c: V3 = [ws.pos.x + n[0] * 0.02, ws.pos.y, ws.pos.z + n[2] * 0.02], hs = 0.45;
    const P = (sx: number, sy: number): V3 => [c[0] + rgt[0] * sx * hs, c[1] + sy * hs, c[2] + rgt[2] * sx * hs];
    pushQuad(out.site_marker, [P(-1, -1), P(1, -1), P(1, 1), P(-1, 1)], n, [t.u0, t.v0, t.u1, t.v0, t.u1, t.v1, t.u0, t.v1], [WHITE, WHITE, WHITE, WHITE]);
  }
  const lt = tile(0, 1);
  for (const l of hints.lamps) {
    const hx = 0.3, hz = 0.6, y = l.y;
    pushQuad(out.site_marker, [[l.x - hx, y, l.z - hz], [l.x + hx, y, l.z - hz], [l.x + hx, y, l.z + hz], [l.x - hx, y, l.z + hz]], [0, -1, 0], [lt.u0, lt.v0, lt.u1, lt.v0, lt.u1, lt.v1, lt.u0, lt.v1], [WHITE, WHITE, WHITE, WHITE]);
  }
  return out;
}

function sub3(a: V3, b: V3): V3 { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function cross3(a: V3, b: V3): V3 { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }

function topFace(b: GeoBucket, box: Aabb, o: FaceOpts): void {
  const { min, max } = box, y = max.y, k = o.uvScale;
  const uv = o.perFaceUv ? [0, 0, 1, 0, 1, 1, 0, 1] : [min.x * k, -max.z * k, max.x * k, -max.z * k, max.x * k, -min.z * k, min.x * k, -min.z * k];
  pushQuad(b, [[min.x, y, max.z], [max.x, y, max.z], [max.x, y, min.z], [min.x, y, min.z]], [0, 1, 0], uv, [o.tint, o.tint, o.tint, o.tint]);
}
function bottomFace(b: GeoBucket, box: Aabb, o: FaceOpts): void {
  const { min, max } = box, y = min.y, k = o.uvScale;
  pushQuad(b, [[min.x, y, min.z], [max.x, y, min.z], [max.x, y, max.z], [min.x, y, max.z]], [0, -1, 0], [min.x * k, min.z * k, max.x * k, min.z * k, max.x * k, max.z * k, min.x * k, max.z * k], [o.tint, o.tint, o.tint, o.tint]);
}

/**
 * One vertical face (outward normal (nx, 0, nz)), split horizontally into ≤ 2 m segments (so the floor height
 * outside the face is sampled per segment) and vertically at the AO / base-band / corrugated-band heights.
 */
function verticalFace(out: MapGeometry, box: Aabb, nx: -1 | 0 | 1, nz: -1 | 0 | 1, o: FaceOpts, floorY: (x: number, z: number) => number): void {
  const { min, max } = box;
  const fixed = nx > 0 ? max.x : nx < 0 ? min.x : nz > 0 ? max.z : min.z;
  const r: V3 = [nz, 0, -nx]; // viewer's right
  const h0 = nx !== 0 ? min.z : min.x, h1 = nx !== 0 ? max.z : max.x;
  const point = (h: number, y: number): V3 => (nx !== 0 ? [fixed, y, h] : [h, y, fixed]);
  const n: V3 = [nx, 0, nz];
  const k = o.uvScale;
  const cuts = [h0];
  for (let c = Math.floor(h0 / 2) * 2 + 2; c < h1 - 1e-3; c += 2) cuts.push(c);
  cuts.push(h1);
  for (let si = 0; si + 1 < cuts.length; si++) {
    const a = cuts[si], b = cuts[si + 1], mid = (a + b) / 2;
    const mx = nx !== 0 ? fixed + nx * 0.05 : mid, mz = nx !== 0 ? mid : fixed + nz * 0.05;
    const f = floorY(mx, mz);
    const y0 = Math.max(min.y, Math.min(max.y, f));
    if (max.y - y0 < 1e-3) continue;
    const levels = [y0, max.y];
    if (o.ao) levels.push(y0 + AO.dist);
    if (o.wallBands) { levels.push(y0 + BAND.base); if (BAND.corrugated > y0 + 1e-3) levels.push(BAND.corrugated); }
    const ys = [...new Set(levels.filter((v) => v >= y0 && v <= max.y).map((v) => Math.round(v * 1000) / 1000))].sort((p, q) => p - q);
    // horizontal order along the viewer's right
    const [hl, hr] = (r[0] + r[2]) > 0 ? [a, b] : [b, a];
    for (let li = 0; li + 1 < ys.length; li++) {
      const ya = ys[li], yb = ys[li + 1];
      let bucket = o.bucket, tint = o.tint, uv: number[];
      const ul = (o.perFaceUv ? (hl - h0) / Math.max(1e-6, h1 - h0) : hl * (r[0] + r[2]) * k), ur = (o.perFaceUv ? (hr - h0) / Math.max(1e-6, h1 - h0) : hr * (r[0] + r[2]) * k);
      if (o.wallBands && yb <= y0 + BAND.base + 1e-4) {
        bucket = 'concrete_base';
        const va = (ya - y0) / BAND.base, vb = (yb - y0) / BAND.base;
        uv = [ul, va, ur, va, ur, vb, ul, vb];
      } else if (o.wallBands && ya >= BAND.corrugated - 1e-4) {
        bucket = 'metal'; tint = TINT.corrugated;
        uv = [ul * 4, ya * 0.1, ur * 4, ya * 0.1, ur * 4, yb * 0.1, ul * 4, yb * 0.1];
      } else if (o.perFaceUv) {
        const va = (ya - min.y) / Math.max(1e-6, max.y - min.y), vb = (yb - min.y) / Math.max(1e-6, max.y - min.y);
        uv = [ul, va, ur, va, ur, vb, ul, vb];
      } else uv = [ul, ya * k, ur, ya * k, ur, yb * k, ul, yb * k];
      const ca = o.ao ? mul(tint, aoAt(ya - f)) : tint, cb = o.ao ? mul(tint, aoAt(yb - f)) : tint;
      pushQuad(out[bucket], [point(hl, ya), point(hr, ya), point(hr, yb), point(hl, yb)], n, uv, [ca, ca, cb, cb]);
    }
  }
}

/** Triangle count per bucket (tests, debug). */
export function bucketTriangles(g: MapGeometry): Record<MapBucket, number> {
  const r = {} as Record<MapBucket, number>;
  for (const k of MAP_BUCKETS) r[k] = g[k].idx.length / 3;
  return r;
}
