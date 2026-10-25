/** TestHooks (§11.16): merged into globalThis.__cs with ?test=1. Synchronous batch stepping for e2e. */
import { v3 } from '../core/math';
import type { Game } from './game';
import type { MatchConfig, InputCommand, EntityId, ItemId, WorldState, RenderSnapshot, RoundPhase } from '../sim/state';
import type { SimEvents } from '../sim/events';
import { giveWeapon } from '../weapons/inventory';
import { findPlayer } from '../sim/entities';

export interface TestHooks {
  startMatch(cfg: Partial<MatchConfig>): void;
  stepTicks(n: number): void;
  resume(): void; freezeBots(b: boolean): void;
  teleport(id: EntityId, x: number, y: number, z: number, yaw?: number): void;
  give(item: ItemId, id?: EntityId): void; setMoney(id: EntityId, m: number): void;
  setInput(partial: Partial<InputCommand>, ticks?: number): void;
  state(): WorldState; snapshot(): RenderSnapshot; hash(): number;
  /** Stop/resume all drawing (DOM-only screenshots under software WebGL). */
  setRendering(on: boolean): void;
  eventCount(kind: keyof SimEvents): number; events(kind: keyof SimEvents, last?: number): unknown[]; phase(): RoundPhase;
}

export function makeTestHooks(game: Game): TestHooks {
  const counts = new Map<string, number>();
  const recent = new Map<string, unknown[]>();
  game.onEvent((e) => { counts.set(e.type as string, (counts.get(e.type as string) ?? 0) + 1); const arr = recent.get(e.type as string) ?? []; arr.push(e.data); if (arr.length > 200) arr.shift(); recent.set(e.type as string, arr); });
  const sim = () => { const s = game.sim; if (!s) throw new Error('no match running'); return s; };
  return {
    startMatch(cfg) { counts.clear(); recent.clear(); game.startMatchFromPartial(cfg); },
    stepTicks(n) { game.loop.pause(true); for (let i = 0; i < n; i++) game.tickOnce(); },
    resume() { game.loop.pause(false); },
    freezeBots(b) { sim().freezeBots(b); },
    teleport(id, x, y, z, yaw) { const p = findPlayer(sim().state, id); if (!p) return; p.pos = v3(x, y, z); p.prevPos = v3(x, y, z); p.vel = v3(); if (yaw !== undefined) { p.yaw = yaw; if (id === sim().state.humanId) game.input.setLook(yaw, 0); } },
    give(item, id) {
      const s = sim().state; const p = findPlayer(s, id ?? s.humanId); if (!p) return;
      if (item === 'kevlar') p.armor = 100; else if (item === 'kevlar_helmet') { p.armor = 100; p.helmet = true; } else if (item === 'defuse_kit') p.hasKit = true;
      else if (item === 'c4') { p.hasBomb = true; s.bomb.state = 'carried'; s.bomb.carrier = p.id; }
      else { giveWeapon(p, item); const slot = item === 'he' || item === 'flash' ? 4 : item === 'knife' ? 3 : (['glock', 'usp', 'deagle'].includes(item) ? 2 : 1); p.inv.active = slot as 1 | 2 | 3 | 4; }
    },
    setMoney(id, m) { const p = findPlayer(sim().state, id); if (p) p.money = m; },
    setInput(partial, ticks = 1) { game.overrideInput(partial, ticks); },
    state() { return sim().state; },
    snapshot() { return game.next; },
    hash() { return sim().hash(); },
    setRendering(on) { game.renderer.setDrawingEnabled(on); },
    eventCount(kind) { return counts.get(kind) ?? 0; },
    events(kind, last = 20) { return (recent.get(kind) ?? []).slice(-last); },
    phase() { return sim().state.round.phase; },
  };
}
