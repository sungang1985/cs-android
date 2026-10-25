/** Match end (§8.8): 胜利 / 失败 / 平局, final score, MVP, personal K/D, HS %, accuracy, damage; 再来一局 / 换模式 / 主菜单. */
import type { Team } from '../../sim/state';
import type { ScreenData } from '../dom';
import { el, elt, tx, fmtPct, fmtInt, button } from '../dom';
import { playerNameKey } from '../context';
import type { ScreenHost } from './host';

export function matchResultKey(result: Team | 'draw', humanTeam: Team): 'ui.match.win' | 'ui.match.lose' | 'ui.match.draw' {
  return result === 'draw' ? 'ui.match.draw' : result === humanTeam ? 'ui.match.win' : 'ui.match.lose';
}

function stat(key: string, value: string, testid: string): HTMLElement {
  return el('div', { class: 'stat', 'data-testid': testid }, [el('b', { text: value }), elt('span', key)]);
}

export function buildMatchEnd(h: ScreenHost, d: ScreenData['matchEnd'] | undefined): HTMLElement {
  const layer = el('div', { class: 'screen screen-matchEnd', 'data-testid': 'screen-matchEnd' });
  if (!d) return layer;
  // the human's CURRENT side decides 胜利/失败 (sides swap at the half; cfg.humanTeam is the starting side)
  const team = h.sh.localTeam ?? d.humanTeam;
  const key = matchResultKey(d.result, team);
  const p = d.personal;
  const kd = p.deaths > 0 ? (p.kills / p.deaths).toFixed(2) : p.kills.toFixed(2);
  const head = el('div', { class: `me-head ${key === 'ui.match.win' ? 'is-win' : key === 'ui.match.lose' ? 'is-lose' : 'is-draw'}` }, [
    elt('h1', key, { 'data-testid': 'me-result' }),
    el('div', { class: 'me-score' }, [el('span', { class: 'team-t', text: 'T' }), el('b', { text: `${d.scoreT} : ${d.scoreCT}` }), el('span', { class: 'team-ct', text: 'CT' })]),
  ]);
  if (d.mvp > 0) { const n = playerNameKey(h.sh, d.mvp); head.append(tx(el('div', { class: 'me-mvp', 'data-testid': 'me-mvp' }), 'ui.round.mvp', { name: n.raw ?? '@' + n.key })); }
  const stats = el('div', { class: 'me-stats' }, [
    stat('ui.stats.kd', `${p.kills} / ${p.deaths}  (${kd})`, 'me-kd'),
    stat('ui.stats.hs', fmtPct(p.hsPercent), 'me-hs'),
    stat('ui.stats.accuracy', fmtPct(p.accuracy), 'me-acc'),
    stat('ui.stats.damage', fmtInt(p.damage), 'me-dmg'),
  ]);
  const btns = el('div', { class: 'me-buttons' }, [
    button('ui.match.rematch', 'btn-rematch', () => h.action('rematch'), 'btn btn-big btn-primary'),
    button('ui.match.changeMode', 'btn-changeMode', () => h.action('changeMode'), 'btn btn-big'),
    button('ui.menu.menu', 'btn-menu', () => h.action('menu'), 'btn btn-big'),
  ]);
  layer.append(el('div', { class: 'me-panel' }, [head, stats, tx(el('div', { class: 'me-assist' }), 'ui.match.assist', { level: '@ui.assist.' + d.assistLevel })]), btns);
  return layer;
}
