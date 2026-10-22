/** Recoil patterns (degrees; pitch up positive, yaw right positive), DESIGN.md §4.3 (already scaled to 60 %). */
export type Pattern = [pitch: number, yaw: number][];

function alt(n: number, a: number): number[] { return Array.from({ length: n }, (_, i) => (i % 2 === 0 ? a : -a)); }
function rep(n: number, v: number): number[] { return Array.from({ length: n }, () => v); }
function zip(p: number[], y: number[]): Pattern { return p.map((pv, i) => [pv, y[i] ?? 0]); }

export const P_AK: Pattern = zip(
  [0.4, 0.9, 1.3, 1.6, 1.8, 1.9, 2.0, 2.0, 2.1, 2.1, 2.0, 2.0, 2.0, 2.0, 2.0, 1.9, 1.9, 1.9, 1.9, 1.9, ...rep(10, 1.8)],
  [0, 0.05, -0.1, -0.2, -0.3, -0.6, -0.8, -1.0, -1.1, -1.2, -1.0, -0.5, 0, 0.4, 0.8, 1.0, 0.9, 0.7, 0.5, 0.4, ...alt(10, 0.6)],
);
export const P_M4: Pattern = zip(
  [0.3, 0.7, 1.0, 1.3, 1.5, ...rep(10, 1.6), ...rep(5, 1.5), ...rep(10, 1.4)],
  [0, 0.05, 0.1, 0.15, 0.2, 0.4, 0.55, 0.7, 0.8, 0.9, 0.8, 0.5, 0.2, -0.2, -0.6, -0.8, -0.7, -0.5, -0.3, -0.2, ...alt(10, 0.4)],
);
export const P_SMG: Pattern = zip([0.2, 0.4, 0.6, 0.8, 0.9, ...rep(25, 1.0)], [0, 0, 0.1, 0.1, -0.1, ...alt(25, 0.3)]);
export const P_PISTOL: Pattern = [[1.2, 0]];
export const P_DEAGLE: Pattern = [[3.0, 0.3], [3.0, -0.3]];
export const P_AWP: Pattern = [[6.0, 0]];
export const P_NONE: Pattern = [[0, 0]];
