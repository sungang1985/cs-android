/** Screens (§8.2–8.8). DAY-0 STUB: plain-text overlays with working buttons that emit UiEvents actions. L8 implements. */
import type { EventBus } from '../core/events';
import type { MatchConfig } from '../sim/state';
import type { UiEvents, ScreenName, ScreenData, UiAction } from './dom';
import { el } from './dom';
import { t } from '../i18n/i18n';

export class Screens {
  private readonly root: HTMLElement;
  private readonly layers = new Map<ScreenName, HTMLElement>();
  constructor(parent: HTMLElement, private readonly bus: EventBus<UiEvents>) {
    this.root = el('div', { id: 'screens' });
    parent.append(this.root);
  }
  private button(action: UiAction, label: string, payload?: unknown): HTMLElement {
    const b = el('button', { class: 'btn', 'data-testid': `btn-${action}`, text: label });
    b.addEventListener('click', () => this.bus.emit('action', { id: action, payload }));
    return b;
  }
  show<S extends ScreenName>(s: S, data?: ScreenData[S]): void {
    this.hide(s);
    const layer = el('div', { class: `screen screen-${s}`, 'data-testid': `screen-${s}` });
    const d = data as unknown;
    switch (s) {
      case 'loading': layer.append(el('h1', { text: t('app.title') }), el('p', { text: (d as ScreenData['loading'])?.label ?? '' })); break;
      case 'main': {
        layer.append(el('h1', { text: t('app.title') }));
        if ((d as ScreenData['main'])?.canContinue) layer.append(this.button('continue', t('menu.continue')));
        layer.append(this.button('play', t('menu.play')), this.button('training', t('menu.training')), el('div', { class: 'row' }, [this.button('menu', t('menu.settings'))]));
        break;
      }
      case 'mode': {
        const last = (d as ScreenData['mode'])?.last;
        const cfg: Partial<MatchConfig> = { mode: 'defusal', difficulty: last?.difficulty ?? 'normal', humanTeam: last?.humanTeam ?? 'CT', teamSize: last?.teamSize ?? 5, roundsToWin: last?.roundsToWin ?? 6 };
        layer.append(el('h2', { text: t('menu.mode') }), this.button('startMatch', t('mode.defusal'), { ...cfg, mode: 'defusal' }), this.button('startMatch', t('mode.tdm'), { ...cfg, mode: 'tdm' }), this.button('startMatch', t('mode.training'), { ...cfg, mode: 'training' }), this.button('menu', t('menu.back')));
        break;
      }
      case 'pause': layer.append(el('h2', { text: t('menu.paused') }), this.button('resume', t('menu.resume')), this.button('drop', t('menu.drop')), this.button('quit', t('menu.quit'))); break;
      case 'roundEnd': { const r = d as ScreenData['roundEnd']; layer.append(el('h2', { text: r.winner ? t('hud.roundWin', { team: r.winner }) : t('hud.roundDraw') }), el('p', { text: `${r.scoreT} : ${r.scoreCT}` })); break; }
      case 'matchEnd': { const r = d as ScreenData['matchEnd']; layer.append(el('h2', { text: r.result === 'draw' ? t('match.draw') : r.result === r.humanTeam ? t('match.win') : t('match.lose') }), el('p', { text: `${r.scoreT} : ${r.scoreCT}` }), this.button('rematch', t('menu.rematch')), this.button('menu', t('menu.menu'))); break; }
      case 'rotate': layer.append(el('h2', { text: t('app.rotate') })); break;
      default: layer.append(el('h2', { text: s }), this.button('menu', t('menu.back')));
    }
    this.layers.set(s, layer); this.root.append(layer);
    this.bus.emit('screen', { name: s, visible: true });
  }
  hide(s: ScreenName): void { const l = this.layers.get(s); if (l) { l.remove(); this.layers.delete(s); this.bus.emit('screen', { name: s, visible: false }); } }
  visible(): ScreenName[] { return [...this.layers.keys()]; }
  /** Back: closes the top-most dismissible screen; returns true if handled. */
  back(): boolean {
    for (const s of ['buy', 'scoreboard', 'stats', 'settings', 'mode'] as ScreenName[]) if (this.layers.has(s)) { this.hide(s); return true; }
    return false;
  }
}
