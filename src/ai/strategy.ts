/**
 * Team strategy & blackboard (§6.5, §6.8). planTeam() writes WorldState.teams[team].assignments (one Goal per alive
 * bot), plannedSite and rotateCalledTick. Assignments are a deterministic function of the situation (randomness
 * only at FREEZE start for the T site pick, and for TDM roam points), so the 60-tick re-plans are stable and a bot
 * re-plans only when its objective really changed.
 *
 * Blackboard field use: plannedSite = T target site / CT rotation site (null = none); rotateCalledTick = tick of the
 * first contact (confidence-1 sighting) or rotation call this round, −1 = none; it is also stamped when the
 * post-plant plan is made (so `rotateCalledTick < bomb.plantedTick` means "plant not handled yet").
 */
import { v3, type Vec3 } from '../core/math';
import type { ThinkContext } from '../sim/brain';
import type { Team, Goal, PlayerState, WorldState, Blackboard, Difficulty } from '../sim/state';
import type { WorldHoldSpot, AreaId } from '../world/types';
import { MODES } from '../rules/modes';
import { DIFFICULTY } from './difficulty';
import { pruneBlackboard } from './perception';
import { copyV, distXZ, memOf, teamPlayers, ticks, liveStartTick, liveElapsed, isLive, cloneGoal, player, enemyOf } from './common';

export const STRATEGY = {
  pA: 0.55, flipAfterLoss: 0.3, rushWaitSec: { easy: 10, normal: 4, hard: 0 } as Record<Difficulty, number>,
  pushAfterSec: 45, replanTicks: 60, campRange: [5, 7] as [number, number],
  /** CT rotation on lane sightings: ≥ laneSightEnemies distinct enemies seen (confidence 1) in one site's lanes within laneSightTicks. */
  laneSightEnemies: 2, laneSightTicks: 300,
} as const;

type Site = 'a' | 'b';
const siteArea = (s: Site): AreaId => (s === 'a' ? 'site_a' : 'site_b');
const flip = (s: Site): Site => (s === 'a' ? 'b' : 'a');

function areaCenter(ctx: ThinkContext, id: AreaId): Vec3 | null {
  const a = ctx.map.areas.find((x) => x.id === id);
  if (!a) return null;
  const n = ctx.nav.nodes[ctx.nav.nearest(v3((a.rect.x0 + a.rect.x1) / 2, a.rect.y, (a.rect.z0 + a.rect.z1) / 2))];
  return n ? copyV(n.pos) : null;
}
function spawnCenter(ctx: ThinkContext, team: Team): Vec3 {
  return areaCenter(ctx, team === 'T' ? 't_spawn' : 'ct_spawn') ?? copyV(ctx.map.spawns[team][0].pos);
}
function holdSpot(ctx: ThinkContext, id: string): WorldHoldSpot | undefined { return ctx.map.holdSpots.find((h) => h.id === id); }
/** Hold spots usable by `team` in a role: site a / site b / mid (mid or ct/t spawn areas), forward-first. */
function spotsFor(ctx: ThinkContext, team: Team, role: Site | 'mid'): WorldHoldSpot[] {
  const enemySpawn = spawnCenter(ctx, enemyOf(team));
  return ctx.map.holdSpots.filter((h) => {
    if (h.team !== team && h.team !== 'both') return false;
    if (h.id.startsWith('lurk_')) return false;
    const area = ctx.map.areaAt(h.pos.x, h.pos.z);
    if (role === 'mid') return area === 'mid' || area === 'ct_spawn' || area === 't_spawn';
    return area === siteArea(role);
  }).sort((p, q) => distXZ(p.pos, enemySpawn) - distXZ(q.pos, enemySpawn) || (p.id < q.id ? -1 : 1));
}
const holdGoal = (h: WorldHoldSpot, site?: Site, untilTick?: number): Goal => {
  const g: Goal = { kind: 'hold', pos: copyV(h.pos), holdSpot: h.id };
  if (site) g.site = site;
  if (untilTick !== undefined) g.untilTick = untilTick;
  return g;
};
function siteOf(ctx: ThinkContext, p: Vec3): Site | null { const a = ctx.map.areaAt(p.x, p.z); return a === 'site_a' ? 'a' : a === 'site_b' ? 'b' : null; }
function nearestSite(ctx: ThinkContext, p: Vec3): Site { return distXZ(p, ctx.map.plantSpots.a) <= distXZ(p, ctx.map.plantSpots.b) ? 'a' : 'b'; }
function teamDifficulty(st: WorldState, team: Team): Difficulty {
  for (const m of st.bots) { const p = player(st, m.id); if (p && p.team === team) return m.profile.difficulty; }
  return st.cfg.difficulty;
}
export function isFreezeStart(st: WorldState): boolean {
  return st.round.phase === 'FREEZE' && st.round.phaseEndsTick - st.tick === ticks(MODES[st.cfg.mode].freezeSec);
}

interface TeamInfo { team: Team; bb: Blackboard; members: PlayerState[]; bots: PlayerState[]; carrier: number; lurker: number; retriever: number; defuser: number; camper: number; contact: boolean }

function teamInfo(team: Team, ctx: ThinkContext): TeamInfo {
  const st = ctx.state, bb = st.teams[team], bomb = st.bomb;
  const members = teamPlayers(st, team);
  const bots = members.filter((p) => p.isBot && p.alive && memOf(st, p.id));
  const info: TeamInfo = { team, bb, members, bots, carrier: 0, lurker: 0, retriever: 0, defuser: 0, camper: 0, contact: bb.rotateCalledTick >= 0 };
  const nearestBot = (pos: Vec3, pref?: (p: PlayerState) => boolean): number => {
    let best = 0, bd = Infinity;
    for (const pass of pref ? [true, false] : [false]) {
      for (const p of bots) { if (pass && pref && !pref(p)) continue; const d = distXZ(p.pos, pos); if (d < bd) { bd = d; best = p.id; } }
      if (best) break;
    }
    return best;
  };
  if (team === 'T') {
    if (bomb.state === 'carried') info.carrier = bomb.carrier;
    if (bomb.state === 'dropped') info.retriever = nearestBot(bomb.pos);
    const aliveT = members.filter((p) => p.alive).length;
    if (aliveT >= 2 && (bomb.state === 'planted' || !info.contact)) {
      let best: PlayerState | null = null;
      for (const p of bots) {
        if (p.id === info.carrier || p.id === info.retriever) continue;
        const a = memOf(st, p.id)!.profile.aggression;
        if (!best || a > memOf(st, best.id)!.profile.aggression) best = p;
      }
      info.lurker = best ? best.id : 0;
    }
  } else {
    if (bomb.state === 'planted') info.defuser = nearestBot(bb.bombPos ?? bomb.pos, (p) => p.hasKit);
    if (bomb.state === 'dropped' && bb.bombPos && teamDifficulty(st, 'CT') === 'hard') info.camper = nearestBot(bb.bombPos);
  }
  return info;
}

/**
 * T lanes (§3.1): the main group enters the direct lane of the site through its door (Long door → A, Tunnel door → B)
 * and A* takes it from there; the lurker takes Mid and holds lurk_<site>_connector. Falls back to the lane area centre.
 */
function laneWaypoint(ctx: ThinkContext, site: Site): Vec3 | null {
  const door = ctx.map.chokes.find((c) => c.id === (site === 'a' ? 'long_door' : 'tunnel_door'));
  if (door) { const n = ctx.nav.nodes[ctx.nav.nearest(door.pos)]; if (n) return copyV(n.pos); }
  return areaCenter(ctx, site === 'a' ? 'long' : 'tunnel');
}

function rushUntil(st: WorldState, p: PlayerState): number | undefined {
  const s = liveStartTick(st);
  const m = memOf(st, p.id);
  if (s === null || !m) return undefined;
  return s + ticks(STRATEGY.rushWaitSec[m.profile.difficulty]);
}

function goalFor(info: TeamInfo, p: PlayerState, ctx: ThinkContext): Goal {
  const st = ctx.state, bomb = st.bomb, bb = info.bb, map = ctx.map;
  if (st.cfg.mode === 'tdm' || st.cfg.mode === 'training') {
    const a = bb.assignments[p.id];
    if (a && distXZ(p.pos, a.pos) > 2) return a;
    return roamGoal(ctx, p);
  }
  const bots = info.bots, idx = bots.indexOf(p);
  if (info.team === 'T') {
    if (bomb.state === 'planted') {
      const site = bomb.site ?? nearestSite(ctx, bomb.pos);
      if (p.id === info.lurker) { const l = holdSpot(ctx, `lurk_${site}_connector`); if (l) return holdGoal(l, site); }
      const others = bots.filter((b) => b.id !== info.lurker);
      const spots = spotsFor(ctx, 'T', site);
      const k = others.indexOf(p);
      if (k >= 0 && k < spots.length) return holdGoal(spots[k], site);
      return { kind: 'site', site, pos: copyV(bomb.pos) };
    }
    if (p.id === info.retriever) return { kind: 'bomb', pos: copyV(bomb.pos) };
    const site: Site = bb.plannedSite ?? 'a';
    const until = rushUntil(st, p);
    const withUntil = (g: Goal): Goal => { if (until !== undefined) g.untilTick = until; return g; };
    if (p.id === info.lurker) { const l = holdSpot(ctx, `lurk_${site}_connector`); if (l) return holdGoal(l, site, until); }
    const plant = map.plantSpots[site];
    const wp = laneWaypoint(ctx, site);
    if (wp && distXZ(p.pos, plant) > distXZ(wp, plant) + 1) return withUntil({ kind: 'site', site, pos: wp });
    if (p.id === info.carrier) return withUntil({ kind: 'site', site, pos: copyV(plant) });
    const attackers = bots.filter((b) => b.id !== info.carrier && b.id !== info.lurker);
    const spots = spotsFor(ctx, 'T', site);
    const k = attackers.indexOf(p);
    if (k >= 0 && k < spots.length) { const g = holdGoal(spots[k], site, until); g.kind = 'site'; return g; }
    return withUntil({ kind: 'site', site, pos: copyV(plant) });
  }
  // CT
  if (bomb.state === 'planted') {
    const bombPos = bb.bombPos ?? bomb.pos;
    const site = bomb.site ?? nearestSite(ctx, bombPos);
    if (p.id === info.defuser) return { kind: 'bomb', site, pos: copyV(bombPos) };
    const spots = spotsFor(ctx, 'CT', site);
    const others = bots.filter((b) => b.id !== info.defuser);
    if (spots.length) return holdGoal(spots[others.indexOf(p) % spots.length], site);
    return { kind: 'site', site, pos: copyV(bombPos) };
  }
  if (p.id === info.camper && bb.bombPos) { const c = campNode(ctx, bb.bombPos, p.pos); if (c) return { kind: 'hold', pos: c }; }
  if (bb.plannedSite) {
    const spots = spotsFor(ctx, 'CT', bb.plannedSite);
    if (spots.length) return holdGoal(spots[Math.max(0, idx) % spots.length], bb.plannedSite);
    return { kind: 'site', site: bb.plannedSite, pos: copyV(map.plantSpots[bb.plannedSite]) };
  }
  const push = st.round.phase === 'SUDDEN_DEATH' || (st.round.phase === 'LIVE' && !info.contact && liveElapsed(st) >= ticks(STRATEGY.pushAfterSec));
  if (push) {
    const mid = areaCenter(ctx, 'mid'), tSpawn = spawnCenter(ctx, 'T');
    if (mid && distXZ(p.pos, tSpawn) > distXZ(mid, tSpawn) + 2) return { kind: 'roam', pos: mid };
    return { kind: 'roam', pos: tSpawn };
  }
  return defaultCtGoal(ctx, info, p);
}

/** CT default split (§6.5): 2 A / 2 B / 1 mid (3v3 1/1/1, 2v2 1/1) by team slot (id order incl. the human). */
function defaultRole(info: TeamInfo, q: PlayerState): Site | 'mid' {
  const n = info.members.length;
  const roles: (Site | 'mid')[] = n >= 5 ? ['a', 'a', 'b', 'b', 'mid'] : n === 4 ? ['a', 'b', 'a', 'mid'] : n === 3 ? ['a', 'b', 'mid'] : ['a', 'b'];
  return roles[info.members.indexOf(q) % roles.length];
}
function defaultCtGoal(ctx: ThinkContext, info: TeamInfo, p: PlayerState): Goal {
  const roleOf = (q: PlayerState) => defaultRole(info, q);
  const role = roleOf(p);
  const spots = spotsFor(ctx, 'CT', role);
  if (!spots.length) { const s: Site = role === 'b' ? 'b' : 'a'; return { kind: 'site', site: s, pos: copyV(ctx.map.plantSpots[s]) }; }
  const used: number[] = [];
  for (const q of info.bots) {
    if (roleOf(q) !== role) continue;
    const pref = memOf(ctx.state, q.id)?.profile.holdPreference ?? 0.5;
    let i = Math.min(spots.length - 1, Math.floor(pref * Math.min(spots.length, 2)));
    for (let k = 0; k < spots.length && used.includes(i); k++) i = (i + 1) % spots.length;
    used.push(i);
    if (q.id === p.id) return holdGoal(spots[i], role === 'mid' ? undefined : role);
  }
  return holdGoal(spots[0], role === 'mid' ? undefined : role);
}

/** Hard CTs camp a dropped bomb from a cover node 5–7 m away with LOS to it, nearest to the camper. */
function campNode(ctx: ThinkContext, bomb: Vec3, from: Vec3): Vec3 | null {
  let best: Vec3 | null = null, bd = Infinity;
  const target = v3(bomb.x, bomb.y + 0.2, bomb.z);
  for (const n of ctx.nav.nodes) {
    if (n.coverScore < 2) continue;
    const d = distXZ(n.pos, bomb);
    if (d < STRATEGY.campRange[0] || d > STRATEGY.campRange[1]) continue;
    const dd = distXZ(n.pos, from);
    if (dd >= bd) continue;
    if (!ctx.world.lineOfSight(v3(n.pos.x, n.pos.y + 1.65, n.pos.z), target)) continue;
    best = copyV(n.pos); bd = dd;
  }
  return best;
}

/** TDM roam: a random node in a random non-own-spawn area (stream `ai`). */
function roamGoal(ctx: ThinkContext, p: PlayerState): Goal {
  const own: AreaId = p.team === 'T' ? 't_spawn' : 'ct_spawn';
  const areas = ctx.map.areas.filter((a) => a.id !== own && (a.rect.x1 - a.rect.x0) * (a.rect.z1 - a.rect.z0) >= 16);
  const area = areas.length ? areas[ctx.rng.int(0, areas.length - 1)].id : own;
  return { kind: 'roam', pos: copyV(ctx.nav.randomNodeInArea(area, ctx.rng).pos) };
}

/** Round init at FREEZE start: T site pick (A 55 % / B 45 %; after a lost round keep the site, flip with 30 %). */
function roundInit(team: Team, ctx: ThinkContext): void {
  const bb = ctx.state.teams[team];
  bb.bombPos = null; bb.rotateCalledTick = -1; bb.assignments = {};
  if (team === 'T' && ctx.state.cfg.mode === 'defusal') {
    const prev = bb.plannedSite;
    bb.plannedSite = prev === null ? (ctx.rng.chance(STRATEGY.pA) ? 'a' : 'b') : ctx.rng.chance(STRATEGY.flipAfterLoss) ? flip(prev) : prev;
  } else bb.plannedSite = null;
}

export function planTeam(team: Team, ctx: ThinkContext): void {
  const st = ctx.state, bb = st.teams[team];
  if (isFreezeStart(st)) roundInit(team, ctx);
  if (team === 'T' && st.cfg.mode === 'defusal' && bb.plannedSite === null) bb.plannedSite = 'a';
  if (st.bomb.state === 'planted') {
    if (bb.rotateCalledTick < st.bomb.plantedTick) bb.rotateCalledTick = ctx.tick;
    if (!bb.bombPos) bb.bombPos = copyV(st.bomb.pos);
    if (st.bomb.site) bb.plannedSite = st.bomb.site;
  }
  const info = teamInfo(team, ctx);
  for (const p of info.bots) bb.assignments[p.id] = goalFor(info, p, ctx);
}

/** PLAN state (§6.2): the bot's current goal from the team strategy (recomputed for this bot so staged goals advance). */
export function requestGoal(ctx: ThinkContext, self: PlayerState): Goal {
  const bb = ctx.state.teams[self.team];
  const g = goalFor(teamInfo(self.team, ctx), self, ctx);
  bb.assignments[self.id] = g;
  return cloneGoal(g);
}

/** Lanes that lead to one site only (§3.1): Long / A ramp / A connector → A, Tunnel / B door / B connector → B. Mid is ambiguous. */
const LANE_SITE: Partial<Record<AreaId, Site>> = { long: 'a', a_ramp: 'a', a_ramp_ct: 'a', a_connector: 'a', tunnel: 'b', tunnel_window: 'b', b_door_ct: 'b', b_connector: 'b' };

/**
 * CT rotation trigger (§6.5, as built): the most recent confidence-1 sighting inside a site area, or ≥ laneSightEnemies
 * distinct enemies seen (confidence 1, within laneSightTicks) in the lanes that only lead to that site — so a stacked
 * execute is called while it is still in Long/Tunnel instead of when the holders are already dying.
 */
function sightedSite(ctx: ThinkContext, bb: Blackboard): Site | null {
  let best: Site | null = null, bt = -1;
  const laneIds: Record<Site, number[]> = { a: [], b: [] }, laneTick: Record<Site, number> = { a: -1, b: -1 };
  for (const e of bb.lastEnemySeen) {
    if (e.confidence !== 1) continue;
    const s = siteOf(ctx, e.pos);
    if (s) { if (e.tick > bt) { best = s; bt = e.tick; } continue; }
    if (ctx.tick - e.tick > STRATEGY.laneSightTicks) continue;
    const area = ctx.map.areaAt(e.pos.x, e.pos.z);
    const lane = area ? LANE_SITE[area] : undefined;
    if (!lane) continue;
    if (!laneIds[lane].includes(e.id)) laneIds[lane].push(e.id);
    if (e.tick > laneTick[lane]) laneTick[lane] = e.tick;
  }
  for (const s of ['a', 'b'] as const) if (laneIds[s].length >= STRATEGY.laneSightEnemies && laneTick[s] > bt) { best = s; bt = laneTick[s]; }
  return best;
}

/**
 * teamThink body (§6.2/§6.5): cheap trigger checks every tick, planTeam() on FREEZE start, plant, carrier death,
 * first contact / rotation calls, bomb pickup, and every 60 ticks.
 */
export function teamTick(team: Team, ctx: ThinkContext): void {
  const st = ctx.state, r = st.round, bb = st.teams[team], tick = ctx.tick, bomb = st.bomb;
  if (tick % 6 === 0) pruneBlackboard(bb, tick, st);
  if (r.phase === 'ROUND_END') { if (team === 'T' && r.winner !== 'CT') bb.plannedSite = null; return; }
  if (r.phase === 'WARMUP' || r.phase === 'MATCH_END') return;
  if (!st.bots.some((m) => player(st, m.id)?.team === team)) return;
  if (isFreezeStart(st)) { planTeam(team, ctx); return; }
  let replan = tick % STRATEGY.replanTicks === (team === 'T' ? 0 : STRATEGY.replanTicks / 2);
  if (st.cfg.mode !== 'defusal') { if (replan) planTeam(team, ctx); return; }
  if (isLive(st) && bb.rotateCalledTick < 0 && bb.lastEnemySeen.some((e) => e.confidence === 1)) { bb.rotateCalledTick = tick; replan = true; }
  if (team === 'CT' && isLive(st) && bomb.state !== 'planted' && DIFFICULTY[teamDifficulty(st, 'CT')].rotates) {
    const s = sightedSite(ctx, bb);
    if (s && bb.plannedSite !== s) { bb.plannedSite = s; replan = true; }
  }
  if (bomb.state === 'planted' && bb.rotateCalledTick < bomb.plantedTick) replan = true;
  if (team === 'T' && bomb.state === 'dropped' && !Object.values(bb.assignments).some((g) => g.kind === 'bomb')) replan = true;
  if (team === 'T' && bomb.state === 'carried' && memOf(st, bomb.carrier) && bb.assignments[bomb.carrier]?.kind === 'bomb') replan = true;
  if (replan) planTeam(team, ctx);
}
