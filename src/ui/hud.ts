/** Hud (§8.1). DAY-0 STUB: plain-text HP/ammo/timer/score + kill feed, updated when values change. L8 implements. */
import type { EventBus } from '../core/events';
import type { RenderSnapshot, WeaponId } from '../sim/state';
import { WEAPON_INDEX } from '../sim/state';
import type { SimEnvelope } from '../sim/events';
import type { TouchLayout } from '../settings/types';
import type { UiEvents } from './dom';
import { el } from './dom';
import { t } from '../i18n/i18n';

export class Hud {
  private readonly root: HTMLElement;
  private readonly hp: HTMLElement; private readonly ammo: HTMLElement; private readonly timer: HTMLElement; private readonly score: HTMLElement; private readonly money: HTMLElement; private readonly feed: HTMLElement; private readonly notice: HTMLElement;
  private last = { hp: -1, ammo: '', timer: '', score: '', money: -1 };
  private view = { fovDeg: 75, width: 851, height: 393 };
  constructor(parent: HTMLElement, private readonly bus: EventBus<UiEvents>) {
    this.root = el('div', { id: 'hud', class: 'hud', 'data-testid': 'hud' });
    this.hp = el('div', { class: 'hud-hp', 'data-testid': 'hud-hp' }); this.money = el('div', { class: 'hud-money', 'data-testid': 'hud-money' });
    this.timer = el('div', { class: 'hud-timer', 'data-testid': 'hud-timer' }); this.score = el('div', { class: 'hud-score', 'data-testid': 'hud-score' });
    this.ammo = el('div', { class: 'hud-ammo', 'data-testid': 'hud-ammo' }); this.feed = el('div', { class: 'hud-feed', 'data-testid': 'hud-feed' }); this.notice = el('div', { class: 'hud-notice', 'data-testid': 'hud-notice' });
    const cross = el('div', { class: 'hud-crosshair', 'data-testid': 'crosshair' }, ['+']);
    this.root.append(this.hp, this.money, this.timer, this.score, this.ammo, this.feed, this.notice, cross);
    parent.append(this.root);
  }
  update(next: RenderSnapshot): void {
    const l = next.local;
    if (l.hp !== this.last.hp) { this.hp.textContent = `HP ${l.hp}  AP ${l.armor}`; this.last.hp = l.hp; }
    if (l.money !== this.last.money) { this.money.textContent = `$ ${l.money}`; this.last.money = l.money; }
    const w = (WEAPON_INDEX[l.weapon] as WeaponId | undefined) ?? '-';
    const ammo = `${t('weapon.' + w)}  ${l.mag} / ${l.reserve}`;
    if (ammo !== this.last.ammo) { this.ammo.textContent = ammo; this.last.ammo = ammo; }
    const rem = next.round.remaining; const timer = rem < 0 ? '' : `${Math.floor(rem / 60)}:${String(Math.floor(rem % 60)).padStart(2, '0')}`;
    if (timer !== this.last.timer) { this.timer.textContent = timer; this.last.timer = timer; }
    const score = `T ${next.round.scoreT} : ${next.round.scoreCT} CT`;
    if (score !== this.last.score) { this.score.textContent = score; this.last.score = score; }
  }
  setView(v: { fovDeg: number; width: number; height: number }): void { this.view = v; }
  handleEvent(e: SimEnvelope): void {
    if (e.type === 'death') {
      const d = e.data as { victim: number; killer: number; headshot: boolean };
      const row = el('div', { class: 'feed-row' }, [`${d.killer || '-'} → ${d.victim}${d.headshot ? ' ✦' : ''}`]);
      this.feed.prepend(row); while (this.feed.children.length > 4) this.feed.lastChild?.remove();
      setTimeout(() => row.remove(), 5000);
    } else if (e.type === 'roundEnd') {
      const r = e.data as { winner: string | null };
      this.notice.textContent = r.winner ? t('hud.roundWin', { team: r.winner }) : t('hud.roundDraw');
      setTimeout(() => { this.notice.textContent = ''; }, 3000);
    }
  }
  setLayout(l: TouchLayout): void { void l; }
  show(b: boolean): void { this.root.style.display = b ? '' : 'none'; }
  get element(): HTMLElement { return this.root; }
  get bus_(): EventBus<UiEvents> { return this.bus; }
}
