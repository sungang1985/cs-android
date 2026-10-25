/** Pause (§8.6): true pause; 继续 / 设置 / 购买 (buy window only) / 丢弃武器 / 退出到主菜单 (confirm). */
import type { ScreenData } from '../dom';
import { el, elt, button } from '../dom';
import type { ScreenHost } from './host';

export function buildPause(h: ScreenHost, d: ScreenData['pause'] | undefined): HTMLElement {
  const layer = el('div', { class: 'screen screen-pause', 'data-testid': 'screen-pause' });
  const list = el('div', { class: 'pause-list' }, [
    button('ui.pause.resume', 'btn-resume', () => h.action('resume'), 'btn btn-big btn-primary'),
    button('ui.menu.settings', 'btn-settings', () => h.show('settings'), 'btn btn-big'),
  ]);
  // the buy menu runs over the live sim (§8.4), so 购买 resumes first
  if (d?.canBuy) list.append(button('ui.pause.buy', 'btn-openBuy', () => { h.action('resume'); h.action('openBuy'); }, 'btn btn-big'));
  list.append(
    button('ui.pause.drop', 'btn-drop', () => h.action('drop'), 'btn btn-big'),
    button('ui.pause.quit', 'btn-quit', () => h.confirm('ui.pause.quitConfirm', () => h.action('quit')), 'btn btn-big btn-danger'),
  );
  layer.append(el('div', { class: 'pause-panel' }, [elt('h2', 'ui.pause.title'), list]));
  return layer;
}
