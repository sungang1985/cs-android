/**
 * Per-bus shared UI state. Hud, Screens and BuyMenu are constructed separately by app/game.ts with the same
 * injected EventBus<UiEvents>; this WeakMap keyed by that bus instance lets them share the settings working
 * copy, the latest snapshot and the player roster without a global singleton and without new constructor args.
 */
import type { EventBus } from '../core/events';
import type { RenderSnapshot, SnapLocal, Team, EntityId } from '../sim/state';
import type { SimEnvelope } from '../sim/events';
import { DEFAULT_SETTINGS, DEFAULT_LAYOUT, cloneSettings, cloneLayout, type Settings, type TouchLayout } from '../settings/types';
import { persist } from '../platform/persist';
import type { UiEvents, ScreenName, ScreenData } from './dom';
import { nameKeyFor } from './dom';

export interface ScreensPeer {
  show<S extends ScreenName>(s: S, data?: ScreenData[S]): void;
  hide(s: ScreenName): void;
  visible(): ScreenName[];
  feedSnapshot(next: RenderSnapshot): void;
  feedEvent(e: SimEnvelope): void;
}
export interface BuyMenuPeer { readonly isOpen: boolean; update(local: SnapLocal, team?: Team): void }
export interface HudPeer { clearNotice(): void }

export interface RosterEntry { nameKey: string; team: Team }

export interface UiShared {
  /** Settings working copy shared by every UI module; kept in sync with `settingsChanged`. */
  settings: Settings;
  layout: TouchLayout;
  /** Latest snapshot seen by Hud.update (a live, double-buffered reference: read it, never keep it). */
  snapshot: RenderSnapshot | null;
  /** Human id (always 1, §0) and current team (sides swap at the half; cfg.humanTeam is the starting side). */
  localId: EntityId;
  localTeam: Team | null;
  roster: Map<EntityId, RosterEntry>;
  /** MVP of the last roundEnd event (scoreboard). */
  lastMvp: EntityId;
  hud: HudPeer | null; screens: ScreensPeer | null; buyMenu: BuyMenuPeer | null;
}

/** Same merge as main.ts so the UI starts from exactly what the app runs with. */
export function loadSettings(): Settings {
  const stored = persist.get<Partial<Settings>>('settings', {});
  const s = { ...cloneSettings(DEFAULT_SETTINGS), ...stored } as Settings;
  s.controls = { ...DEFAULT_SETTINGS.controls, ...(stored.controls ?? {}) };
  s.volume = { ...DEFAULT_SETTINGS.volume, ...(stored.volume ?? {}) };
  return s;
}
export function loadLayout(): TouchLayout {
  const stored = persist.get<Partial<TouchLayout>>('layout', {});
  const l = cloneLayout(DEFAULT_LAYOUT);
  if (stored.controls) for (const k of Object.keys(l.controls) as (keyof TouchLayout['controls'])[]) { const c = stored.controls[k]; if (c) l.controls[k] = { ...l.controls[k], ...c }; }
  if (typeof stored.scale === 'number') l.scale = stored.scale;
  if (typeof stored.opacity === 'number') l.opacity = stored.opacity;
  if (typeof stored.leftHanded === 'boolean') l.leftHanded = stored.leftHanded;
  return l;
}

const registry = new WeakMap<object, UiShared>();

export function shared(bus: EventBus<UiEvents>): UiShared {
  let s = registry.get(bus);
  if (s) return s;
  const created: UiShared = { settings: loadSettings(), layout: loadLayout(), snapshot: null, localId: 1, localTeam: null, roster: new Map(), lastMvp: 0, hud: null, screens: null, buyMenu: null };
  bus.on('settingsChanged', (v) => { created.settings = cloneSettings(v); });
  bus.on('layoutChanged', (v) => { created.layout = cloneLayout(v); });
  registry.set(bus, created);
  s = created;
  return s;
}

/** Updates roster/local team from a snapshot; allocation-free unless the roster actually changed. */
export function syncRoster(sh: UiShared, next: RenderSnapshot): void {
  sh.snapshot = next;
  sh.localId = next.local.id || 1;
  for (let i = 0; i < next.playerCount; i++) {
    const p = next.players[i];
    const team: Team = p.team === 0 ? 'T' : 'CT';
    const r = sh.roster.get(p.id);
    if (!r || r.nameKey !== p.nameKey || r.team !== team) sh.roster.set(p.id, { nameKey: p.nameKey, team });
    if (p.id === sh.localId) sh.localTeam = team;
  }
}

/** i18n key of a player's display name (bot.player for the human). */
export function playerNameKey(sh: UiShared, id: EntityId, names?: Record<EntityId, string>): { key: string; raw?: string } {
  if (names && names[id]) return { key: '', raw: names[id] };
  if (id === sh.localId) return { key: 'bot.player' };
  const r = sh.roster.get(id);
  if (r) return { key: nameKeyFor(r.nameKey) };
  return { key: '', raw: id > 0 ? `#${id}` : '—' };
}
