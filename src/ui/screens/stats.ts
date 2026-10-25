/** Lifetime stats (战绩, §8.8): matches, wins, draws, K/D, HS %, accuracy, favourite weapon, best streak, assist levels. */
import { persist } from '../../platform/persist';
import type { LifetimeStats } from '../dom';
import { el, elt, tx, fmtPct, fmtInt, button } from '../dom';
import type { ScreenHost } from './host';

export const EMPTY_LIFETIME: LifetimeStats = { matches: 0, wins: 0, draws: 0, kills: 0, deaths: 0, headshots: 0, shots: 0, hits: 0, damage: 0, bestStreak: 0, byWeapon: {}, byAssist: { 0: 0, 1: 0, 2: 0, 3: 0 } };

export function favouriteWeapon(s: LifetimeStats): string | null {
  let best: string | null = null, k = 0;
  for (const [id, v] of Object.entries(s.byWeapon ?? {})) if (v.kills > k) { k = v.kills; best = id; }
  return best;
}

export function buildStats(h: ScreenHost, data: LifetimeStats | undefined): HTMLElement {
  const s: LifetimeStats = { ...EMPTY_LIFETIME, ...(data ?? persist.get<LifetimeStats>('stats', EMPTY_LIFETIME)) };
  const layer = el('div', { class: 'screen screen-stats', 'data-testid': 'screen-stats' });
  const tile = (key: string, value: string, testid: string) => el('div', { class: 'stat', 'data-testid': testid }, [el('b', { text: value }), elt('span', key)]);
  const losses = Math.max(0, s.matches - s.wins - s.draws);
  const fav = favouriteWeapon(s);
  const favTile = el('div', { class: 'stat', 'data-testid': 'stats-fav' }, [fav ? tx(el('b'), 'weapon.' + fav) : el('b', { text: '—' }), elt('span', 'ui.stats.favourite')]);
  const assistTotal = [0, 1, 2, 3].reduce((a, k) => a + (s.byAssist?.[k as 0 | 1 | 2 | 3] ?? 0), 0);
  const bars = el('div', { class: 'assist-bars', 'data-testid': 'stats-assist' });
  for (const k of [0, 1, 2, 3] as const) {
    const n = s.byAssist?.[k] ?? 0;
    const fill = el('i', { class: 'assist-fill' }); fill.style.width = `${assistTotal ? Math.round((n / assistTotal) * 100) : 0}%`;
    bars.append(el('div', { class: 'assist-row' }, [elt('span', `ui.assist.${k}`), el('span', { class: 'assist-track' }, [fill]), el('b', { text: String(n) })]));
  }
  const grid = el('div', { class: 'stats-grid' }, [
    tile('ui.stats.matches', fmtInt(s.matches), 'stats-matches'),
    tile('ui.stats.record', `${s.wins} / ${s.draws} / ${losses}`, 'stats-record'),
    tile('ui.stats.kd', s.deaths ? (s.kills / s.deaths).toFixed(2) : s.kills.toFixed(2), 'stats-kd'),
    tile('ui.stats.hs', fmtPct(s.kills ? s.headshots / s.kills : 0), 'stats-hs'),
    tile('ui.stats.accuracy', fmtPct(s.shots ? s.hits / s.shots : 0), 'stats-acc'),
    tile('ui.stats.streak', String(s.bestStreak), 'stats-streak'),
    tile('ui.stats.damage', fmtInt(s.damage), 'stats-damage'),
    favTile,
  ]);
  const head = el('div', { class: 'panel-head' }, [button('ui.common.back', 'btn-back', () => h.hide('stats'), 'btn btn-back'), elt('h2', 'ui.stats.title')]);
  layer.append(head, el('div', { class: 'stats-body' }, [grid, el('div', { class: 'assist-box' }, [elt('h3', 'ui.stats.assist'), bars])]));
  return layer;
}
