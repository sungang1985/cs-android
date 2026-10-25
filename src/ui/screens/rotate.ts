/** Orientation gate (§7.6: 「请横屏」 with an animated phone) and the loading screen. */
import type { ScreenData } from '../dom';
import { el, elt, tx } from '../dom';
import { t } from '../../i18n/i18n';

export function buildRotate(): HTMLElement {
  const phone = el('div', { class: 'rotate-phone', 'aria-hidden': 'true' }, [el('i', { class: 'rotate-notch' })]);
  return el('div', { class: 'screen screen-rotate', 'data-testid': 'screen-rotate', role: 'alert' }, [phone, elt('h2', 'ui.rotate.title'), elt('p', 'ui.rotate.hint')]);
}

export function buildLoading(d: ScreenData['loading'] | undefined): HTMLElement {
  const p = Math.max(0, Math.min(1, d?.progress ?? 0));
  const fill = el('i', { class: 'loading-fill' }); fill.style.width = `${Math.round(p * 100)}%`;
  const label = el('p', { class: 'loading-label', 'data-testid': 'loading-label' });
  // the label may be an i18n key or plain text (t() returns the key itself when unknown)
  if (d?.label && t(d.label) !== d.label) tx(label, d.label); else if (d?.label) label.textContent = d.label; else tx(label, 'ui.loading');
  return el('div', { class: 'screen screen-loading', 'data-testid': 'screen-loading' }, [elt('h1', 'ui.app.title'), el('div', { class: 'loading-track', 'data-testid': 'loading-bar' }, [fill]), label]);
}
