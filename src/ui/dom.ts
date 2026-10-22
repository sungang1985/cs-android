/** UI-side shared types (§11.16): UI event bus map, actions, screen data. DOM-side only (never imported by the sim). */
import type { Vec3 } from '../core/math';
import type { Settings, QualityPreset, TouchLayout } from '../settings/types';
import type { Team, WinReason, EntityId, MoneyDelta, RenderSnapshot, PlayerStats, MatchConfig } from '../sim/state';

export type ScreenName = 'main' | 'mode' | 'settings' | 'buy' | 'pause' | 'scoreboard' | 'roundEnd' | 'matchEnd' | 'stats' | 'onboarding' | 'rotate' | 'loading';
export type UiAction = 'play' | 'training' | 'continue' | 'rematch' | 'changeMode' | 'menu' | 'startMatch' | 'resume' | 'quit' | 'skipRound' | 'drop' | 'openBuy' | 'closeBuy' | 'spectatePrev' | 'spectateNext' | 'resetData' | 'applyUpdate' | 'marker' | 'onboardingDone';

export interface LifetimeStats { matches: number; wins: number; draws: number; kills: number; deaths: number; headshots: number; shots: number; hits: number; damage: number; bestStreak: number; byWeapon: Record<string, { kills: number; shots: number; hits: number }>; byAssist: Record<0 | 1 | 2 | 3, number> }

export interface UiEvents {
  settingsChanged: Settings;
  langChanged: 'zh' | 'en';
  qualityChanged: QualityPreset;
  layoutChanged: TouchLayout;
  screen: { name: ScreenName; visible: boolean };
  action: { id: UiAction; payload?: unknown };
}

export interface ScreenData {
  loading: { progress: number; label: string };
  roundEnd: { winner: Team | null; reason: WinReason; mvp: EntityId; deltas: MoneyDelta[]; scoreT: number; scoreCT: number; humanTeam: Team; names: Record<EntityId, string> };
  matchEnd: { result: Team | 'draw'; humanTeam: Team; scoreT: number; scoreCT: number; mvp: EntityId; personal: PlayerStats & { accuracy: number; hsPercent: number }; assistLevel: 0 | 1 | 2 | 3; cfg: MatchConfig };
  scoreboard: { snapshot: RenderSnapshot; humanTeam: Team; mvp: EntityId };
  stats: LifetimeStats;
  settings: undefined; buy: undefined;
  pause: { canBuy: boolean };
  main: { canContinue: boolean; updateAvailable: boolean };
  mode: { last: MatchConfig | null };
  onboarding: { step: 0 | 1 | 2 };
  rotate: undefined;
}

export const MARKER_PAYLOAD = Symbol('marker');
export type MarkerPayload = Vec3 | null;

/** Small DOM helper used by every UI module. */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, children: Array<Node | string> = []): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) { if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v; else e.setAttribute(k, v); }
  for (const c of children) e.append(c);
  return e;
}
