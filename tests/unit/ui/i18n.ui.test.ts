import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { setLocale } from '@/i18n/i18n';
import { zh } from '@/i18n/zh';
import { en } from '@/i18n/en';
import { zhUi } from '@/i18n/zh.ui';
import { enUi } from '@/i18n/en.ui';
import { WEAPON_INDEX, type MatchConfig } from '@/sim/state';
import { DEFAULT_LAYOUT } from '@/settings/types';
import { Screens } from '@/ui/screens';
import { Hud } from '@/ui/hud';
import { BuyMenu, PRESET_IDS } from '@/ui/buyMenu';
import { SETTINGS_TABS } from '@/ui/settings';
import type { ScreenName } from '@/ui/dom';
import { setup, snapshotWith, localWith, click } from './helpers';

const params = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
const srcRoot = path.resolve(process.cwd(), 'src', 'ui');   // vitest runs from the repo root (jsdom's URL rejects file: here)
function walk(dir: string): string[] { return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : [])); }

describe('zh.ui / en.ui dictionaries', () => {
  it('have the same keys', () => {
    expect(Object.keys(enUi).sort()).toEqual(Object.keys(zhUi).sort());
  });

  it('have the same {params} per key and no empty values', () => {
    for (const k of Object.keys(zhUi)) {
      expect(params(enUi[k]), k).toEqual(params(zhUi[k]));
      expect(zhUi[k].trim().length, k).toBeGreaterThan(0);
      expect(enUi[k].trim().length, k).toBeGreaterThan(0);
    }
  });

  it('agree with L4\'s zh/en on any duplicated key', () => {
    for (const k of Object.keys(zhUi)) { if (k in zh) expect(zhUi[k], k).toBe(zh[k]); if (k in en) expect(enUi[k], k).toBe(en[k]); }
  });

  it('contain every literal ui.* key used in src/ui and every dynamic key family', () => {
    const used = new Set<string>();
    for (const f of walk(srcRoot)) for (const m of fs.readFileSync(f, 'utf8').matchAll(/'(ui\.[A-Za-z0-9_.]+)'/g)) if (!m[1].endsWith('.')) used.add(m[1]);
    const dynamic = [
      ...['defusal', 'tdm', 'training'].flatMap((m) => [`ui.mode.${m}`, `ui.mode.${m}.desc`]),
      ...SETTINGS_TABS.map((t) => `ui.settings.tab.${t}`),
      ...PRESET_IDS.map((p) => `ui.buy.preset.${p}`),
      ...['money', 'window', 'zone', 'owned', 'team', 'max'].map((e) => `ui.buy.err.${e}`),
      ...['kill', 'plant', 'defuse', 'win', 'loss', 'plantedLoss', 'buy', 'halfReset'].map((r) => `ui.money.${r}`),
      ...[0, 1, 2, 3].map((n) => `ui.assist.${n}`),
      ...Object.keys(DEFAULT_LAYOUT.controls).map((c) => `ui.layout.ctl.${c}`),
      ...['move', 'aim', 'buy'].flatMap((k) => [`ui.onboarding.${k}.title`, `ui.onboarding.${k}.text`]),
      ...['low', 'medium', 'high', 'auto'].map((q) => `ui.settings.quality.${q}`),
    ];
    for (const k of [...used, ...dynamic]) expect(zhUi[k], k).toBeDefined();
    expect(used.size).toBeGreaterThan(60);
  });

  it('the display-name families owned by L4 exist in both locales', () => {
    const keys = [...WEAPON_INDEX.map((w) => `weapon.${w}`), 'item.kevlar', 'item.kevlar_helmet', 'item.defuse_kit', 'item.c4', ...['elimination', 'bomb', 'defuse', 'time', 'draw'].map((r) => `reason.${r}`), 'bot.player'];
    for (const k of keys) { expect(zh[k], k).toBeDefined(); expect(en[k], k).toBeDefined(); }
  });
});

describe('rendered UI has no unresolved {param} in either locale', () => {
  for (const locale of ['zh', 'en'] as const) {
    it(locale, () => {
      const { root, bus } = setup();
      setLocale(locale);
      const hud = new Hud(root, bus, { search: '?debug=1' });
      const screens = new Screens(root, bus);
      const menu = new BuyMenu(root, bus);
      hud.show(true);
      const snap = snapshotWith({ alive: 0, spectating: 2, killerId: 4, useAction: 2, useProgress: 0.3 });
      hud.update(snap);
      hud.handleEvent({ type: 'roundEnd', data: { winner: 'T', reason: 'elimination', mvp: 2, deltas: [] }, tick: 0 });
      hud.handleEvent({ type: 'buy', data: { player: 1, item: 'awp', ok: false, error: 'window' }, tick: 0 });
      menu.open(localWith(), 'CT');
      const personal = { kills: 1, deaths: 1, headshots: 0, shots: 1, hits: 1, damage: 10, plants: 0, defuses: 0, mvps: 0, accuracy: 1, hsPercent: 0 };
      const data: Partial<Record<ScreenName, unknown>> = {
        loading: { progress: 0.3, label: 'ui.loading' }, main: { canContinue: true, updateAvailable: true }, mode: { last: null }, pause: { canBuy: true },
        scoreboard: { snapshot: snap, humanTeam: 'T', mvp: 2 }, matchEnd: { result: 'draw', humanTeam: 'T', scoreT: 5, scoreCT: 5, mvp: 3, personal, assistLevel: 1, cfg: {} as MatchConfig },
        roundEnd: { winner: null, reason: 'draw', mvp: 0, deltas: [{ player: 1, delta: 1400, reason: 'loss' }], scoreT: 0, scoreCT: 0, humanTeam: 'T', names: {} },
        onboarding: { step: 1 },
      };
      for (const [s, d] of Object.entries(data)) screens.show(s as ScreenName, d as never);
      screens.show('stats'); screens.show('rotate');
      for (const t of SETTINGS_TABS) { screens.show('settings'); click(root, `settings-tab-${t}`); expect(root.textContent, t).not.toMatch(/\{\w+\}/); }
      click(root, 'settings-tab-controls'); click(root, 'btn-layout');
      expect(root.textContent).not.toMatch(/\{\w+\}/);
      expect(root.textContent).not.toMatch(/\bui\.[a-z]+\./);          // no raw keys either
    });
  }
});
