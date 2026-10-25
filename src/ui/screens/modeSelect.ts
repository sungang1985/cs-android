/** Mode select (§8.3): three cards + difficulty / team / size / rounds; 「开始」 bottom-right emits startMatch. */
import type { Difficulty, MatchConfig, ModeId, Team } from '../../sim/state';
import type { ScreenData } from '../dom';
import { el, elt, button } from '../dom';
import { segmented } from '../widgets';
import type { ScreenHost } from './host';

export type HumanTeamChoice = Team | 'random';
export interface ModeSelection { mode: ModeId; difficulty: Difficulty; humanTeam: HumanTeamChoice; teamSize: 2 | 3 | 5; roundsToWin: 4 | 6 | 8 }

/** Payload of the `startMatch` action (Partial<MatchConfig> with humanTeam possibly 'random'; app/matchSettings resolves it). */
export function startPayload(s: ModeSelection): Partial<Omit<MatchConfig, 'humanTeam'>> & { humanTeam: HumanTeamChoice } {
  return { mode: s.mode, difficulty: s.difficulty, humanTeam: s.humanTeam, teamSize: s.teamSize, roundsToWin: s.roundsToWin };
}

export function initialSelection(last: (Partial<Omit<MatchConfig, 'humanTeam'>> & { humanTeam?: HumanTeamChoice }) | null | undefined): ModeSelection {
  const pick = <T>(v: T | undefined, ok: readonly T[], def: T): T => (v !== undefined && ok.includes(v) ? v : def);
  return {
    mode: pick(last?.mode, ['defusal', 'tdm', 'training'] as const, 'defusal'),
    difficulty: pick(last?.difficulty, ['easy', 'normal', 'hard'] as const, 'normal'),
    humanTeam: pick(last?.humanTeam, ['T', 'CT', 'random'] as const, 'CT'),
    teamSize: pick(last?.teamSize, [2, 3, 5] as const, 5),
    roundsToWin: pick(last?.roundsToWin, [4, 6, 8] as const, 6),
  };
}

const MODES: ModeId[] = ['defusal', 'tdm', 'training'];

export function buildMode(h: ScreenHost, d: ScreenData['mode'] | undefined): HTMLElement {
  const sel = initialSelection(d?.last as (Partial<MatchConfig> & { humanTeam?: HumanTeamChoice }) | null);
  const layer = el('div', { class: 'screen screen-mode', 'data-testid': 'screen-mode' });
  const cards = el('div', { class: 'mode-cards' });
  const cardEls = new Map<ModeId, HTMLElement>();
  for (const m of MODES) {
    const card = el('button', { class: 'mode-card', type: 'button', 'data-testid': `mode-${m}` }, [elt('b', `ui.mode.${m}`), elt('span', `ui.mode.${m}.desc`)]);
    card.addEventListener('click', () => { sel.mode = m; paint(); });
    cardEls.set(m, card); cards.append(card);
  }
  const diff = segmented<Difficulty>('seg-difficulty', [{ value: 'easy', key: 'ui.mode.easy' }, { value: 'normal', key: 'ui.mode.normal' }, { value: 'hard', key: 'ui.mode.hard' }], sel.difficulty, (v) => { sel.difficulty = v; });
  const team = segmented<HumanTeamChoice>('seg-team', [{ value: 'T', text: 'T' }, { value: 'CT', text: 'CT' }, { value: 'random', key: 'ui.mode.random' }], sel.humanTeam, (v) => { sel.humanTeam = v; });
  const size = segmented<2 | 3 | 5>('seg-size', [{ value: 2, text: '2v2' }, { value: 3, text: '3v3' }, { value: 5, text: '5v5' }], sel.teamSize, (v) => { sel.teamSize = v; });
  const rounds = segmented<4 | 6 | 8>('seg-rounds', [4, 6, 8].map((n) => ({ value: n as 4 | 6 | 8, key: 'ui.mode.roundsN', params: { n } })), sel.roundsToWin, (v) => { sel.roundsToWin = v; });
  const field = (key: string, ctl: HTMLElement) => el('div', { class: 'mode-field' }, [elt('span', key, { class: 'field-label' }), ctl]);
  const grid = el('div', { class: 'mode-grid' }, [field('ui.mode.difficulty', diff), field('ui.mode.team', team), field('ui.mode.size', size), field('ui.mode.rounds', rounds)]);
  const paint = () => {
    for (const [m, c] of cardEls) { c.classList.toggle('is-on', m === sel.mode); c.setAttribute('aria-pressed', String(m === sel.mode)); }
    const training = sel.mode === 'training';
    diff.setDisabled(training); team.setDisabled(training); size.setDisabled(training); rounds.setDisabled(sel.mode !== 'defusal');
  };
  paint();
  const head = el('div', { class: 'panel-head' }, [button('ui.common.back', 'btn-menu', () => h.action('menu'), 'btn btn-back'), elt('h2', 'ui.mode.title')]);
  const start = button('ui.mode.start', 'btn-startMatch', () => h.action('startMatch', startPayload(sel)), 'btn btn-big btn-primary btn-start');
  layer.append(head, cards, grid, start);
  return layer;
}
