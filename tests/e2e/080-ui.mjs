/**
 * UI (L8): DOM-only screenshots (canvas hidden) of every screen; EN toggle; settings persistence across a reload;
 * mode select payload; buy flow UI (denied toast, Deagle buy); pause via back; scoreboard tap; spectator bar;
 * round/match end; onboarding; orientation gate in a second (portrait, touch) context; no horizontal overflow and
 * no text under 14 px at 851×393 and 932×430.
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '.e2e-out');
const HIDE_CANVAS = '#gl{visibility:hidden}';

/** No element visibly outside the viewport (unless clipped by an in-viewport overflow container); text ≥ 14 px. */
async function checkLayout(page, expect, label) {
  const r = await page.evaluate(() => {
    const W = innerWidth, H = innerHeight;
    const out = [], small = [];
    const clipped = (el) => {
      for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
        const cs = getComputedStyle(a);
        if (/(hidden|auto|scroll|clip)/.test(cs.overflowX + cs.overflowY)) { const ar = a.getBoundingClientRect(); if (ar.right <= W + 1 && ar.left >= -1) return true; }
      }
      return false;
    };
    for (const el of document.querySelectorAll('#ui *')) {
      if (el.closest('svg') && el.tagName !== 'svg') continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if ((rect.right > W + 1 || rect.left < -1) && !clipped(el)) out.push(`${el.className || el.tagName}@${Math.round(rect.left)}..${Math.round(rect.right)}`);
      const ownText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
      const minPx = el.classList.contains('cs-touch-icon') ? 0 : el.classList.contains('cs-touch-label') && !el.closest('.cs-touch-pill') ? 11 : 14; // pictographic icons exempt; small-button labels ≥ 11 px
      if (ownText && parseFloat(cs.fontSize) < minPx && rect.bottom > 0 && rect.top < H) small.push(`${el.className || el.tagName}:${cs.fontSize}:${el.textContent.trim().slice(0, 12)}`);
    }
    return { scrollW: document.documentElement.scrollWidth, W, out: out.slice(0, 6), small: small.slice(0, 6) };
  });
  expect(r.scrollW <= r.W, `${label}: page scrollWidth ${r.scrollW} > ${r.W}`);
  expect(r.out.length === 0, `${label}: elements outside the viewport: ${r.out.join(', ')}`);
  expect(r.small.length === 0, `${label}: text under 14 px: ${r.small.join(', ')}`);
}

export default async function ({ page, url, shot, expect, ready, dbg, log }) {
  const $ = (id) => page.locator(`[data-testid="${id}"]`).first();
  const tap = (id) => $(id).click();
  const visible = (id) => $(id).isVisible();
  const text = async (id) => ((await $(id).textContent()) ?? '').trim();
  const boot = async () => {
    await page.setViewportSize({ width: 851, height: 393 });   // §7.1 design target (the harness default is the 802×293 browser viewport)
    await page.goto(url + 'index.html?test=1&seed=1', { waitUntil: 'load' });
    await ready();
    await dbg('setRendering', false); // DOM-only scenario: skip WebGL drawing so screenshots don't stall under SwiftShader
    await page.addStyleTag({ content: HIDE_CANVAS });
    await page.waitForSelector('[data-testid="screen-main"]', { timeout: 10000 });
  };

  // ── main menu (zh) ──
  await boot();
  expect((await text('btn-play')).includes('开始'), 'play button is zh');
  await checkLayout(page, expect, 'main');
  await shot('main');

  // ── settings: every tab, the layout editor, sens 8 → 12 through the UI ──
  await tap('btn-settings');
  await page.waitForSelector('[data-testid="screen-settings"]');
  for (let i = 0; i < 4; i++) await tap('set-sens-inc');
  expect((await text('set-sens-value')) === '12', `sens readout 12, got ${await text('set-sens-value')}`);
  for (const tab of ['controls', 'graphics', 'audio', 'other']) {
    await tap(`settings-tab-${tab}`);
    await page.waitForSelector(`[data-testid="settings-panel-${tab}"]`);
    await checkLayout(page, expect, `settings-${tab}`);
    await shot(`settings-${tab}`);
  }
  await tap('settings-tab-controls');
  await tap('btn-layout');
  await page.waitForSelector('[data-testid="screen-layout"]');
  await checkLayout(page, expect, 'layout-editor');
  await shot('layout-editor');
  await tap('layout-done');
  await tap('btn-back');
  expect(!(await visible('screen-settings')), 'settings closed');

  // ── stats ──
  await tap('btn-stats');
  await page.waitForSelector('[data-testid="screen-stats"]');
  await checkLayout(page, expect, 'stats');
  await shot('stats');
  await tap('btn-back');

  // ── settings persistence: reload, read cs.v1.settings and the UI value ──
  await boot();
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('cs.v1.settings') ?? 'null'));
  expect(stored && stored.controls && stored.controls.sens === 12, `cs.v1.settings.controls.sens = 12, got ${stored && stored.controls && stored.controls.sens}`);
  await tap('btn-settings');
  expect((await text('set-sens-value')) === '12', 'sens 12 restored in the UI');
  await tap('btn-back');

  // ── EN toggle ──
  await tap('lang-en');
  expect((await text('btn-play')) === 'Play', `EN play button, got ${await text('btn-play')}`);
  expect((await page.evaluate(() => localStorage.getItem('cs.v1.locale'))) === '"en"', 'locale persisted');
  await checkLayout(page, expect, 'main-en');
  await shot('main-en');
  await tap('btn-settings');
  for (const tab of ['controls', 'other']) { await tap(`settings-tab-${tab}`); await checkLayout(page, expect, `settings-${tab}-en`); }
  await shot('settings-controls-en');
  await tap('btn-back');
  await tap('lang-zh');
  expect((await text('btn-play')).includes('开始'), 'back to zh');

  // ── mode select → startMatch payload ──
  await page.evaluate(() => { window.__acts = []; globalThis.__cs.game.bus.on('action', (a) => window.__acts.push(JSON.parse(JSON.stringify(a)))); });
  await tap('btn-play');
  await page.waitForSelector('[data-testid="screen-mode"]');
  for (const id of ['mode-defusal', 'seg-difficulty-hard', 'seg-team-T', 'seg-size-3', 'seg-rounds-4']) await tap(id);
  await checkLayout(page, expect, 'mode');
  await shot('mode');
  await tap('btn-startMatch');
  const start = await page.evaluate(() => window.__acts.find((a) => a.id === 'startMatch'));
  expect(start && start.payload.mode === 'defusal' && start.payload.difficulty === 'hard' && start.payload.humanTeam === 'T' && start.payload.teamSize === 3 && start.payload.roundsToWin === 4, `startMatch payload ${JSON.stringify(start)}`);
  await page.waitForSelector('[data-testid="hud"]', { state: 'visible' });

  // ── HUD in FREEZE (seed 4, lastSettings → T, 3v3) ──
  await dbg('startMatch', { mode: 'defusal', seed: 4 });
  await dbg('stepTicks', 10);
  await page.waitForTimeout(250);
  expect((await text('hud-buywindow')).startsWith('购买'), `buy window countdown, got ${await text('hud-buywindow')}`);
  await checkLayout(page, expect, 'hud');
  await shot('hud');

  // ── buy menu + buy flow UI part ──
  await page.evaluate(() => globalThis.__cs.game.bus.emit('action', { id: 'openBuy' }));
  await page.waitForSelector('[data-testid="screen-buy"]', { state: 'visible' });
  expect((await text('buy-money')).includes('800'), 'buy menu shows $800');
  await checkLayout(page, expect, 'buy');
  await shot('buy-menu');
  await tap('buy-ak47');                                   // $800 < $2,700 → the sim denies → toast
  await dbg('stepTicks', 2);
  await page.waitForSelector('[data-testid="hud-toast"]', { state: 'visible', timeout: 3000 });
  expect((await text('hud-toast')).includes('钱不够'), `denied toast, got ${await text('hud-toast')}`);
  expect(await visible('screen-buy'), 'menu stays open after a denied buy');
  await shot('buy-denied');
  await tap('buy-deagle');
  await dbg('stepTicks', 3);
  const human = await page.evaluate(() => { const p = globalThis.__cs.state().players.find((q) => q.id === 1); return { money: p.money, pistol: p.inv.pistol.id, active: p.inv.active }; });
  expect(human.money === 100 && human.pistol === 'deagle' && human.active === 2, `Deagle bought: ${JSON.stringify(human)}`);
  expect(!(await visible('screen-buy')), 'menu closes after a successful buy');
  await page.waitForSelector('[data-testid="hud-toast"]', { state: 'hidden', timeout: 3000 });

  // ── pause via back ──
  const back1 = await page.evaluate(() => window.__csBack());
  expect(back1 === 'handled', `__csBack → handled, got ${back1}`);
  await page.waitForSelector('[data-testid="screen-pause"]', { state: 'visible' });
  await checkLayout(page, expect, 'pause');
  await shot('pause');
  await tap('btn-quit');
  await page.waitForSelector('[data-testid="confirm"]');
  await shot('pause-confirm');
  await tap('btn-confirm-no');
  await page.evaluate(() => window.__csBack());              // back again resumes
  expect(!(await visible('screen-pause')), 'second back resumes');
  await dbg('stepTicks', 1);

  // ── scoreboard (tap the score) ──
  await tap('hud-score');
  await page.waitForSelector('[data-testid="screen-scoreboard"]', { state: 'visible' });
  await checkLayout(page, expect, 'scoreboard');
  await shot('scoreboard');
  await tap('screen-scoreboard');
  expect(!(await visible('screen-scoreboard')), 'tap closes the scoreboard');

  // ── spectator bar (force the human dead in state) ──
  await page.evaluate(() => { const s = globalThis.__cs.state(); const p = s.players.find((q) => q.id === 1); const mate = s.players.find((q) => q.team === p.team && q.id !== 1); p.hp = 0; p.alive = false; p.spectating = mate ? mate.id : 0; });
  await dbg('stepTicks', 1);
  await page.waitForSelector('[data-testid="hud-spectator"]', { state: 'visible', timeout: 3000 });
  await checkLayout(page, expect, 'spectator');
  await shot('spectator');

  // ── round end banner (+ scoreboard part after 1.5 s) ──
  await page.evaluate(() => globalThis.__cs.game.screens.show('roundEnd', { winner: 'T', reason: 'bomb', mvp: 2, deltas: [{ player: 1, delta: 3500, reason: 'win' }, { player: 2, delta: 3500, reason: 'win' }, { player: 3, delta: 3800, reason: 'win' }, { player: 4, delta: 1400, reason: 'loss' }], scoreT: 1, scoreCT: 0, humanTeam: 'T', names: {} }));
  await page.waitForSelector('[data-testid="screen-roundEnd"]');
  expect((await text('re-banner')).includes('T 胜利'), `banner, got ${await text('re-banner')}`);
  await shot('round-end');
  await page.waitForTimeout(1700);
  await checkLayout(page, expect, 'round-end-board');
  await shot('round-end-board');
  await page.evaluate(() => globalThis.__cs.game.screens.hide('roundEnd'));

  // ── match end ──
  await page.evaluate(() => globalThis.__cs.game.screens.show('matchEnd', { result: 'T', humanTeam: 'T', scoreT: 4, scoreCT: 2, mvp: 1, personal: { kills: 14, deaths: 6, headshots: 6, shots: 220, hits: 71, damage: 1830, plants: 2, defuses: 0, mvps: 3, accuracy: 71 / 220, hsPercent: 6 / 14 }, assistLevel: 2, cfg: globalThis.__cs.state().cfg }));
  await page.waitForSelector('[data-testid="screen-matchEnd"]');
  expect((await text('me-result')) === '胜利', 'victory');
  await checkLayout(page, expect, 'match-end');
  await shot('match-end');
  await page.evaluate(() => globalThis.__cs.game.screens.hide('matchEnd'));

  // ── onboarding (+ the aim-assist choice) and loading ──
  const marker = await page.evaluate(() => { window.__acts = []; globalThis.__cs.game.screens.show('onboarding', { step: 0 }); return window.__acts.find((a) => a.id === 'marker'); });
  expect(marker && marker.payload && marker.payload.x === 11, `onboarding emits marker, got ${JSON.stringify(marker)}`);
  await checkLayout(page, expect, 'onboarding');
  await shot('onboarding');
  await page.evaluate(() => globalThis.__cs.game.screens.onboardingStep(3));
  await page.waitForSelector('[data-testid="onboarding-assist-2"]');
  await shot('onboarding-assist');
  await page.evaluate(() => globalThis.__cs.game.screens.hide('onboarding'));
  await page.evaluate(() => globalThis.__cs.game.screens.show('loading', { progress: 0.6, label: 'ui.loading' }));
  await shot('loading');
  await page.evaluate(() => globalThis.__cs.game.screens.hide('loading'));

  // ── 802 × 293 (Pixel 5 browser viewport with chrome): compact layouts, still no overflow ──
  await page.setViewportSize({ width: 802, height: 293 });
  await page.evaluate(() => globalThis.__cs.game.bus.emit('action', { id: 'openBuy' }));
  await page.waitForSelector('[data-testid="screen-buy"]', { state: 'visible' });
  await checkLayout(page, expect, 'buy-293');
  const kit = await page.evaluate(() => { const r = document.querySelector('[data-testid="buy-defuse_kit"]').getBoundingClientRect(); const b = document.querySelector('[data-testid="screen-buy"]').getBoundingClientRect(); return r.bottom <= b.bottom + 0.5; });
  expect(kit, 'all four gear tiles fit at 293 px height');
  await shot('buy-menu-293');
  await page.evaluate(() => globalThis.__cs.game.bus.emit('action', { id: 'closeBuy' }));
  await page.evaluate(() => globalThis.__cs.game.screens.show('pause', { canBuy: true }));
  await checkLayout(page, expect, 'pause-293');
  await page.evaluate(() => globalThis.__cs.game.screens.hide('pause'));

  // ── 932 × 430: no overflow either ──
  await page.setViewportSize({ width: 932, height: 430 });
  await page.evaluate(() => globalThis.__cs.game.bus.emit('action', { id: 'openBuy' }));
  await page.waitForSelector('[data-testid="screen-buy"]', { state: 'visible' });
  await checkLayout(page, expect, 'buy-932');
  await shot('buy-menu-932');
  await page.evaluate(() => globalThis.__cs.game.showMain());
  await checkLayout(page, expect, 'main-932');
  await tap('btn-settings');
  await checkLayout(page, expect, 'settings-932');
  await tap('btn-back');
  for (const [w, h] of [[802, 293], [851, 393]]) {
    await page.setViewportSize({ width: w, height: h });
    await checkLayout(page, expect, `main-${h}`);
    await tap('btn-play'); await checkLayout(page, expect, `mode-${h}`);
    await page.evaluate(() => globalThis.__cs.game.showMain());
    await tap('btn-settings'); await checkLayout(page, expect, `settings-${h}`); await tap('btn-back');
  }

  // ── orientation gate: portrait + touch in a second context ──
  const ctx2 = await page.context().browser().newContext({ viewport: { width: 393, height: 851 }, hasTouch: true, isMobile: true, locale: 'zh-CN' });
  const p2 = await ctx2.newPage();
  const errors2 = [];
  p2.on('pageerror', (e) => errors2.push(e.message));
  p2.on('console', (m) => { if (m.type() === 'error' && !/favicon|GroupMarkerNotSet|GPU stall|swiftshader/i.test(m.text())) errors2.push(m.text()); });
  await p2.goto(url + 'index.html?test=1&seed=1', { waitUntil: 'load' });
  await p2.waitForFunction(() => globalThis.__cs && globalThis.__cs.ready === true, null, { timeout: 30000 });
  await p2.addStyleTag({ content: HIDE_CANVAS });
  await p2.waitForSelector('[data-testid="screen-rotate"]', { state: 'visible', timeout: 5000 });
  fs.mkdirSync(OUT, { recursive: true });
  await p2.screenshot({ path: path.join(OUT, '080-ui-rotate.png') });
  await p2.setViewportSize({ width: 851, height: 393 });
  await p2.waitForSelector('[data-testid="screen-rotate"]', { state: 'detached', timeout: 5000 });
  expect(await p2.locator('[data-testid="screen-main"]').isVisible(), 'main menu after rotating to landscape');
  await ctx2.close();
  expect(errors2.length === 0, `portrait context errors: ${errors2.join('; ')}`);
  log('ui scenario done');
}
