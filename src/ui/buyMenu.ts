/** Buy menu (§8.4). DAY-0 STUB: list of items with prices. L8 implements tiles/presets. */
import type { EventBus } from '../core/events';
import type { SnapLocal, Team, ItemId } from '../sim/state';
import { ITEM_PRICES } from '../weapons/defs';
import type { UiEvents } from './dom';
import { el } from './dom';
import { t } from '../i18n/i18n';

export class BuyMenu {
  private readonly root: HTMLElement;
  private handler: ((item: ItemId) => void) | null = null;
  constructor(parent: HTMLElement, private readonly bus: EventBus<UiEvents>) {
    this.root = el('div', { class: 'screen screen-buy', 'data-testid': 'screen-buy' }); this.root.style.display = 'none'; parent.append(this.root);
  }
  open(local: SnapLocal, team: Team): void {
    this.root.replaceChildren(el('h2', { text: `${t('menu.buy')}  $${local.money}` }));
    const items: ItemId[] = ['glock', 'usp', 'deagle', 'mp5', 'ak47', 'm4a4', 'awp', 'kevlar', 'kevlar_helmet', 'defuse_kit', 'he', 'flash'];
    for (const id of items) {
      if ((id === 'glock' || id === 'ak47') && team !== 'T') continue;
      if ((id === 'usp' || id === 'm4a4' || id === 'defuse_kit') && team !== 'CT') continue;
      const b = el('button', { class: 'btn', 'data-testid': `buy-${id}`, text: `${t((id in ITEM_PRICES && ['kevlar', 'kevlar_helmet', 'defuse_kit', 'c4'].includes(id) ? 'item.' : 'weapon.') + id)} $${ITEM_PRICES[id]}` });
      b.addEventListener('click', () => { this.handler?.(id); });
      this.root.append(b);
    }
    const close = el('button', { class: 'btn', 'data-testid': 'btn-closeBuy', text: t('menu.close') });
    close.addEventListener('click', () => this.bus.emit('action', { id: 'closeBuy' }));
    this.root.append(close);
    this.root.style.display = '';
  }
  close(): void { this.root.style.display = 'none'; }
  get isOpen(): boolean { return this.root.style.display !== 'none'; }
  onBuy(fn: (item: ItemId) => void): void { this.handler = fn; }
}
