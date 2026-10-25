/**
 * Screens (§8.2–8.8, §7.6). One DOM layer per visible ScreenName inside #screens; every button emits
 * `bus.emit('action', { id, payload? })` with the UiAction ids of §11.16 (settings / stats / layout editor are
 * UI-internal navigation). Screen builders live in ui/screens/*.ts, settings in ui/settings.ts.
 * Extras beyond the frozen interface: onboardingStep(n) (app-driven onboarding), feedSnapshot/feedEvent (the Hud
 * forwards snapshots/events: live scoreboard, onboarding progress) and the orientation gate (re-checked on resize).
 */
import type { EventBus } from '../core/events';
import type { RenderSnapshot } from '../sim/state';
import type { SimEnvelope } from '../sim/events';
import { cloneSettings, cloneLayout, DEFAULT_SETTINGS, DEFAULT_LAYOUT } from '../settings/types';
import { onLocaleChange, setLocale, getLocale } from '../i18n/i18n';
import { persist } from '../platform/persist';
import type { UiEvents, ScreenName, ScreenData, UiAction } from './dom';
import { el, elt, button, refillI18n, needsRotate, isTouchDevice } from './dom';
import { shared, type UiShared, type ScreensPeer } from './context';
import type { ScreenHost, SettingsTab } from './screens/host';
import { buildMain } from './screens/mainMenu';
import { buildMode } from './screens/modeSelect';
import { buildPause } from './screens/pause';
import { buildScoreboard, scoreTables, scoreSignature } from './screens/scoreboard';
import { buildRoundEnd, ROUND_END_BANNER_MS } from './screens/roundEnd';
import { buildMatchEnd } from './screens/matchEnd';
import { buildStats } from './screens/stats';
import { buildRotate, buildLoading } from './screens/rotate';
import { buildSettings } from './settings';
import { LayoutEditor } from './layoutEditor';
import { OnboardingFlow, buildOnboarding, type OnboardingStep } from './onboarding';

export type { ScreenName } from './dom';

interface Layer { node: HTMLElement; data: unknown }

export class Screens implements ScreensPeer {
  private readonly root: HTMLElement;
  private readonly layers = new Map<ScreenName, Layer>();
  private readonly sh: UiShared;
  private readonly host: ScreenHost;
  private readonly editor: LayoutEditor;
  private readonly flow: OnboardingFlow;
  private settingsTab: SettingsTab = 'controls';
  private confirmNode: HTMLElement | null = null;
  private emitting = false;
  private roundEndTimer: ReturnType<typeof setTimeout> | null = null;
  private obDoneTimer: ReturnType<typeof setTimeout> | null = null;
  private obJustDone = false;
  private boardSig = '';

  constructor(parent: HTMLElement, private readonly bus: EventBus<UiEvents>) {
    this.root = el('div', { id: 'screens', class: 'screens' });
    parent.append(this.root);
    this.sh = shared(bus);
    this.sh.screens = this;
    this.host = {
      bus, sh: this.sh,
      action: (id, payload) => this.emitAction(id, payload),
      show: (s, d) => this.show(s, d),
      hide: (s) => this.hide(s),
      confirm: (k, fn) => this.confirm(k, fn),
      emitSettings: () => this.emitSettings(),
      emitLayout: () => this.emitLayout(),
      setLocale: (l) => this.changeLocale(l),
      setSettingsTab: (t) => { this.settingsTab = t; if (this.layers.has('settings')) this.show('settings'); },
      openLayoutEditor: () => this.editor.open(),
      startTraining: () => this.startTraining(),
      chooseAssist: (lvl) => this.chooseAssist(lvl),
      skipOnboarding: () => this.finishOnboarding(),
    };
    this.editor = new LayoutEditor(this.root, () => this.sh.layout, (l) => this.emitLayout(l), () => { if (this.layers.has('settings')) this.show('settings'); });
    this.flow = new OnboardingFlow({ marker: (p) => this.bus.emit('action', { id: 'marker', payload: p }), changed: (_s, done) => this.onboardingChanged(done) });
    onLocaleChange(() => this.relocalize());
    // external settings changes (e.g. the app's quality preset) refresh an open settings screen
    bus.on('settingsChanged', () => { if (!this.emitting && this.layers.has('settings')) this.show('settings'); });
    if (typeof window !== 'undefined') {
      window.addEventListener('resize', () => this.checkOrientation());
      window.addEventListener('orientationchange', () => this.checkOrientation());
    }
    this.checkOrientation();
  }

  // ───────── binding API ─────────
  show<S extends ScreenName>(s: S, data?: ScreenData[S]): void {
    if (s === 'buy') { this.emitAction('openBuy'); return; }   // the buy menu is BuyMenu, opened by the app
    const prev = this.layers.get(s);
    if (s === 'onboarding') { this.obJustDone = false; this.flow.start(((data as ScreenData['onboarding'] | undefined)?.step ?? 0) as OnboardingStep); }
    const node = this.build(s, data);
    if (prev) prev.node.replaceWith(node); else this.root.append(node);
    this.layers.set(s, { node, data });
    if (!prev) this.bus.emit('screen', { name: s, visible: true });
    if (s === 'main') this.checkOrientation();
    if (s === 'roundEnd') { this.sh.hud?.clearNotice(); this.scheduleRoundBoard(); }
    if (s === 'scoreboard') this.boardSig = this.sh.snapshot ? scoreSignature(this.sh.snapshot) : '';
  }

  hide(s: ScreenName): void {
    if (s === 'buy') { this.emitAction('closeBuy'); return; }
    const l = this.layers.get(s);
    if (!l) return;
    l.node.remove();
    this.layers.delete(s);
    if (s === 'roundEnd' && this.roundEndTimer) { clearTimeout(this.roundEndTimer); this.roundEndTimer = null; }
    if (s === 'onboarding') this.flow.stop();
    if (s === 'settings') this.editor.close();
    this.bus.emit('screen', { name: s, visible: false });
    // the app hides every screen on match start / main menu; the gate must survive that while in portrait
    if (s === 'rotate') queueMicrotask(() => this.checkOrientation());
  }

  visible(): ScreenName[] { return [...this.layers.keys()]; }

  /** Android back / Esc: closes the top-most dismissible thing; returns true if handled. */
  back(): boolean {
    if (this.confirmNode) { this.closeConfirm(); return true; }
    if (this.editor.isOpen) { this.editor.close(); return true; }
    for (const s of ['settings', 'stats', 'scoreboard'] as const) if (this.layers.has(s)) { this.hide(s); return true; }
    if (this.layers.has('mode')) { this.emitAction('menu'); if (this.layers.has('mode')) this.hide('mode'); return true; }
    if (this.layers.has('pause')) { this.emitAction('resume'); return true; }
    return false;
  }

  /** App-driven onboarding (§7.6): 0 move, 1 aim & fire, 2 buy, 3 aim-assist choice. Shows the overlay if needed. */
  onboardingStep(n: OnboardingStep): void {
    if (!this.layers.has('onboarding')) { this.show('onboarding', { step: (n > 2 ? 2 : n) as 0 | 1 | 2 }); if (n === 3) this.onboardingStep(3); return; }
    this.flow.active = true;
    this.flow.enter(n);
    this.renderOnboarding();
  }

  // ───────── fed by the Hud (snapshots at 20 Hz, drained events) ─────────
  feedSnapshot(next: RenderSnapshot): void {
    if (this.layers.has('onboarding')) this.flow.feedLocal(next.local);
    const sb = this.layers.get('scoreboard');
    if (sb || (this.layers.get('roundEnd')?.node.classList.contains('show-board'))) {
      const sig = scoreSignature(next);
      if (sig !== this.boardSig) {
        this.boardSig = sig;
        if (sb) this.show('scoreboard', { ...(sb.data as ScreenData['scoreboard']), snapshot: next });
        else this.fillRoundBoard();
      }
    }
  }

  feedEvent(e: SimEnvelope): void { if (this.layers.has('onboarding')) this.flow.feedEvent(e); }

  // ───────── internals ─────────
  private build(s: ScreenName, data: unknown): HTMLElement {
    const h = this.host;
    switch (s) {
      case 'loading': return buildLoading(data as ScreenData['loading']);
      case 'main': return buildMain(h, data as ScreenData['main']);
      case 'mode': return buildMode(h, data as ScreenData['mode']);
      case 'settings': return buildSettings(h, this.settingsTab);
      case 'pause': return buildPause(h, data as ScreenData['pause']);
      case 'scoreboard': return buildScoreboard(h, data as ScreenData['scoreboard']);
      case 'roundEnd': return buildRoundEnd(h, data as ScreenData['roundEnd']);
      case 'matchEnd': return buildMatchEnd(h, data as ScreenData['matchEnd']);
      case 'stats': return buildStats(h, data as ScreenData['stats']);
      case 'onboarding': return buildOnboarding(h, this.flow, this.obJustDone);
      case 'rotate': return buildRotate();
      default: return el('div', { class: 'screen' });
    }
  }

  private emitAction(id: UiAction, payload?: unknown): void {
    this.bus.emit('action', payload === undefined ? { id } : { id, payload });
    if (id === 'resetData') this.afterReset();
  }

  private emitSettings(): void {
    this.emitting = true;
    try { this.bus.emit('settingsChanged', cloneSettings(this.sh.settings)); } finally { this.emitting = false; }
  }

  private emitLayout(l = this.sh.layout): void {
    this.emitting = true;
    try { this.bus.emit('layoutChanged', cloneLayout(l)); } finally { this.emitting = false; }
  }

  private changeLocale(l: 'zh' | 'en'): void {
    setLocale(l);                                  // onLocaleChange listeners re-fill every data-i18n node
    persist.set('locale', l);
    this.sh.settings.locale = l;
    this.bus.emit('langChanged', l);
    this.emitSettings();
  }

  private relocalize(): void {
    refillI18n(this.root);
    const cur = getLocale();
    for (const b of this.root.querySelectorAll<HTMLElement>('.lang-opt')) { const on = b.dataset.testid === `lang-${cur}`; b.classList.toggle('is-on', on); b.setAttribute('aria-pressed', String(on)); }
    if (this.layers.has('settings')) this.show('settings');
  }

  private afterReset(): void {
    this.sh.settings = cloneSettings(DEFAULT_SETTINGS);
    this.emitSettings();
    this.emitLayout(cloneLayout(DEFAULT_LAYOUT));
    if (this.layers.has('settings')) this.show('settings');
    const main = this.layers.get('main');
    if (main) this.show('main', { ...(main.data as ScreenData['main'] ?? { updateAvailable: false }), canContinue: false });
  }

  private confirm(messageKey: string, onYes: () => void): void {
    this.closeConfirm();
    const node = el('div', { class: 'confirm', 'data-testid': 'confirm', role: 'alertdialog' });
    node.addEventListener('pointerdown', (e) => e.stopPropagation());
    node.append(el('div', { class: 'confirm-box' }, [
      elt('p', messageKey),
      el('div', { class: 'confirm-buttons' }, [
        button('ui.common.cancel', 'btn-confirm-no', () => this.closeConfirm(), 'btn'),
        button('ui.common.ok', 'btn-confirm-yes', () => { this.closeConfirm(); onYes(); }, 'btn btn-danger'),
      ]),
    ]));
    this.confirmNode = node;
    this.root.append(node);
  }

  private closeConfirm(): void { this.confirmNode?.remove(); this.confirmNode = null; }

  private startTraining(): void {
    const done = persist.get<{ done?: boolean }>('onboarding', {}).done === true;
    this.emitAction('training');                   // synchronous: the app has started the training match when this returns
    if (!done) this.show('onboarding', { step: 0 });
  }

  private chooseAssist(level: 1 | 2 | 3): void {
    this.sh.settings.controls = { ...this.sh.settings.controls, aimAssist: level };
    this.emitSettings();
    persist.update('onboarding', { assistChosen: true }, { done: false, assistChosen: false });
    this.finishOnboarding();
  }

  private finishOnboarding(): void {
    this.flow.stop();
    this.emitAction('onboardingDone');
    this.hide('onboarding');
  }

  private onboardingChanged(done: boolean): void {
    this.obJustDone = done;
    this.renderOnboarding();
    if (done) {
      if (this.obDoneTimer) clearTimeout(this.obDoneTimer);
      this.obDoneTimer = setTimeout(() => { this.obDoneTimer = null; this.obJustDone = false; this.renderOnboarding(); }, 1500);
    }
  }

  private renderOnboarding(): void {
    const l = this.layers.get('onboarding');
    if (!l) return;
    const node = buildOnboarding(this.host, this.flow, this.obJustDone);
    l.node.replaceWith(node);
    l.node = node;
  }

  private scheduleRoundBoard(): void {
    if (this.roundEndTimer) clearTimeout(this.roundEndTimer);
    this.roundEndTimer = setTimeout(() => { this.roundEndTimer = null; this.fillRoundBoard(); }, ROUND_END_BANNER_MS);
  }

  private fillRoundBoard(): void {
    const l = this.layers.get('roundEnd'), snap = this.sh.snapshot;
    if (!l || !snap || snap.playerCount === 0) return;
    const d = l.data as ScreenData['roundEnd'] | undefined;
    const board = l.node.querySelector<HTMLElement>('[data-testid="re-board"]');
    if (!board) return;
    board.replaceChildren(scoreTables(snap, this.sh.localTeam ?? d?.humanTeam ?? 'CT', d?.mvp ?? this.sh.lastMvp, this.sh.localId));
    l.node.classList.add('show-board');
    this.boardSig = scoreSignature(snap);
  }

  /** Orientation gate (§7.6): a touch device in portrait shows 「请横屏」 on top of everything. */
  checkOrientation(): void {
    if (typeof window === 'undefined') return;
    const need = needsRotate(window.innerWidth, window.innerHeight, isTouchDevice());
    const has = this.layers.has('rotate');
    if (need && !has) this.show('rotate'); else if (!need && has) this.hide('rotate');
  }
}
