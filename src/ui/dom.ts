/** UI-side shared types (§11.16): UI event bus map, actions, screen data. DOM-side only (never imported by the sim). */
import type { Vec3 } from '../core/math';
import type { Settings, QualityPreset, TouchLayout } from '../settings/types';
import type { Team, WinReason, EntityId, MoneyDelta, RenderSnapshot, PlayerStats, MatchConfig } from '../sim/state';
import { t } from '../i18n/i18n';

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

// ───────── L8 additions (new exports; the frozen types above are unchanged) ─────────

/** i18n params; a string value starting with '@' is itself a key, translated at fill time (so it re-localises). */
export type I18nParams = Record<string, string | number>;

export function tr(key: string, params?: I18nParams): string {
  if (!params) return t(key);
  const p: Record<string, string | number> = {};
  for (const k of Object.keys(params)) { const v = params[k]; p[k] = typeof v === 'string' && v.charCodeAt(0) === 64 /* @ */ ? t(v.slice(1)) : v; }
  return t(key, p);
}

/** Binds a leaf node's text to an i18n key (`data-i18n`) so refillI18n() re-translates it after a locale change. */
export function tx<N extends HTMLElement>(node: N, key: string, params?: I18nParams): N {
  node.dataset.i18n = key;
  if (params) node.dataset.i18nParams = JSON.stringify(params); else delete node.dataset.i18nParams;
  node.textContent = tr(key, params);
  return node;
}

/** Element whose text is the i18n key `key`. */
export function elt<K extends keyof HTMLElementTagNameMap>(tag: K, key: string, attrs: Record<string, string> = {}, params?: I18nParams): HTMLElementTagNameMap[K] {
  return tx(el(tag, attrs), key, params);
}

/** Re-fills every `data-i18n` node (and `data-i18n-label` aria label) under root with the current locale. */
export function refillI18n(root: ParentNode): void {
  for (const n of root.querySelectorAll<HTMLElement>('[data-i18n]')) {
    let params: I18nParams | undefined;
    if (n.dataset.i18nParams) { try { params = JSON.parse(n.dataset.i18nParams) as I18nParams; } catch { params = undefined; } }
    const s = tr(n.dataset.i18n ?? '', params);
    if (n.textContent !== s) n.textContent = s;
  }
  for (const n of root.querySelectorAll<HTMLElement>('[data-i18n-label]')) n.setAttribute('aria-label', t(n.dataset.i18nLabel ?? ''));
}

/** `4,250` (locale-independent digits, §11.13). */
export function fmtInt(n: number): string { return String(Math.round(Math.abs(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
/** `$ 4,250` */
export function fmtMoney(n: number): string { return '$ ' + fmtInt(n); }
/** `$4,250` (compact, tiles). */
export function fmtPrice(n: number): string { return '$' + fmtInt(n); }
/** `+$300` / `−$2,700` (U+2212). */
export function fmtDelta(n: number): string { return (n < 0 ? '−$' : '+$') + fmtInt(n); }
/** `1:05` from seconds (ceil, so 0:00 only when the time is really up). */
export function fmtClock(sec: number): string {
  const s = Math.max(0, Math.ceil(sec - 1e-6));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
/** `42%` from a 0..1 ratio. */
export function fmtPct(r: number): string { return `${Math.round((Number.isFinite(r) ? r : 0) * 100)}%`; }

/** Button with i18n text; `onTap` runs on click. */
export function button(key: string, testid: string, onTap: () => void, cls = 'btn', params?: I18nParams): HTMLButtonElement {
  const b = tx(el('button', { class: cls, 'data-testid': testid, type: 'button' }), key, params);
  b.addEventListener('click', (e) => { e.stopPropagation(); onTap(); });
  return b;
}

/** Text cell: writes textContent only when the value changed (HUD hot path). */
export class TextCell {
  private v: string | null = null;
  constructor(readonly node: HTMLElement) {}
  set(s: string): void { if (s !== this.v) { this.v = s; this.node.textContent = s; } }
  reset(): void { this.v = null; }
}
/** Style cell: writes one style property only when the value changed. */
export class StyleCell {
  private v: string | null = null;
  constructor(readonly node: HTMLElement, private readonly prop: string) {}
  set(s: string): void { if (s !== this.v) { this.v = s; this.node.style.setProperty(this.prop, s); } }
  reset(): void { this.v = null; }
}
/** Class flag cell: toggles one class only when the value changed. */
export class FlagCell {
  private v: boolean | null = null;
  constructor(readonly node: Element, private readonly cls: string) {}
  set(b: boolean): void { if (b !== this.v) { this.v = b; this.node.classList.toggle(this.cls, b); } }
  get value(): boolean { return this.v === true; }
  reset(): void { this.v = null; }
}
/** Attribute cell (img src, data-state, …). */
export class AttrCell {
  private v: string | null = null;
  constructor(readonly node: Element, private readonly attr: string) {}
  set(s: string): void { if (s !== this.v) { this.v = s; this.node.setAttribute(this.attr, s); } }
  reset(): void { this.v = null; }
}

/** Touch-capable device (same test as platform/android bridge.isTouch; ui may not import platform/android). */
export function isTouchDevice(): boolean {
  if (typeof window === 'undefined') return false;
  return 'ontouchstart' in window || (navigator.maxTouchPoints ?? 0) > 0;
}

/** Orientation gate (§7.6): a touch device held in portrait must rotate. */
export function needsRotate(width: number, height: number, touch: boolean): boolean { return touch && height > width; }

/** Display key for a player: the human ('player' nameKey) → 'bot.player', bots carry 'bot.<key>'. */
export function nameKeyFor(nameKey: string): string {
  if (!nameKey || nameKey === 'player') return 'bot.player';
  return nameKey.startsWith('bot.') ? nameKey : 'bot.' + nameKey;
}
