import { describe, it, expect, vi, afterEach } from 'vitest';
import { DEFAULT_SETTINGS } from '@/settings/types';
import type { SimEnvelope } from '@/sim/events';
import { Hud } from '@/ui/hud';
import { Screens } from '@/ui/screens';
import { BuyMenu } from '@/ui/buyMenu';
import { crosshairGap, crosshairOffset, crosshairState } from '@/ui/crosshair';
import { setup, snapshotWith, $, click } from './helpers';

const ev = (type: string, data: unknown): SimEnvelope => ({ type, data, tick: 0 } as SimEnvelope);
function make() { const env = setup(); const hud = new Hud(env.root, env.bus, { search: '' }); hud.show(true); return { ...env, hud }; }

/** Counts textContent writes made by the code under test. */
function countTextWrites<T>(fn: () => T): number {
  const desc = Object.getOwnPropertyDescriptor(Node.prototype, 'textContent')!;
  let n = 0;
  Object.defineProperty(Node.prototype, 'textContent', { configurable: true, get: desc.get, set(v: string) { n++; desc.set!.call(this, v); } });
  try { fn(); } finally { Object.defineProperty(Node.prototype, 'textContent', desc); }
  return n;
}
function countStyleWrites<T>(fn: () => T): number {
  const proto = CSSStyleDeclaration.prototype;
  const orig = proto.setProperty;
  let n = 0;
  proto.setProperty = function (this: CSSStyleDeclaration, ...a: Parameters<typeof orig>) { n++; return orig.apply(this, a); };
  try { fn(); } finally { proto.setProperty = orig; }
  return n;
}

describe('Hud: 20 Hz update touches only changed nodes', () => {
  it('an identical snapshot writes nothing; one changed value writes one text node', () => {
    const { hud } = make();
    const snap = snapshotWith();
    expect(countTextWrites(() => hud.update(snap))).toBeGreaterThan(5);
    expect(countTextWrites(() => hud.update(snap))).toBe(0);
    expect(countStyleWrites(() => hud.update(snap))).toBe(0);
    snap.local.hp = 87;
    expect(countTextWrites(() => hud.update(snap))).toBe(1);
    snap.local.money = 1200;
    expect(countTextWrites(() => hud.update(snap))).toBe(1);
  });

  it('shows HP / armor / money / ammo / timer / score / buy window', () => {
    const { root, hud } = make();
    const snap = snapshotWith({ hp: 76, armor: 100, helmet: 1, money: 4250, mag: 7, reserve: 90, weapon: 5, buyWindowRemaining: 11.2 });
    snap.round.scoreT = 3; snap.round.scoreCT = 2; snap.round.remaining = 65.1; snap.round.phase = 2;
    hud.update(snap);
    expect($(root, 'hud-hp')!.textContent).toContain('76');
    expect($(root, 'hud-armor')!.textContent).toContain('100');
    expect($(root, 'hud-money')!.textContent).toContain('$ 4,250');
    expect($(root, 'hud-mag')!.textContent).toBe('7');
    expect($(root, 'hud-ammo')!.dataset.state).toBe('low');          // 7 ≤ 25 % of 30
    expect($(root, 'hud-timer')!.textContent).toBe('1:06');
    expect($(root, 'hud-score')!.textContent).toContain('3');
    expect($(root, 'hud-buywindow')!.textContent).toBe('购买 0:12');
    snap.local.mag = 0; hud.update(snap);
    expect($(root, 'hud-ammo')!.dataset.state).toBe('empty');
    expect($(root, 'hud-reload-hint')!.textContent).toBe('换弹!');
  });

  it('amber timer under 15 s; planted shows the bomb bar instead of digits', () => {
    const { root, hud } = make();
    const snap = snapshotWith();
    snap.round.phase = 2; snap.round.remaining = 12;
    hud.update(snap);
    expect($(root, 'hud-timer')!.classList.contains('is-amber')).toBe(true);
    snap.round.phase = 3; snap.bomb.state = 3; snap.bomb.remaining = 17.5;
    hud.update(snap);
    const t = $(root, 'hud-timer')!;
    expect(t.classList.contains('is-planted')).toBe(true);
    expect((t.querySelector('.hud-fill-bomb') as HTMLElement).style.width).toBe('50%');
  });

  it('low HP pulses and drives the vignette; flash overlay follows blindT', () => {
    const { root, hud } = make();
    const snap = snapshotWith({ hp: 15, blindT: 2 });
    hud.update(snap);
    expect($(root, 'hud-hp')!.classList.contains('is-low')).toBe(true);
    expect(Number($(root, 'hud-vignette')!.style.opacity)).toBeCloseTo(0.5, 1);
    expect(Number($(root, 'hud-flash')!.style.opacity)).toBe(1);
    snap.local.blindT = 1; hud.update(snap);
    expect(Number($(root, 'hud-flash')!.style.opacity)).toBeCloseTo(0.5, 1);
  });
});

describe('Hud: crosshair (§8.1, §4.3)', () => {
  it('gap = 4 + spreadDeg × 12', () => {
    expect(crosshairGap(0)).toBe(4); expect(crosshairGap(1)).toBe(16); expect(crosshairGap(Number.NaN)).toBe(4);
  });
  it('offset = −tan(½·aimOffset) / tan(fov/2) · H/2 (yaw + = left, pitch + = up)', () => {
    const v = { fovDeg: 90, width: 800, height: 400 };
    const o = crosshairOffset(0.2, 0.1, v);
    expect(o.dx).toBeCloseTo(-Math.tan(0.1) * 200, 6);
    expect(o.dy).toBeCloseTo(-Math.tan(0.05) * 200, 6);
    expect(crosshairOffset(0, 0, v)).toEqual({ dx: -0, dy: -0 });
  });
  it('red on an enemy / amber on a teammate only with assist or auto-fire', () => {
    expect(crosshairState(1, true)).toBe('enemy'); expect(crosshairState(2, true)).toBe('friend'); expect(crosshairState(1, false)).toBe('none');
    const { root, hud, bus } = make();
    const snap = snapshotWith({ crosshairTarget: 1, aimOffsetPitch: 0.1, spreadDeg: 1 });
    hud.setView({ fovDeg: 75, width: 851, height: 393 });
    hud.update(snap);
    const cross = $(root, 'crosshair')!;
    expect(cross.dataset.state).toBe('enemy');                 // default aim assist = 中
    expect(cross.style.getPropertyValue('--gap')).toBe('16px');
    const dy = Math.round((-Math.tan(0.05) / Math.tan((37.5 * Math.PI) / 180)) * (393 / 2) * 2) / 2;   // ≈ −13 px
    expect((cross.parentElement as HTMLElement).style.transform).toBe(`translate(0px, ${dy}px)`);
    bus.emit('settingsChanged', { ...DEFAULT_SETTINGS, controls: { ...DEFAULT_SETTINGS.controls, aimAssist: 0, recoilCrosshair: false } });
    hud.update(snap);
    expect(cross.dataset.state).toBe('none');
    expect((cross.parentElement as HTMLElement).style.transform).toBe('translate(0px, 0px)');
  });
});

describe('Hud: events', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('kill feed: 4 rows, names via t(nameKey) and bot.player, headshot glyph, 5 s', () => {
    vi.useFakeTimers();
    const { root, hud } = make();
    hud.update(snapshotWith());
    hud.handleEvent(ev('death', { victim: 4, killer: 1, weapon: 'ak47', headshot: true, pos: { x: 0, y: 0, z: 0 }, dir: { x: 0, y: 0, z: 1 } }));
    const row = root.querySelector('[data-testid="hud-feed-row"]')!;
    expect(row.textContent).toBe('你小雷');
    expect(row.querySelector('.feed-hs')).not.toBeNull();
    expect(row.querySelector('.feed-name.own')!.textContent).toBe('你');
    expect(row.querySelector('.feed-name.enemy')!.textContent).toBe('小雷');
    for (let i = 0; i < 4; i++) hud.handleEvent(ev('death', { victim: 2, killer: 5, weapon: 'glock', headshot: false, pos: { x: 0, y: 0, z: 0 }, dir: { x: 0, y: 0, z: 1 } }));
    expect(root.querySelectorAll('[data-testid="hud-feed-row"]').length).toBe(4);
    vi.advanceTimersByTime(5001);
    expect(root.querySelectorAll('[data-testid="hud-feed-row"]').length).toBe(0);
  });

  it('hit marker on own hits (80 ms), red on own kills', () => {
    vi.useFakeTimers();
    const { root, hud } = make();
    hud.update(snapshotWith());
    const hm = $(root, 'hud-hitmarker')!;
    hud.handleEvent(ev('hit', { attacker: 2, victim: 4, weapon: 'ak47', zone: 'chest', damage: 30, armored: false, point: { x: 0, y: 0, z: 0 } }));
    expect(hm.classList.contains('show')).toBe(false);
    hud.handleEvent(ev('hit', { attacker: 1, victim: 4, weapon: 'ak47', zone: 'chest', damage: 30, armored: false, point: { x: 0, y: 0, z: 0 } }));
    expect(hm.classList.contains('show')).toBe(true);
    vi.advanceTimersByTime(81);
    expect(hm.classList.contains('show')).toBe(false);
    hud.handleEvent(ev('death', { victim: 4, killer: 1, weapon: 'ak47', headshot: false, pos: { x: 0, y: 0, z: 0 }, dir: { x: 0, y: 0, z: 1 } }));
    expect(hm.classList.contains('kill')).toBe(true);
  });

  it('money deltas float for the local player; 「钱不够」 toast on a denied buy', () => {
    const { root, hud } = make();
    hud.update(snapshotWith());
    hud.handleEvent(ev('money', { player: 1, delta: -2700, reason: 'buy' }));
    hud.handleEvent(ev('money', { player: 2, delta: 300, reason: 'kill' }));
    expect($(root, 'hud-money-deltas')!.textContent).toBe('−$2,700');
    hud.handleEvent(ev('money', { player: 1, delta: 300, reason: 'plant' }));
    expect($(root, 'hud-notice')!.textContent).toBe('+$300');
    hud.handleEvent(ev('buy', { player: 1, item: 'ak47', ok: false, error: 'money' }));
    expect($(root, 'hud-toast')!.textContent).toBe('钱不够');
    expect($(root, 'hud-toast')!.classList.contains('is-hidden')).toBe(false);
  });

  it('centre notices: bomb planted, round banners', () => {
    const { root, hud } = make();
    hud.handleEvent(ev('bombPlanted', { player: 3, pos: { x: 0, y: 0, z: 0 }, site: 'a' }));
    expect($(root, 'hud-notice')!.textContent).toBe('炸弹已安放');
    hud.handleEvent(ev('roundEnd', { winner: 'CT', reason: 'defuse', mvp: 4, deltas: [] }));
    expect($(root, 'hud-notice')!.textContent).toBe('CT 胜利 — 炸弹已拆除');
    hud.handleEvent(ev('roundPhase', { phase: 'FREEZE', round: 3, endsTick: 0 }));
    expect($(root, 'hud-notice')!.textContent).toBe('第 3 回合');
  });

  it('spectator bar when dead: name, ◁ ▷ and 跳过回合 emit actions', () => {
    const { root, hud, actions } = make();
    const snap = snapshotWith({ alive: 0, hp: 0, spectating: 2, killerId: 5 });
    snap.players[0].alive = 0;
    hud.update(snap);
    expect($(root, 'hud-spectator')!.classList.contains('is-hidden')).toBe(false);
    expect($(root, 'hud-spectating')!.textContent).toBe('观战: 老王');
    expect($(root, 'hud-spectator')!.textContent).toContain('被 阿芳 击杀');
    click(root, 'btn-spectatePrev'); click(root, 'btn-spectateNext'); click(root, 'btn-skipRound');
    expect(actions.map((a) => a.id)).toEqual(['spectatePrev', 'spectateNext', 'skipRound']);
    expect($(root, 'crosshair')!.classList.contains('is-hidden')).toBe(true);
  });

  it('plant ring around the crosshair with a label; AWP scope overlay', () => {
    const { root, hud } = make();
    hud.update(snapshotWith({ useAction: 1, useProgress: 0.5, scoped: 1 }));
    expect($(root, 'hud-usering')!.classList.contains('is-hidden')).toBe(false);
    expect($(root, 'hud-usering')!.textContent).toBe('安放中…');
    expect($(root, 'hud-scope')!.classList.contains('is-hidden')).toBe(false);
  });

  it('tapping the score shows the scoreboard through Screens; the buy menu follows the snapshots', () => {
    const env = setup();
    const hud = new Hud(env.root, env.bus, { search: '' });
    const screens = new Screens(env.root, env.bus);
    const menu = new BuyMenu(env.root, env.bus);
    hud.show(true);
    const snap = snapshotWith();
    hud.update(snap);
    $(env.root, 'hud-score')!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    expect(screens.visible()).toContain('scoreboard');
    window.dispatchEvent(new MouseEvent('pointerup'));            // quick tap: stays open
    expect(screens.visible()).toContain('scoreboard');
    $(env.root, 'hud-score')!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    window.dispatchEvent(new MouseEvent('pointerup'));
    expect(screens.visible()).not.toContain('scoreboard');
    menu.open(snap.local, 'T');
    snap.local.canBuy = 0;
    hud.update(snap);
    expect(menu.isOpen).toBe(false);
  });

  it('an app-provided scoreboard handler replaces the default', () => {
    const { root, hud } = make();
    const calls: boolean[] = [];
    hud.onScoreboard((b) => calls.push(b));
    hud.update(snapshotWith());
    $(root, 'hud-score')!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    window.dispatchEvent(new MouseEvent('pointerup'));
    expect(calls).toEqual([true]);
  });
});
