/** Shared jsdom fixtures for the UI tests (not a test file itself). */
import { EventBus } from '@/core/events';
import { createSnapshot, type RenderSnapshot, type SnapLocal } from '@/sim/state';
import { registerDictionary, setLocale } from '@/i18n/i18n';
import { zh } from '@/i18n/zh';
import { en } from '@/i18n/en';
import { zhUi } from '@/i18n/zh.ui';
import { enUi } from '@/i18n/en.ui';
import { setStorageForTests } from '@/platform/persist';
import type { UiEvents, UiAction } from '@/ui/dom';

export function memoryStorage(): { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void; data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); }, removeItem: (k) => { data.delete(k); } };
}

/** Fresh DOM root, i18n (zh), in-memory storage and a bus that records every emit. */
export function setup(): { root: HTMLElement; bus: EventBus<UiEvents>; storage: ReturnType<typeof memoryStorage>; actions: Array<{ id: UiAction; payload?: unknown }>; emitted: Array<{ type: keyof UiEvents; data: unknown }> } {
  registerDictionary('zh', zh); registerDictionary('en', en);
  registerDictionary('zh', zhUi); registerDictionary('en', enUi);
  setLocale('zh');
  const storage = memoryStorage();
  setStorageForTests(storage);
  document.body.innerHTML = '<div id="ui"></div>';
  const root = document.getElementById('ui')!;
  const bus = new EventBus<UiEvents>();
  const actions: Array<{ id: UiAction; payload?: unknown }> = [];
  const emitted: Array<{ type: keyof UiEvents; data: unknown }> = [];
  bus.onAny((e) => { emitted.push({ type: e.type, data: e.data }); if (e.type === 'action') actions.push(e.data as { id: UiAction; payload?: unknown }); });
  return { root, bus, storage, actions, emitted };
}

export function localWith(over: Partial<SnapLocal> = {}): SnapLocal {
  const l = createSnapshot().local;
  Object.assign(l, { id: 1, alive: 1, hp: 100, money: 800, weapon: 1, mag: 20, reserve: 120, primary: -1, pistol: 1, activeSlot: 2, canBuy: 1, buyWindowRemaining: 12 }, over);
  return l;
}

/** A 3v3 snapshot: human (id 1, T) + bots 2–3 (T) + 4–6 (CT). */
export function snapshotWith(local: Partial<SnapLocal> = {}, team: 0 | 1 = 0): RenderSnapshot {
  const s = createSnapshot();
  const names = ['player', 'bot.wang', 'bot.qiang', 'bot.lei', 'bot.fang', 'bot.hu'];
  s.playerCount = 6;
  for (let i = 0; i < 6; i++) {
    const p = s.players[i];
    p.id = i + 1; p.nameKey = names[i]; p.team = (i < 3 ? team : 1 - team) as 0 | 1; p.alive = 1; p.hp = 100; p.kills = i; p.deaths = 0; p.money = i < 3 ? 800 : -1;
  }
  s.round.phase = 1; s.round.remaining = 4.2; s.round.roundNumber = 1; s.round.aliveT = 3; s.round.aliveCT = 3;
  Object.assign(s.local, localWith(local));
  return s;
}

export const $ = (root: ParentNode, id: string): HTMLElement | null => root.querySelector<HTMLElement>(`[data-testid="${id}"]`);
export function click(root: ParentNode, id: string): void {
  const el = $(root, id);
  if (!el) throw new Error(`no [data-testid="${id}"]`);
  el.click();
}
