import { describe, it, expect, vi, afterEach } from 'vitest';
import { getLocale } from '@/i18n/i18n';
import { persist } from '@/platform/persist';
import { DEFAULT_SETTINGS, DEFAULT_LAYOUT, type Settings, type TouchLayout } from '@/settings/types';
import type { MatchConfig } from '@/sim/state';
import { Screens } from '@/ui/screens';
import { needsRotate } from '@/ui/dom';
import { dragToPercent } from '@/ui/layoutEditor';
import { ONBOARDING_TARGET } from '@/ui/onboarding';
import { setup, snapshotWith, $, click } from './helpers';

function make() { const env = setup(); const screens = new Screens(env.root, env.bus); return { ...env, screens }; }
const lastOf = <T>(arr: Array<{ type: string; data: unknown }>, type: string): T => [...arr].reverse().find((e) => e.type === type)!.data as T;

describe('Screens: main menu', () => {
  it('buttons emit play / training / continue / applyUpdate; settings and stats open locally', () => {
    const { root, screens, actions } = make();
    screens.show('main', { canContinue: true, updateAvailable: true });
    expect($(root, 'btn-play')!.textContent).toBe('开始游戏');
    click(root, 'btn-play'); click(root, 'btn-continue'); click(root, 'btn-applyUpdate');
    expect(actions.map((a) => a.id)).toEqual(['play', 'continue', 'applyUpdate']);
    click(root, 'btn-settings');
    expect(screens.visible()).toContain('settings');
    expect(screens.back()).toBe(true);
    click(root, 'btn-stats');
    expect(screens.visible()).toContain('stats');
    expect($(root, 'stats-matches')!.textContent).toContain('0');
  });

  it('no continue tile / update toast unless asked', () => {
    const { root, screens } = make();
    screens.show('main', { canContinue: false, updateAvailable: false });
    expect($(root, 'btn-continue')).toBeNull(); expect($(root, 'btn-applyUpdate')).toBeNull();
  });

  it('训练场 on first launch starts training and the onboarding overlay', () => {
    const { root, screens, actions } = make();
    screens.show('main', { canContinue: false, updateAvailable: false });
    click(root, 'btn-training');
    expect(actions[0].id).toBe('training');
    expect(screens.visible()).toContain('onboarding');
    expect(actions.find((a) => a.id === 'marker')!.payload).toEqual(ONBOARDING_TARGET);
  });

  it('中/EN pill switches locale, persists it, emits langChanged + full settings and re-fills data-i18n nodes', () => {
    const { root, screens, emitted } = make();
    screens.show('main', { canContinue: false, updateAvailable: false });
    click(root, 'lang-en');
    expect(getLocale()).toBe('en');
    expect(persist.get('locale', null)).toBe('en');
    expect(lastOf<string>(emitted, 'langChanged')).toBe('en');
    expect(lastOf<Settings>(emitted, 'settingsChanged').locale).toBe('en');
    expect($(root, 'btn-play')!.textContent).toBe('Play');
    expect($(root, 'lang-en')!.classList.contains('is-on')).toBe(true);
    click(root, 'lang-zh');
    expect($(root, 'btn-play')!.textContent).toBe('开始游戏');
  });
});

describe('Screens: mode select', () => {
  it('startMatch carries mode / difficulty / humanTeam / teamSize / roundsToWin', () => {
    const { root, screens, actions } = make();
    screens.show('mode', { last: null });
    for (const id of ['mode-tdm', 'seg-difficulty-hard', 'seg-team-random', 'seg-size-3', 'mode-defusal', 'seg-rounds-8']) click(root, id);
    click(root, 'btn-startMatch');
    expect(actions.at(-1)).toEqual({ id: 'startMatch', payload: { mode: 'defusal', difficulty: 'hard', humanTeam: 'random', teamSize: 3, roundsToWin: 8 } });
  });

  it('defaults come from the last MatchConfig; back emits menu', () => {
    const { root, screens, actions } = make();
    const last = { mode: 'tdm', difficulty: 'easy', humanTeam: 'T', teamSize: 2, roundsToWin: 4 } as Partial<MatchConfig> as MatchConfig;
    screens.show('mode', { last });
    click(root, 'btn-startMatch');
    expect(actions.at(-1)!.payload).toEqual({ mode: 'tdm', difficulty: 'easy', humanTeam: 'T', teamSize: 2, roundsToWin: 4 });
    expect(screens.back()).toBe(true);
    expect(actions.at(-1)!.id).toBe('menu');
  });

  it('training disables the match options', () => {
    const { root, screens } = make();
    screens.show('mode', { last: null });
    click(root, 'mode-training');
    expect($(root, 'seg-team')!.classList.contains('is-disabled')).toBe(true);
    expect(($(root, 'seg-size-3') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('Screens: pause, match end, back()', () => {
  it('pause emits resume / drop / openBuy (after resume) / quit only after confirm', () => {
    const { root, screens, actions } = make();
    screens.show('pause', { canBuy: true });
    click(root, 'btn-resume'); click(root, 'btn-drop'); click(root, 'btn-openBuy');
    expect(actions.map((a) => a.id)).toEqual(['resume', 'drop', 'resume', 'openBuy']);
    click(root, 'btn-quit');
    expect(actions.at(-1)!.id).toBe('openBuy');
    expect($(root, 'confirm')).not.toBeNull();
    click(root, 'btn-confirm-yes');
    expect(actions.at(-1)!.id).toBe('quit');
    screens.show('pause', { canBuy: false });
    expect($(root, 'btn-openBuy')).toBeNull();
  });

  it('back(): confirm → settings → pause (resume); nothing dismissible → false', () => {
    const { root, screens, actions } = make();
    expect(screens.back()).toBe(false);
    screens.show('pause', { canBuy: false });
    click(root, 'btn-settings');
    click(root, 'settings-tab-other'); click(root, 'btn-resetData');
    expect(screens.back()).toBe(true);           // closes the confirm
    expect($(root, 'confirm')).toBeNull();
    expect(screens.back()).toBe(true);           // closes settings
    expect(screens.visible()).toEqual(['pause']);
    expect(screens.back()).toBe(true);
    expect(actions.at(-1)!.id).toBe('resume');
    screens.show('roundEnd', { winner: 'CT', reason: 'time', mvp: 0, deltas: [], scoreT: 0, scoreCT: 1, humanTeam: 'T', names: {} });
    screens.hide('pause');
    expect(screens.back()).toBe(false);          // round end is not dismissible: the app pauses instead
  });

  it('match end: result from the human team; rematch / changeMode / menu', () => {
    const { root, screens, actions } = make();
    const personal = { kills: 3, deaths: 2, headshots: 1, shots: 10, hits: 5, damage: 300, plants: 0, defuses: 0, mvps: 0, accuracy: 0.5, hsPercent: 1 / 3 };
    const cfg = {} as MatchConfig;
    screens.show('matchEnd', { result: 'CT', humanTeam: 'CT', scoreT: 2, scoreCT: 6, mvp: 0, personal, assistLevel: 2, cfg });
    expect($(root, 'me-result')!.textContent).toBe('胜利');
    expect($(root, 'me-hs')!.textContent).toContain('33%');
    expect($(root, 'me-acc')!.textContent).toContain('50%');
    screens.show('matchEnd', { result: 'CT', humanTeam: 'T', scoreT: 2, scoreCT: 6, mvp: 0, personal, assistLevel: 2, cfg });
    expect($(root, 'me-result')!.textContent).toBe('失败');
    screens.show('matchEnd', { result: 'draw', humanTeam: 'T', scoreT: 5, scoreCT: 5, mvp: 0, personal, assistLevel: 2, cfg });
    expect($(root, 'me-result')!.textContent).toBe('平局');
    click(root, 'btn-rematch'); click(root, 'btn-changeMode'); click(root, 'btn-menu');
    expect(actions.map((a) => a.id)).toEqual(['rematch', 'changeMode', 'menu']);
  });
});

describe('Screens: scoreboard and round end', () => {
  it('scoreboard: two tables, money only for the own team, MVP star', () => {
    const { root, screens } = make();
    const snap = snapshotWith();
    screens.show('scoreboard', { snapshot: snap, humanTeam: 'T', mvp: 3 });
    const own = $(root, 'sb-team-T')!, enemy = $(root, 'sb-team-CT')!;
    expect(own.querySelectorAll('tbody tr').length).toBe(3);
    expect(enemy.querySelectorAll('tbody tr').length).toBe(3);
    expect(own.textContent).toContain('$800'); expect(enemy.textContent).not.toContain('$');
    expect(own.textContent).toContain('你'); expect(own.textContent).toContain('★');
    expect(enemy.textContent).toContain('小雷');
  });

  it('round end: banner in the team colour with the reason, money deltas by player id', () => {
    vi.useFakeTimers();
    const { root, screens } = make();
    screens.show('roundEnd', { winner: 'T', reason: 'bomb', mvp: 1, deltas: [{ player: 1, delta: 3500, reason: 'win' }, { player: 2, delta: 3500, reason: 'win' }], scoreT: 1, scoreCT: 0, humanTeam: 'T', names: { 2: '老王' } });
    expect($(root, 're-banner')!.textContent).toBe('T 胜利 — 炸弹已爆炸');
    expect($(root, 're-banner')!.classList.contains('team-t')).toBe(true);
    const deltas = $(root, 're-deltas')!.textContent!;
    expect(deltas).toContain('你'); expect(deltas).toContain('老王'); expect(deltas).toContain('+$3,500');
    expect($(root, 're-mvp')!.textContent).toBe('MVP：你');
    vi.useRealTimers();
  });
});

describe('Screens: settings', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('every change emits settingsChanged with the FULL Settings object', () => {
    const { root, screens, emitted } = make();
    screens.show('settings');
    click(root, 'set-sens-inc');
    let s = lastOf<Settings>(emitted, 'settingsChanged');
    expect(Object.keys(s).sort()).toEqual(Object.keys(DEFAULT_SETTINGS).sort());
    expect(Object.keys(s.controls).sort()).toEqual(Object.keys(DEFAULT_SETTINGS.controls).sort());
    expect(s.controls.sens).toBe(9);
    click(root, 'set-autoFire');
    s = lastOf<Settings>(emitted, 'settingsChanged');
    expect(s.controls).toMatchObject({ autoFire: true, sens: 9 });
    click(root, 'set-aimAssist-3');
    expect(lastOf<Settings>(emitted, 'settingsChanged').controls.aimAssist).toBe(3);
    click(root, 'settings-tab-graphics');
    click(root, 'set-quality-low');
    expect(lastOf<Settings>(emitted, 'settingsChanged')).toMatchObject({ quality: 'low', controls: { sens: 9, autoFire: true, aimAssist: 3 } });
    expect(lastOf<string>(emitted, 'qualityChanged')).toBe('low');
    click(root, 'set-fpsCap-30'); click(root, 'set-batterySaver'); click(root, 'set-fov-inc');
    expect(lastOf<Settings>(emitted, 'settingsChanged')).toMatchObject({ fpsCap: 30, batterySaver: true, controls: { fovDeg: 76 } });
    click(root, 'settings-tab-audio');
    click(root, 'set-master-dec'); click(root, 'set-haptics');
    expect(lastOf<Settings>(emitted, 'settingsChanged')).toMatchObject({ volume: { master: 75, sfx: 100, ui: 70 }, haptics: false });
  });

  it('the range slider and the stepper share one value', () => {
    const { root, screens, emitted } = make();
    screens.show('settings');
    const range = $(root, 'set-sens') as HTMLInputElement;
    range.value = '15'; range.dispatchEvent(new Event('input'));
    expect(lastOf<Settings>(emitted, 'settingsChanged').controls.sens).toBe(15);
    expect($(root, 'set-sens-value')!.textContent).toBe('15');
  });

  it('starts from the persisted settings', () => {
    const env = setup();
    persist.set('settings', { ...DEFAULT_SETTINGS, controls: { ...DEFAULT_SETTINGS.controls, sens: 12 } });
    const screens = new Screens(env.root, env.bus);
    screens.show('settings');
    expect($(env.root, 'set-sens-value')!.textContent).toBe('12');
  });

  it('左手模式 and the layout editor emit layoutChanged with the full TouchLayout', () => {
    const { root, screens, emitted } = make();
    screens.show('settings');
    click(root, 'set-leftHanded');
    expect(lastOf<TouchLayout>(emitted, 'layoutChanged').leftHanded).toBe(true);
    click(root, 'btn-layout');
    expect($(root, 'screen-layout')).not.toBeNull();
    const jump = $(root, 'layout-jump')!;
    jump.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 100, clientY: 100 }));
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 300, clientY: 384 }));
    window.dispatchEvent(new MouseEvent('pointerup', { clientX: window.innerWidth * 0.3, clientY: window.innerHeight * 0.5 }));
    const l = lastOf<TouchLayout>(emitted, 'layoutChanged');
    expect(Object.keys(l.controls).sort()).toEqual(Object.keys(DEFAULT_LAYOUT.controls).sort());
    expect(l.controls.jump).toEqual({ x: 70, y: 50, size: 10 });          // left-handed: display x 30 % ↔ stored 70 %
    click(root, 'layout-scale-inc');
    expect(lastOf<TouchLayout>(emitted, 'layoutChanged').scale).toBeCloseTo(1.05);
    click(root, 'layout-opacity-dec');
    expect(lastOf<TouchLayout>(emitted, 'layoutChanged').opacity).toBeCloseTo(0.65);
    click(root, 'layout-reset');
    expect(lastOf<TouchLayout>(emitted, 'layoutChanged')).toEqual(DEFAULT_LAYOUT);
    expect(screens.back()).toBe(true);
    expect($(root, 'screen-layout')).toBeNull();
  });

  it('drag maths snaps to 1 % and mirrors for left-handed', () => {
    expect(dragToPercent(425.4, 196.5, 851, 393, false)).toEqual({ x: 50, y: 50 });
    expect(dragToPercent(85.1, 39.3, 851, 393, true)).toEqual({ x: 90, y: 10 });
    expect(dragToPercent(-20, 900, 851, 393, false)).toEqual({ x: 0, y: 100 });
  });

  it('重置数据 asks first, then emits resetData and returns to defaults', () => {
    const { root, screens, actions, emitted } = make();
    screens.show('settings');
    click(root, 'set-sens-inc');
    click(root, 'settings-tab-other');
    click(root, 'btn-resetData');
    expect(actions.length).toBe(0);
    click(root, 'btn-confirm-yes');
    expect(actions.at(-1)!.id).toBe('resetData');
    expect(lastOf<Settings>(emitted, 'settingsChanged')).toEqual(DEFAULT_SETTINGS);
    expect(lastOf<TouchLayout>(emitted, 'layoutChanged')).toEqual(DEFAULT_LAYOUT);
  });
});

describe('Screens: onboarding (§7.6)', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('move → aim (5 targets) → buy rifle → aim-assist choice → onboardingDone', () => {
    vi.useFakeTimers();
    const { root, screens, actions, emitted } = make();
    screens.show('onboarding', { step: 0 });
    expect(actions.at(-1)).toEqual({ id: 'marker', payload: ONBOARDING_TARGET });
    expect($(root, 'onboarding-step-0')).not.toBeNull();
    screens.feedSnapshot(snapshotWith({ x: 0, z: 0 }));
    expect($(root, 'onboarding-step-0')).not.toBeNull();
    screens.feedSnapshot(snapshotWith({ x: ONBOARDING_TARGET.x + 0.5, z: ONBOARDING_TARGET.z }));
    expect($(root, 'onboarding-step-1')).not.toBeNull();
    expect(actions.at(-1)).toEqual({ id: 'marker', payload: null });
    for (let i = 0; i < 4; i++) screens.feedEvent({ type: 'targetHit', data: { id: 20 + i }, tick: i });
    expect($(root, 'onboarding-progress')!.textContent).toBe('已命中 4 / 5');
    screens.feedEvent({ type: 'targetHit', data: { id: 30 }, tick: 9 });
    expect($(root, 'onboarding-step-2')).not.toBeNull();
    screens.feedEvent({ type: 'buy', data: { player: 1, item: 'kevlar', ok: true }, tick: 10 });
    expect($(root, 'onboarding-step-2')).not.toBeNull();
    screens.feedEvent({ type: 'buy', data: { player: 1, item: 'ak47', ok: true }, tick: 11 });
    expect($(root, 'onboarding-step-3')).not.toBeNull();
    click(root, 'onboarding-assist-3');
    expect(lastOf<Settings>(emitted, 'settingsChanged').controls.aimAssist).toBe(3);
    expect(actions.at(-1)!.id).toBe('onboardingDone');
    expect(screens.visible()).not.toContain('onboarding');
    expect(persist.get<{ assistChosen?: boolean }>('onboarding', {}).assistChosen).toBe(true);
  });

  it('the app can drive steps with onboardingStep(n); skip ends it', () => {
    const { root, screens, actions } = make();
    screens.onboardingStep(2);
    expect($(root, 'onboarding-step-2')).not.toBeNull();
    click(root, 'onboarding-skip');
    expect(actions.at(-1)!.id).toBe('onboardingDone');
    expect(screens.visible()).toEqual([]);
  });
});

describe('orientation gate', () => {
  it('needsRotate: touch + portrait only', () => {
    expect(needsRotate(393, 851, true)).toBe(true);
    expect(needsRotate(851, 393, true)).toBe(false);
    expect(needsRotate(393, 851, false)).toBe(false);
  });

  it('show/hide rotate and loading', () => {
    const { root, screens } = make();
    screens.show('rotate');
    expect($(root, 'screen-rotate')!.textContent).toContain('请横屏');
    screens.show('loading', { progress: 0.5, label: 'ui.loading' });
    expect($(root, 'loading-label')!.textContent).toBe('加载中…');
    screens.hide('loading');
    expect(screens.visible()).toContain('rotate');
  });
});
