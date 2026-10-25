/** Scoreboard (§8.7): two team tables from the snapshot — name, K, D, money (own team only), alive, bomb/kit glyph, MVP. */
import type { EntityId, RenderSnapshot, Team } from '../../sim/state';
import type { ScreenData } from '../dom';
import { el, elt, tx, fmtPrice, nameKeyFor } from '../dom';
import { iconImg } from '../icons';
import type { ScreenHost } from './host';

export interface ScoreRow { id: number; nameKey: string; team: Team; alive: boolean; kills: number; deaths: number; money: number; hasBomb: boolean; hasKit: boolean }

/** Copies the (double-buffered, live) snapshot into plain rows sorted by kills desc, then deaths asc, then id. */
export function scoreRows(snap: RenderSnapshot): ScoreRow[] {
  const rows: ScoreRow[] = [];
  for (let i = 0; i < snap.playerCount; i++) {
    const p = snap.players[i];
    rows.push({ id: p.id, nameKey: p.nameKey, team: p.team === 0 ? 'T' : 'CT', alive: p.alive === 1, kills: p.kills, deaths: p.deaths, money: p.money, hasBomb: p.hasBomb === 1, hasKit: p.hasKit === 1 });
  }
  return rows.sort((a, b) => b.kills - a.kills || a.deaths - b.deaths || a.id - b.id);
}

/** Cheap change signature (the scoreboard re-renders at 20 Hz only when this changes). */
export function scoreSignature(snap: RenderSnapshot): string {
  let s = `${snap.round.scoreT}:${snap.round.scoreCT}`;
  for (let i = 0; i < snap.playerCount; i++) { const p = snap.players[i]; s += `|${p.id},${p.alive},${p.kills},${p.deaths},${p.money},${p.hasBomb},${p.hasKit},${p.team}`; }
  return s;
}

function teamTable(rows: ScoreRow[], team: Team, own: boolean, localId: EntityId, mvp: EntityId): HTMLElement {
  const head = el('tr', {}, [elt('th', 'ui.score.player', { class: 'col-name' }), el('th', { text: '' }), elt('th', 'ui.score.kills'), elt('th', 'ui.score.deaths'), own ? elt('th', 'ui.score.money') : el('th', { text: '' })]);
  const body = el('tbody');
  for (const r of rows) {
    if (r.team !== team) continue;
    const name = tx(el('span', { class: 'sb-name' }), nameKeyFor(r.id === localId ? 'player' : r.nameKey));
    const nameCell = el('td', { class: 'col-name' }, [el('i', { class: `sb-dot ${r.alive ? 'alive' : 'dead'}` }), name]);
    if (r.id === mvp) nameCell.append(el('span', { class: 'sb-mvp', text: '★', title: 'MVP' }));
    const glyph = el('td', { class: 'col-glyph' });
    if (r.hasBomb && own) glyph.append(iconImg('bomb', 'sb-icon', '#E04545'));
    if (r.hasKit) glyph.append(iconImg('kit', 'sb-icon', '#4F8FD6'));
    const tr = el('tr', { class: `${r.alive ? '' : 'is-dead'} ${r.id === localId ? 'is-local' : ''}`.trim(), 'data-testid': `sb-row-${r.id}` }, [nameCell, glyph, el('td', { text: String(r.kills) }), el('td', { text: String(r.deaths) }), el('td', { class: 'col-money', text: own && r.money >= 0 ? fmtPrice(r.money) : '' })]);
    body.append(tr);
  }
  return el('div', { class: `sb-team sb-${team.toLowerCase()} ${own ? 'is-own' : 'is-enemy'}`, 'data-testid': `sb-team-${team}` }, [
    el('div', { class: 'sb-team-head' }, [el('b', { text: team }), tx(el('span'), team === 'T' ? 'ui.team.T' : 'ui.team.CT')]),
    el('table', { class: 'sb-table' }, [el('thead', {}, [head]), body]),
  ]);
}

/** The two tables, own team first. */
export function scoreTables(snap: RenderSnapshot, humanTeam: Team, mvp: EntityId, localId: EntityId): HTMLElement {
  const rows = scoreRows(snap);
  const enemy: Team = humanTeam === 'T' ? 'CT' : 'T';
  return el('div', { class: 'sb-tables', 'data-testid': 'sb-tables' }, [teamTable(rows, humanTeam, true, localId, mvp), teamTable(rows, enemy, false, localId, mvp)]);
}

export function buildScoreboard(h: ScreenHost, d: ScreenData['scoreboard'] | undefined): HTMLElement {
  const layer = el('div', { class: 'screen screen-scoreboard', 'data-testid': 'screen-scoreboard' });
  layer.addEventListener('click', () => h.hide('scoreboard'));
  const snap = d?.snapshot ?? h.sh.snapshot;
  const team = h.sh.localTeam ?? d?.humanTeam ?? 'CT';
  const panel = el('div', { class: 'sb-panel' });
  if (snap) {
    panel.append(
      el('div', { class: 'sb-score' }, [el('span', { class: 'team-t', text: 'T' }), el('b', { text: `${snap.round.scoreT} : ${snap.round.scoreCT}` }), el('span', { class: 'team-ct', text: 'CT' })]),
      scoreTables(snap, team, d?.mvp ?? h.sh.lastMvp, h.sh.localId),
    );
  }
  layer.append(panel);
  return layer;
}
