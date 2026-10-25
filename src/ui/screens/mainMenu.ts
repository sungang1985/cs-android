/** Main menu (§8.2): left 40 % shows the renderer's menu scene, right 60 % holds the 12 vh buttons. */
import { getLocale } from '../../i18n/i18n';
import { persist } from '../../platform/persist';
import type { ScreenData } from '../dom';
import { el, elt, button } from '../dom';
import type { ScreenHost } from './host';

export const APP_VERSION = '0.1.0';

/** `v0.1.0 · <build hash>` (the hash is the `?v=` stamp tools/build.mjs puts on app.js). */
export function versionText(): string {
  let build = '';
  try {
    const src = document.querySelector('script[src*="app.js"]')?.getAttribute('src') ?? '';
    const m = /[?&]v=([\w-]+)/.exec(src);
    if (m && !m[1].startsWith('__')) build = m[1].slice(0, 7);
  } catch { build = ''; }
  return build ? `v${APP_VERSION} · ${build}` : `v${APP_VERSION}`;
}

/** 中 / EN pill (`lang-zh`, `lang-en`). */
export function langPill(h: ScreenHost): HTMLElement {
  const cur = getLocale();
  const mk = (l: 'zh' | 'en', text: string) => {
    const b = el('button', { class: `lang-opt${cur === l ? ' is-on' : ''}`, type: 'button', 'data-testid': `lang-${l}`, text, 'aria-pressed': String(cur === l) });
    b.addEventListener('click', (e) => { e.stopPropagation(); h.setLocale(l); });
    return b;
  };
  return el('div', { class: 'lang-pill', 'data-testid': 'lang-toggle' }, [mk('zh', '中'), mk('en', 'EN')]);
}

function offlineBadge(): HTMLElement {
  const b = elt('span', 'ui.main.offline', { class: 'badge badge-offline is-hidden', 'data-testid': 'badge-offline' });
  try {
    const w = window as Window & { CSNative?: unknown };
    if (w.CSNative) b.classList.remove('is-hidden');
    else if (navigator.serviceWorker) {
      if (navigator.serviceWorker.controller) b.classList.remove('is-hidden');
      void navigator.serviceWorker.ready.then(() => b.classList.remove('is-hidden')).catch(() => {});
    }
  } catch { /* no service worker support */ }
  return b;
}

export function buildMain(h: ScreenHost, d: ScreenData['main'] | undefined): HTMLElement {
  const layer = el('div', { class: 'screen screen-main', 'data-testid': 'screen-main' });
  const onboardingDone = persist.get<{ done?: boolean }>('onboarding', {}).done === true;
  const training = button('ui.menu.training', 'btn-training', () => h.startTraining(), 'btn btn-big');
  if (!onboardingDone) training.append(elt('span', 'ui.main.newPlayer', { class: 'badge badge-new' }));
  const col = el('div', { class: 'main-col' }, [
    el('div', { class: 'main-top' }, [el('div', { class: 'main-title' }, [elt('h1', 'ui.app.title'), elt('p', 'ui.app.subtitle', { class: 'subtitle' })]), langPill(h)]),
    el('div', { class: 'main-buttons' }, [
      button('ui.menu.play', 'btn-play', () => h.action('play'), 'btn btn-big btn-primary'),
      training,
      button('ui.menu.settings', 'btn-settings', () => h.show('settings'), 'btn btn-big'),
      button('ui.menu.stats', 'btn-stats', () => h.show('stats'), 'btn btn-big'),
    ]),
    el('div', { class: 'main-foot' }, [el('span', { class: 'version', 'data-testid': 'app-version', text: versionText() }), offlineBadge()]),
  ]);
  const left = el('div', { class: 'main-left' });
  if (d?.canContinue) {
    const tile = el('button', { class: 'continue-tile', type: 'button', 'data-testid': 'btn-continue' }, [elt('b', 'ui.menu.continue'), elt('span', 'ui.main.continueHint')]);
    tile.addEventListener('click', () => h.action('continue'));
    left.append(tile);
  }
  layer.append(left, col);
  if (d?.updateAvailable) {
    const toast = el('div', { class: 'update-toast', 'data-testid': 'toast-update' }, [elt('span', 'ui.main.update'), button('ui.main.updateNow', 'btn-applyUpdate', () => h.action('applyUpdate'), 'btn btn-small btn-primary')]);
    layer.append(toast);
  }
  return layer;
}
