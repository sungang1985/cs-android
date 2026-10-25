/** Entry point: boot the app shell (§11.6). Exposes globalThis.__cs for tools/e2e.mjs. */
import './ui/styles.css';
import { Game } from './app/game';
import { makeTestHooks } from './app/testHooks';
import { registerDictionary, setLocale, detectLocale } from './i18n/i18n';
import { zh } from './i18n/zh';
import { en } from './i18n/en';
import { zhUi } from './i18n/zh.ui';
import { enUi } from './i18n/en.ui';
import { persist } from './platform/persist';
import { pwa } from './platform/pwa';
import { DEFAULT_SETTINGS, DEFAULT_LAYOUT, cloneSettings, cloneLayout, type Settings, type TouchLayout } from './settings/types';

declare const __DEV__: boolean;

function boot(): void {
  registerDictionary('zh', zh); registerDictionary('en', en);
  registerDictionary('zh', zhUi); registerDictionary('en', enUi);
  const settings = { ...cloneSettings(DEFAULT_SETTINGS), ...persist.get<Partial<Settings>>('settings', {}) } as Settings;
  settings.controls = { ...DEFAULT_SETTINGS.controls, ...settings.controls };
  const layout = { ...cloneLayout(DEFAULT_LAYOUT), ...persist.get<Partial<TouchLayout>>('layout', {}) } as TouchLayout;
  const locale = persist.get<'zh' | 'en' | null>('locale', null) ?? (settings.locale !== 'auto' ? settings.locale : detectLocale(navigator.language));
  setLocale(locale);

  const canvas = document.getElementById('gl') as HTMLCanvasElement;
  const uiRoot = document.getElementById('ui') as HTMLElement;
  const radarCanvas = document.getElementById('radar') as HTMLCanvasElement;
  const search = location.search;
  const test = /[?&]test=1/.test(search);

  const probe = document.createElement('canvas').getContext('webgl2');
  if (!probe) {
    uiRoot.innerHTML = `<div class="screen" data-testid="screen-unsupported"><h2>${en['app.unsupported']}</h2></div>`;
    (globalThis as unknown as { __cs: unknown }).__cs = { ready: true, unsupported: true };
    return;
  }

  const game = new Game({ canvas, uiRoot, radarCanvas, settings, layout, search, now: () => Date.now() });
  const cs: Record<string, unknown> = { ready: true, game, perf: () => game.perf.stats(game.loop.stats.fps), version: typeof __DEV__ !== 'undefined' && __DEV__ ? 'dev' : 'prod' };
  if (test) Object.assign(cs, makeTestHooks(game));
  (globalThis as unknown as { __cs: unknown }).__cs = cs;
  pwa.register();
  game.showMain();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
