/**
 * Round end (§8.8, §2.1): banner in the team colour + reason, own-team money delta list; the kill-cam stays
 * visible (transparent, non-blocking). After 1.5 s the scoreboard part of ROUND_END appears under the banner.
 */
import type { Team } from '../../sim/state';
import type { ScreenData } from '../dom';
import { el, elt, tx, fmtDelta } from '../dom';
import { playerNameKey } from '../context';
import type { ScreenHost } from './host';

export const ROUND_END_BANNER_MS = 1500;

export function buildRoundEnd(h: ScreenHost, d: ScreenData['roundEnd'] | undefined): HTMLElement {
  const layer = el('div', { class: 'screen screen-roundEnd', 'data-testid': 'screen-roundEnd' });
  if (!d) return layer;
  const own: Team = h.sh.localTeam ?? d.humanTeam;
  const banner = el('div', { class: `re-banner ${d.winner === 'T' ? 'team-t' : d.winner === 'CT' ? 'team-ct' : 'team-none'}`, 'data-testid': 're-banner' });
  if (d.winner) tx(banner, 'ui.round.banner', { team: d.winner, reason: '@reason.' + d.reason });
  else tx(banner, 'ui.round.draw', { reason: '@reason.' + d.reason });
  const sub = elt('div', d.winner === null ? 'ui.round.drawSub' : d.winner === own ? 'ui.round.youWin' : 'ui.round.youLose', { class: 're-sub' });
  const score = el('div', { class: 're-score' }, [el('span', { class: 'team-t', text: 'T' }), el('b', { text: `${d.scoreT} : ${d.scoreCT}` }), el('span', { class: 'team-ct', text: 'CT' })]);
  const top = el('div', { class: 're-top' }, [banner, sub, score]);
  if (d.mvp > 0) {
    const n = playerNameKey(h.sh, d.mvp, d.names);
    top.append(tx(el('div', { class: 're-mvp', 'data-testid': 're-mvp' }), 'ui.round.mvp', { name: n.raw ?? '@' + n.key }));
  }
  // money delta list: own team only (enemy money is hidden, §8.7), the human first
  const list = el('div', { class: 're-deltas', 'data-testid': 're-deltas' });
  const rows = d.deltas.filter((m) => { const r = h.sh.roster.get(m.player); return m.player === h.sh.localId || !r || r.team === own; })
    .sort((a, b) => (a.player === h.sh.localId ? -1 : b.player === h.sh.localId ? 1 : a.player - b.player));
  for (const m of rows.slice(0, 6)) {
    const n = playerNameKey(h.sh, m.player, d.names);
    const name = el('span', { class: 're-name' }); if (n.raw !== undefined) name.textContent = n.raw; else tx(name, n.key);
    list.append(el('div', { class: `re-delta ${m.player === h.sh.localId ? 'is-local' : ''}` }, [name, elt('span', 'ui.money.' + m.reason, { class: 're-reason' }), el('b', { class: m.delta < 0 ? 'neg' : 'pos', text: fmtDelta(m.delta) })]));
  }
  layer.append(top, list, el('div', { class: 're-board', 'data-testid': 're-board' }));
  return layer;
}
