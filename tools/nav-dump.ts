/**
 * ASCII dump of a compiled map's nav grid (DESIGN.md §6.4) with chokepoints, hold spots, spawns, plant spots and
 * the measured spawn → site path lengths. Run through the esbuild wrapper (the src tree uses extensionless imports,
 * which plain `node --experimental-strip-types` cannot resolve):
 *
 *   node tools/nav-dump.mjs                 Depot, match variant
 *   node tools/nav-dump.mjs --training      Depot, training variant (seals; targets shown as 'x')
 *   node tools/nav-dump.mjs --cover         also print the coverScore grid (0–8, '-' = 0)
 *   node tools/nav-dump.mjs --map box       the 6 × 6 test map
 */
import { compileMap, buildStaticWorld, walkableCount } from '../src/world/compile';
import { buildNavGraph, polylineLength, type NavGraph } from '../src/nav/navgraph';
import { DEPOT } from '../src/maps/depot';
import { BOX } from '../src/maps/box';
import type { Vec3 } from '../src/core/math';
import type { CompiledMap } from '../src/world/types';

export interface DumpOptions { map?: 'depot' | 'box'; training?: boolean; cover?: boolean }

function ruler(cols: number): string[] {
  let tens = '', ones = '';
  for (let x = 0; x < cols; x++) { tens += x % 10 === 0 ? String(Math.floor(x / 10) % 10) : ' '; ones += String(x % 10); }
  return [`     ${tens}`, `     ${ones}`];
}

function pathRow(nav: NavGraph, name: string, from: Vec3, to: Vec3): string {
  const ids = nav.findPath(from, to);
  if (!ids) return `  ${name.padEnd(14)} unreachable`;
  const corners = nav.pullString(ids);
  const start = nav.nodes[ids[0]].pos;
  const grid = polylineLength(ids.map((i) => nav.nodes[i].pos));
  return `  ${name.padEnd(14)} nodes ${String(ids.length).padStart(3)}  node-path ${grid.toFixed(1).padStart(5)} m  pulled ${polylineLength(corners, start).toFixed(1).padStart(5)} m  corners ${corners.length}`;
}

export function navDump(opts: DumpOptions = {}): string {
  const src = opts.map === 'box' ? BOX : DEPOT;
  const map: CompiledMap = compileMap(src, opts.training ? 'training' : 'match');
  const world = buildStaticWorld(map);
  const nav = buildNavGraph(map, world);
  const w = map.walk;
  const lines: string[] = [];
  const kinds: Record<string, number> = {};
  for (const s of map.solids) kinds[s.kind] = (kinds[s.kind] ?? 0) + 1;
  let edges = 0, chokes = 0, nearWall = 0, cover = 0;
  for (const n of nav.nodes) { edges += n.edges.length; if (n.chokepoint) chokes++; if (n.nearWall) nearWall++; if (n.coverScore > 0) cover++; }
  lines.push(`map ${map.id} (${opts.training ? 'training' : 'match'}): ${map.width} × ${map.height} cells, walk grid ${w.cols} × ${w.rows}`);
  lines.push(`solids ${map.solids.length}: ${Object.keys(kinds).sort().map((k) => `${k} ${kinds[k]}`).join(', ')}`);
  lines.push(`walkable sub-cells ${walkableCount(w)}, nav nodes ${nav.nodes.length}, directed edges ${edges}, chokepoint nodes ${chokes}, nearWall ${nearWall}, cover nodes ${cover}`);
  lines.push(`render hints: floorQuads ${map.renderHints.floorQuads.length}, lamps ${map.renderHints.lamps.length}, doorFrames ${map.renderHints.doorFrames.length}, radarWalls ${map.renderHints.radarWalls.length}, wallSigns ${map.renderHints.wallSigns.length}`);
  lines.push('');
  lines.push(`legend: # blocked  . floor  ^ raised  / ramp  ! chokepoint  H hold spot  T/C spawn  A/B plant spot${opts.training ? '  x target  o onboarding' : ''}`);

  // overlay marks (later marks win)
  const mark = new Map<number, string>();
  const put = (p: Vec3, ch: string) => mark.set(w.index(p.x, p.z), ch);
  for (const h of map.holdSpots) { const n = nav.nodes[nav.holdSpot(h.id).node]; mark.set(n.cz * w.cols + n.cx, 'H'); }
  for (const s of map.spawns.T) put(s.pos, 'T');
  for (const s of map.spawns.CT) put(s.pos, 'C');
  put(map.plantSpots.a, 'A'); put(map.plantSpots.b, 'B');
  if (map.training) { for (const t of map.training.targets) put(t, 'x'); put(map.training.onboardingPos, 'o'); }

  lines.push(...ruler(w.cols));
  for (let z = 0; z < w.rows; z++) {
    let row = '';
    for (let x = 0; x < w.cols; x++) {
      const i = z * w.cols + x;
      const m = mark.get(i);
      if (m) { row += m; continue; }
      if (!w.walkable[i]) { row += '#'; continue; }
      const id = nav.nearest({ x: x + 0.5, y: w.floorY[i], z: z + 0.5 });
      const n = nav.nodes[id];
      row += n.chokepoint ? '!' : n.ramp ? '/' : n.pos.y > 0.01 ? '^' : '.';
    }
    lines.push(`  ${String(z).padStart(2)} ${row}`);
  }

  if (opts.cover) {
    lines.push('', 'coverScore (directions with a ≥ 1 m solid within 1.2 m; - = 0):');
    lines.push(...ruler(w.cols));
    for (let z = 0; z < w.rows; z++) {
      let row = '';
      for (let x = 0; x < w.cols; x++) {
        const i = z * w.cols + x;
        if (!w.walkable[i]) { row += '#'; continue; }
        const n = nav.nodes[nav.nearest({ x: x + 0.5, y: w.floorY[i], z: z + 0.5 })];
        row += n.coverScore === 0 ? '-' : String(n.coverScore);
      }
      lines.push(`  ${String(z).padStart(2)} ${row}`);
    }
  }

  lines.push('', 'hold spots (id → node, sub-cell, floor):');
  for (const h of map.holdSpots) {
    const hs = nav.holdSpot(h.id), n = nav.nodes[hs.node];
    lines.push(`  ${h.id.padEnd(18)} node ${String(hs.node).padStart(4)}  (${n.cx}, ${n.cz})  y ${n.pos.y.toFixed(2)}  cover ${n.coverScore}/${n.coverHeight}`);
  }
  lines.push('', 'paths (A* node path vs. string-pulled corners, metres):');
  const T = map.spawns.T[0].pos, C = map.spawns.CT[0].pos, A = map.plantSpots.a, B = map.plantSpots.b;
  lines.push(pathRow(nav, 'T spawn → A', T, A), pathRow(nav, 'T spawn → B', T, B), pathRow(nav, 'CT spawn → A', C, A), pathRow(nav, 'CT spawn → B', C, B), pathRow(nav, 'A → B', A, B), pathRow(nav, 'T → CT spawn', T, C));
  return lines.join('\n');
}

export function main(argv: string[]): void {
  const opts: DumpOptions = { training: argv.includes('--training'), cover: argv.includes('--cover') };
  const mi = argv.indexOf('--map');
  if (mi >= 0 && argv[mi + 1] === 'box') opts.map = 'box';
  console.log(navDump(opts));
}
