/**
 * World types shared by the compiler, nav, weapons, renderer and app (DESIGN.md §3.5, §11.16).
 * Re-exports the collision primitives so adapters import from here.
 */
import type { Aabb, Vec3 } from '../core/math';
import type { Team, SurfaceId } from '../sim/state';
import type { SurfaceId as CollisionSurfaceId } from './collision';

export type { Solid, RayHit, MoveResult, BodyShape } from './collision';
export type { CollisionSurfaceId };

export type Glyph = '#' | '.' | '^' | '+' | 'X' | 'c' | '~' | 'L' | '=' | 'A' | 'B' | 'T' | 'C';
export type Cell = [cx: number, cz: number];
/** Inclusive cell rectangle. */
export type CellRect = [x0: number, z0: number, x1: number, z1: number];
export type MaterialId = 'concrete' | 'concrete_base' | 'floor' | 'floor_stripe' | 'crate_wood' | 'sandbag' | 'metal' | 'door_frame' | 'ceiling' | 'lamp' | 'site_marker' | 'skin_t' | 'skin_ct' | 'gun_metal' | 'wood_stock';
export type AreaId = 't_spawn' | 't_north' | 't_south' | 'long' | 'mid' | 'tunnel' | 'ct_spawn' | 'site_a' | 'site_b' | 'a_ramp' | 'a_ramp_ct' | 'mid_window' | 'tunnel_window' | 'a_connector' | 'b_connector' | 'b_door_ct';
export type SolidKind = 'wall' | 'tallcrate' | 'lowcrate' | 'sandbag' | 'lip' | 'ramp-step' | 'platform' | 'lintel' | 'ceiling' | 'seal';

/**
 * One prop glyph's geometry. `inset` shrinks the box on all four sides inside its 2 m cell (`c`: 0.5 → a 1 m cube);
 * the box sits on the cell's local floor. `kind` is the SolidKind the compiler emits (defaults: X tallcrate,
 * c lowcrate, ~ sandbag, L lip). LOS is purely geometric; `blocksLos` is a readability hint only.
 */
export interface PropDef { height: number; inset: number; material: MaterialId; surface: CollisionSurfaceId; penetrable: boolean; penetrationFactor: number; kind?: SolidKind; blocksLos: 'full' | 'low' }

export interface MapSource {
  id: string; name: { zh: string; en: string };
  cellSize: 2; width: number; height: number;
  /** height strings × width glyphs */
  grid: string[];
  wallHeight: number; ceilingY: number; lintelY: number;
  props: Record<'X' | 'c' | '~' | 'L', PropDef>;
  platforms: { rect: CellRect; y: number; material: MaterialId; surface: CollisionSurfaceId }[];
  ramps: { cell: Cell; ascend: 'n' | 's' | 'e' | 'w'; from: number; to: number; steps: 4 }[];
  areas: { id: AreaId; rect: CellRect }[];
  sites: { a: CellRect; b: CellRect };
  plantSpots: { a: Cell; b: Cell };
  /** index 0 = human slot */
  spawns: { T: { cell: Cell; yawDeg: number }[]; CT: { cell: Cell; yawDeg: number }[] };
  holdSpots: { id: string; cell: Cell; yawDeg: number; team: Team | 'both'; crouch: boolean }[];
  chokes: { id: string; cell: Cell }[];
  materials: { wall: MaterialId; wallBase: MaterialId; floor: MaterialId; site: MaterialId; ceiling: MaterialId; door: MaterialId };
  training?: { sealed: CellRect[]; targets: Cell[]; onboardingCell: Cell };
}

export interface SolidDef { box: Aabb; surface: CollisionSurfaceId; penetrable: boolean; penetrationFactor: number; kind: SolidKind; material: MaterialId | null; tag?: string }
/** Metres, inclusive of the cell edges. */
export interface WorldRect { x0: number; z0: number; x1: number; z1: number; y: number }
export interface WorldArea { id: AreaId; rect: WorldRect }
export interface WorldSpawn { pos: Vec3; yaw: number }
export interface WorldHoldSpot { id: string; pos: Vec3; yaw: number; team: Team | 'both'; crouch: boolean }

/**
 * 1 m walk grid (§3.5 step 3). Sub-cell (sx, sz) has index `sz * cols + sx` and centre (originX + sx + 0.5, originZ + sz + 0.5).
 */
export interface WalkGrid {
  cell: 1; cols: number; rows: number;
  /** 1 = a standing body (0.6 × 1.8 × 0.6) centred on the sub-cell at its floor overlaps no solid except ramp steps */
  walkable: Uint8Array;
  /** 1 = sub-cell lies on a ramp (`=` cell); edges along the ramp's ascend axis are always created (§6.4) */
  ramp: Uint8Array;
  /** ramp sub-cells only: the ascend axis, 1 = x (ramp ascends 'e'/'w'), 2 = z ('n'/'s'); 0 elsewhere */
  rampAxis: Uint8Array;
  /** local floor height; ramp sub-cells store the wedge height at their centre (0.375 / 1.125 m on Depot) */
  floorY: Float32Array;
  /** world (x, z) → array index (clamped to the grid) */
  index(x: number, z: number): number;
  originX: number; originZ: number;
}

export interface RenderHints {
  /** same index as CompiledMap.solids */
  solids: { material: MaterialId | null; kind: SolidKind; uvScale: 0.5 }[];
  /** floor-0 quads (greedy rectangles over every non-wall cell outside platforms, no overlaps) + one top per platform */
  floorQuads: { rect: WorldRect; material: MaterialId }[];
  ramps: { origin: Vec3; ascend: 'n' | 's' | 'e' | 'w'; from: number; to: number; width: 2; length: 2; material: MaterialId }[];
  /** pos = door cell centre at its floor; axis = the walk-through direction ('x': the door is in a north–south wall, frame spans z) */
  doorFrames: { pos: Vec3; axis: 'x' | 'z'; width: 2; height: 2.6; material: MaterialId }[];
  /** one per 4 × 4 m block that contains floor (centroid of the block's open cells), y = ceilingY − 0.1 */
  lamps: Vec3[];
  siteDecals: { site: 'a' | 'b'; rect: WorldRect }[];
  wallSigns: { site: 'a' | 'b'; pos: Vec3; yaw: number }[];
  /** top-down outline segments (merged, axis-aligned) of kind wall/lip/tallcrate; seals excluded */
  radarWalls: { x0: number; z0: number; x1: number; z1: number }[];
  bounds: Aabb; ceilingY: number;
}

export interface CompiledMap {
  id: string; cellSize: number; width: number; height: number; bounds: Aabb;
  /** index == StaticWorld solid id */
  solids: SolidDef[];
  floorY(x: number, z: number): number;
  walk: WalkGrid;
  areas: WorldArea[];
  areaAt(x: number, z: number): AreaId | null;
  sites: { a: WorldRect; b: WorldRect };
  plantSpots: { a: Vec3; b: Vec3 };
  spawns: { T: WorldSpawn[]; CT: WorldSpawn[] };
  holdSpots: WorldHoldSpot[];
  chokes: { id: string; pos: Vec3 }[];
  renderHints: RenderHints;
  training?: { sealed: Aabb[]; targets: Vec3[]; onboardingPos: Vec3 };
}

/** 8-value collision surface → 4-value sim surface (footsteps, impacts). */
export function toSimSurface(s: CollisionSurfaceId): SurfaceId {
  switch (s) {
    case 'wood': return 'wood';
    case 'metal': case 'glass': return 'metal';
    case 'sand': return 'sand';
    default: return 'concrete';
  }
}

export function rectContains(r: WorldRect, x: number, z: number): boolean { return x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1; }
