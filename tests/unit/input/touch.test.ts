import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Btn, WEAPON_INDEX } from '@/sim/state';
import { DEG } from '@/core/math';
import { cloneLayout, type ControlId } from '@/settings/types';
import { t } from '@/i18n/i18n';
import { accelFactor, TAP_MS } from '@/input/touch';
import { rig, pointer, pct, drag, makeLocal, type Rig } from './helpers';

const K = 0.022 * 8 * DEG; // rad per px at sens 8, FOV 75
const adv = (ms: number) => vi.advanceTimersByTime(ms);
const AWP = WEAPON_INDEX.indexOf('awp');

let r: Rig;
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] }); });
afterEach(() => { r?.cleanup(); vi.useRealTimers(); });

const centre = (id: ControlId) => { const g = r.input.touch.geometry()[id]; return { x: g.cx, y: g.cy }; };
const tap = (id: number, x: number, y: number, ms = 50) => { pointer('pointerdown', id, x, y); adv(ms); pointer('pointerup', id, x, y); };

describe('touch overlay DOM', () => {
  it('is inserted after the HUD inside #ui, purely visual, with a data-testid per control', () => {
    r = rig();
    const root = r.ui.querySelector('[data-testid="touch-layer"]') as HTMLElement;
    expect(root).not.toBeNull();
    expect(root.previousElementSibling?.id).toBe('hud');
    expect(root.style.pointerEvents).toBe('none');
    for (const id of ['fireR', 'fireL', 'jump', 'crouch', 'reload', 'switch', 'scope', 'grenade', 'grenadeSelect', 'use', 'buy', 'pause', 'joystick']) expect(root.querySelector(`[data-testid="touch-${id}"]`), id).not.toBeNull();
    r.input.detach();
    expect(r.ui.querySelector('[data-testid="touch-layer"]')).toBeNull();
  });
  it('setLayout applies scale, opacity and left-handed mirroring live', () => {
    r = rig();
    const el = r.ui.querySelector('[data-testid="touch-jump"]') as HTMLElement;
    const w0 = parseFloat(el.style.width);
    const l = cloneLayout(); l.scale = 1.2; l.opacity = 0.5; l.leftHanded = true;
    r.input.setLayout(l);
    expect(parseFloat(el.style.width)).toBeCloseTo(w0 * 1.2, 3);
    expect((r.ui.querySelector('[data-testid="touch-layer"]') as HTMLElement).style.opacity).toBe('0.5');
    expect(r.input.touch.geometry().jump.cx).toBeCloseTo(0.22 * 851, 3);
  });
  it('auto-hides when (pointer: fine) matches and re-shows on the first touch', () => {
    const mm = vi.fn(() => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} }));
    (window as unknown as { matchMedia: unknown }).matchMedia = mm;
    try {
      r = rig();
      const root = r.ui.querySelector('[data-testid="touch-layer"]') as HTMLElement;
      expect(root.style.display).toBe('none');
      const p = pct(70, 40); tap(1, p.x, p.y);
      expect(root.style.display).toBe('');
      expect(r.tick().buttons & Btn.FIRE).toBe(Btn.FIRE); // the first touch also counts
    } finally { delete (window as unknown as { matchMedia?: unknown }).matchMedia; }
  });
  it('setTouchVisible(false) hides the overlay but touches keep working', () => {
    r = rig();
    r.input.setTouchVisible(false);
    const root = r.ui.querySelector('[data-testid="touch-layer"]') as HTMLElement;
    expect(root.style.display).toBe('none'); expect(r.input.isTouchVisible()).toBe(false);
    const p = pct(70, 40); tap(1, p.x, p.y);
    expect(r.tick().buttons & Btn.FIRE).toBe(Btn.FIRE);
    r.input.setTouchVisible(true);
    expect(root.style.display).toBe('');
  });
  it('contextual controls follow the snapshot (scope = AWP, grenades, Use pill label, Buy pill)', () => {
    r = rig();
    const vis = (id: ControlId) => r.input.touch.isControlVisible(id);
    expect(vis('scope')).toBe(false); expect(vis('use')).toBe(false); expect(vis('buy')).toBe(false); expect(vis('grenade')).toBe(false);
    r.local = makeLocal({ weapon: AWP, primary: AWP, hasBomb: 1, canBuy: 1, he: 1, flash: 2 });
    r.tick();
    expect(vis('scope')).toBe(true); expect(vis('use')).toBe(true); expect(vis('buy')).toBe(true); expect(vis('grenade')).toBe(true); expect(vis('grenadeSelect')).toBe(true);
    expect(r.ui.querySelector('[data-testid="touch-use"] .cs-touch-label')!.textContent).toBe(t('hud.plant'));
    r.local = makeLocal({ useAction: 2 }); r.tick();
    expect(r.ui.querySelector('[data-testid="touch-use"] .cs-touch-label')!.textContent).toBe(t('hud.defuse'));
    r.local = makeLocal({ alive: 0 }); r.tick();
    expect(vis('fireR')).toBe(false); expect(vis('pause')).toBe(true);
  });
});

describe('pointer ownership', () => {
  it('a button beats the joystick zone (Fire-L lies inside it) and Fire-L contributes look', () => {
    r = rig({ accel: false });
    const c = centre('fireL');
    pointer('pointerdown', 1, c.x, c.y);
    drag(1, c.x, c.y, 40, 0, 4, 20, adv);
    const cmd = r.tick();
    expect(cmd.buttons & Btn.FIRE).toBe(Btn.FIRE);
    expect(cmd.moveX).toBe(0); expect(cmd.moveZ).toBe(0);
    expect(cmd.yaw).toBeCloseTo(-40 * K, 6);
  });
  it('Fire-R is fire + look; the joystick never contributes look', () => {
    r = rig({ accel: false });
    const f = centre('fireR');
    pointer('pointerdown', 1, f.x, f.y);
    drag(1, f.x, f.y, -100, 0, 10, 30, adv);
    const j = pct(15, 70);
    pointer('pointerdown', 2, j.x, j.y);
    drag(2, j.x, j.y, 50, 0, 5, 20, adv);
    const cmd = r.tick();
    expect(cmd.buttons & Btn.FIRE).toBe(Btn.FIRE);
    expect(cmd.yaw).toBeCloseTo(100 * K, 6);
    expect(cmd.moveX).toBeCloseTo(1); expect(cmd.moveZ).toBeCloseTo(0);
    pointer('pointerup', 2, j.x + 50, j.y);
    expect(r.tick().moveX).toBe(0);
  });
  it('joystick walk band → |move| = 0.6; a second pointer in the zone becomes a look pointer', () => {
    r = rig({ accel: false });
    const j = pct(20, 70); const travel = 8 * 3.93;
    pointer('pointerdown', 1, j.x, j.y);
    drag(1, j.x, j.y, 0, -0.5 * travel, 2, 20, adv);
    let cmd = r.tick();
    expect(cmd.moveZ).toBeCloseTo(0.6); expect(cmd.moveX).toBeCloseTo(0);
    const j2 = pct(30, 50);
    pointer('pointerdown', 2, j2.x, j2.y);
    drag(2, j2.x, j2.y, 10, 0, 1, 50, adv);
    cmd = r.tick();
    expect(cmd.yaw).toBeCloseTo(-10 * K, 6); expect(cmd.moveZ).toBeCloseTo(0.6);
  });
  it('the inert top-left band and UI elements (buttons, data-touch-ignore, .screen) never start a pointer', () => {
    r = rig();
    const p = pct(10, 10); tap(1, p.x, p.y);
    const b = document.createElement('button'); r.ui.append(b);
    const ig = document.createElement('div'); ig.setAttribute('data-touch-ignore', ''); r.ui.append(ig);
    const q = pct(70, 40);
    pointer('pointerdown', 2, q.x, q.y, b); adv(50); pointer('pointerup', 2, q.x, q.y, b);
    pointer('pointerdown', 3, q.x, q.y, ig); adv(50); pointer('pointerup', 3, q.x, q.y, ig);
    expect(r.tick().buttons).toBe(0);
  });
  it('mirrors the joystick zone when left-handed', () => {
    const l = cloneLayout(); l.leftHanded = true;
    r = rig({ accel: false }, l);
    const j = pct(85, 70);
    pointer('pointerdown', 1, j.x, j.y);
    drag(1, j.x, j.y, -40, 0, 2, 20, adv);
    const cmd = r.tick();
    expect(cmd.moveX).toBeCloseTo(-1); expect(cmd.yaw).toBe(0);
  });
});

describe('latching and buttons', () => {
  it('a sub-tick Fire-R tap is latched into exactly one FIRE tick', () => {
    r = rig();
    const f = centre('fireR');
    pointer('pointerdown', 1, f.x, f.y); adv(10); pointer('pointerup', 1, f.x, f.y);
    expect(r.tick().buttons & Btn.FIRE).toBe(Btn.FIRE);
    expect(r.tick().buttons & Btn.FIRE).toBe(0);
  });
  it('held buttons report every tick until release', () => {
    r = rig();
    const f = centre('fireR');
    pointer('pointerdown', 1, f.x, f.y);
    for (let i = 0; i < 3; i++) expect(r.tick().buttons & Btn.FIRE).toBe(Btn.FIRE);
    pointer('pointerup', 1, f.x, f.y);
    expect(r.tick().buttons & Btn.FIRE).toBe(0);
  });
  it('jump / reload latch; crouch toggles (or holds per settings)', () => {
    r = rig();
    const j = centre('jump'), rl = centre('reload'), c = centre('crouch');
    tap(1, j.x, j.y, 5); tap(2, rl.x, rl.y, 5);
    const cmd = r.tick();
    expect(cmd.buttons & (Btn.JUMP | Btn.RELOAD)).toBe(Btn.JUMP | Btn.RELOAD);
    tap(3, c.x, c.y);
    expect(r.tick().buttons & Btn.CROUCH).toBe(Btn.CROUCH);
    expect(r.tick().buttons & Btn.CROUCH).toBe(Btn.CROUCH);
    tap(4, c.x, c.y);
    expect(r.tick().buttons & Btn.CROUCH).toBe(0);
    r.cleanup();
    r = rig({ crouchMode: 'hold' });
    const c2 = centre('crouch');
    pointer('pointerdown', 5, c2.x, c2.y);
    expect(r.tick().buttons & Btn.CROUCH).toBe(Btn.CROUCH);
    pointer('pointerup', 5, c2.x, c2.y);
    expect(r.tick().buttons & Btn.CROUCH).toBe(0);
  });
  it('grenade sets THROW while held; the chip swaps the selection; switch cycles slots', () => {
    r = rig({}, cloneLayout(), makeLocal({ he: 1, flash: 1, selectedGrenade: 0, primary: 5, activeSlot: 2 }));
    const g = centre('grenade');
    pointer('pointerdown', 1, g.x, g.y);
    expect(r.tick().buttons & Btn.THROW).toBe(Btn.THROW);
    expect(r.tick().buttons & Btn.THROW).toBe(Btn.THROW);
    pointer('pointerup', 1, g.x, g.y);
    expect(r.tick().buttons & Btn.THROW).toBe(0);
    const s = centre('grenadeSelect'); tap(2, s.x, s.y);
    expect(r.tick().grenade).toBe(2);
    const sw = centre('switch'); tap(3, sw.x, sw.y);
    expect(r.tick().slot).toBe(3);
    r.local = makeLocal({ primary: 5, activeSlot: 3 }); r.tick();
    tap(4, sw.x, sw.y);
    expect(r.tick().slot).toBe(1);
  });
  it('Buy pill and pause go through onUiAction; Use pill holds USE', () => {
    r = rig({}, cloneLayout(), makeLocal({ canBuy: 1, hasBomb: 1 }));
    const b = centre('buy'), p = centre('pause'), u = centre('use');
    tap(1, b.x, b.y); tap(2, p.x, p.y);
    expect(r.ui_actions.map((a) => a.id)).toEqual(['openBuy', 'pause']);
    pointer('pointerdown', 3, u.x, u.y);
    expect(r.tick().buttons & Btn.USE).toBe(Btn.USE);
    expect(r.tick().buttons & Btn.USE).toBe(Btn.USE);
    pointer('pointerup', 3, u.x, u.y);
    expect(r.tick().buttons & Btn.USE).toBe(0);
  });
  it('UI → command one-tick latches: press, setBuy, spectate, selectSlot', () => {
    r = rig();
    r.input.press(Btn.DROP); r.input.setBuy('ak47'); r.input.spectate(1); r.input.selectSlot(3);
    const c = r.tick();
    expect(c.buttons & Btn.DROP).toBe(Btn.DROP); expect(c.buy).toBe('ak47'); expect(c.spectate).toBe(1); expect(c.slot).toBe(3);
    const d = r.tick();
    expect(d.buttons).toBe(0); expect(d.buy).toBeNull(); expect(d.spectate).toBe(0); expect(d.slot).toBe(0);
  });
});

describe('gestures', () => {
  it(`tap-to-fire: < ${TAP_MS} ms and < 8 px in the look zone → one latched FIRE`, () => {
    r = rig();
    const p = pct(70, 40);
    tap(1, p.x, p.y, 50);
    expect(r.tick().buttons & Btn.FIRE).toBe(Btn.FIRE);
    expect(r.tick().buttons & Btn.FIRE).toBe(0);
    tap(2, p.x, p.y, 200);
    expect(r.tick().buttons & Btn.FIRE).toBe(0);
    pointer('pointerdown', 3, p.x, p.y); drag(3, p.x, p.y, 20, 0, 2, 20, adv); pointer('pointerup', 3, p.x + 20, p.y);
    expect(r.tick().buttons & Btn.FIRE).toBe(0);
    r.input.setSettings({ ...r.input.getSettings(), tapToFire: false });
    tap(4, p.x, p.y, 50);
    expect(r.tick().buttons & Btn.FIRE).toBe(0);
  });
  it('double-tap jump (setting)', () => {
    r = rig({ doubleTapJump: true });
    const p = pct(70, 40);
    tap(1, p.x, p.y, 40); adv(100); tap(2, p.x + 5, p.y, 40);
    expect(r.tick().buttons & Btn.JUMP).toBe(Btn.JUMP);
    r.cleanup(); r = rig();
    tap(1, p.x, p.y, 40); adv(100); tap(2, p.x, p.y, 40);
    expect(r.tick().buttons & Btn.JUMP).toBe(0);
  });
  it('two-finger tap → RELOAD (setting) without firing', () => {
    r = rig({ twoFingerReload: true });
    const a = pct(60, 40), b = pct(80, 40);
    pointer('pointerdown', 1, a.x, a.y); adv(20); pointer('pointerdown', 2, b.x, b.y); adv(60);
    pointer('pointerup', 1, a.x, a.y); adv(10); pointer('pointerup', 2, b.x, b.y);
    const c = r.tick();
    expect(c.buttons & Btn.RELOAD).toBe(Btn.RELOAD); expect(c.buttons & Btn.FIRE).toBe(0);
  });
  it('pinch in the look zone toggles the AWP scope', () => {
    r = rig({ accel: false }, cloneLayout(), makeLocal({ weapon: AWP, primary: AWP, activeSlot: 1 }));
    const a = pct(52, 35), b = pct(62, 30); // clear of the scope button (78, 44), which is visible with the AWP
    pointer('pointerdown', 1, a.x, a.y); pointer('pointerdown', 2, b.x, b.y);
    drag(2, b.x, b.y, 80, 0, 4, 20, adv);
    expect(r.tick().buttons & Btn.SCOPE).toBe(Btn.SCOPE);
    pointer('pointerup', 1, a.x, a.y); pointer('pointerup', 2, b.x + 80, b.y);
    expect(r.tick().buttons & (Btn.SCOPE | Btn.FIRE)).toBe(0);
  });
  it('spectating: swipe left/right → spectate ∓1; no look while dead', () => {
    r = rig({ accel: false }, cloneLayout(), makeLocal({ alive: 0 }));
    const p = pct(70, 50);
    pointer('pointerdown', 1, p.x, p.y); drag(1, p.x, p.y, -120, 5, 4, 30, adv); pointer('pointerup', 1, p.x - 120, p.y + 5);
    let c = r.tick();
    expect(c.spectate).toBe(-1); expect(c.yaw).toBe(0);
    pointer('pointerdown', 2, p.x, p.y); drag(2, p.x, p.y, 120, 0, 4, 30, adv); pointer('pointerup', 2, p.x + 120, p.y);
    c = r.tick();
    expect(c.spectate).toBe(1);
  });
});

describe('sensitivity (§7.4)', () => {
  it('yawΔ = Δpx · 0.022° · sens, pitch 0.85×, finger up looks up; slow drags are not accelerated', () => {
    r = rig();
    const p = pct(70, 40);
    pointer('pointerdown', 1, p.x, p.y);
    drag(1, p.x, p.y, 200, 0, 50, 16, adv); // 10 px / 40 ms ≈ 250 px/s
    expect(r.tick().yaw).toBeCloseTo(-200 * K, 6);
    drag(1, p.x + 200, p.y, 0, -100, 25, 16, adv);
    const c = r.tick();
    expect(c.pitch).toBeCloseTo(100 * K * 0.85, 6);
  });
  it('acceleration factor 1 + 0.6·clamp((v − 400)/800, 0, 1) for fast flicks', () => {
    expect(accelFactor(300)).toBe(1); expect(accelFactor(800)).toBeCloseTo(1.3); expect(accelFactor(5000)).toBeCloseTo(1.6);
    r = rig();
    const p = pct(70, 40);
    pointer('pointerdown', 1, p.x, p.y);
    drag(1, p.x, p.y, 200, 0, 10, 8, adv); // 20 px / 8 ms = 2,500 px/s
    expect(r.tick().yaw).toBeCloseTo(-200 * K * 1.6, 6);
  });
  it('scoped: sensScoped and the scoped FOV (20 / 10); FOV setting scales', () => {
    r = rig({ accel: false, sensScoped: 4, fovDeg: 90 }, cloneLayout(), makeLocal({ scoped: 1 }));
    const p = pct(70, 40);
    pointer('pointerdown', 1, p.x, p.y); drag(1, p.x, p.y, 100, 0, 4, 20, adv);
    expect(r.tick().yaw).toBeCloseTo(-100 * 0.022 * 4 * (20 / 75) * DEG, 7);
    r.local = makeLocal({ scoped: 0 }); r.tick();
    drag(1, p.x + 100, p.y, 100, 0, 4, 20, adv);
    expect(r.tick().yaw).toBeCloseTo(-100 * 0.022 * 4 * (20 / 75) * DEG - 100 * 0.022 * 8 * (90 / 75) * DEG, 7);
  });
  it('previewLook adds the not-yet-consumed delta; sample consumes it; setLook resets', () => {
    r = rig({ accel: false });
    r.input.setLook(1, 0);
    const p = pct(70, 40);
    pointer('pointerdown', 1, p.x, p.y); drag(1, p.x, p.y, 50, 0, 2, 20, adv);
    const pv = r.input.previewLook([], r.local);
    expect(pv.yaw).toBeCloseTo(1 - 50 * K, 6);
    const c = r.tick();
    expect(c.yaw).toBeCloseTo(pv.yaw, 9);
    expect(r.input.previewLook([], r.local).yaw).toBeCloseTo(c.yaw, 9);
    r.input.setLook(0.5, 0.1);
    expect(r.tick()).toMatchObject({ yaw: 0.5, pitch: 0.1 });
  });
  it('pointerrawupdate is preferred when available (each movement counted once)', () => {
    (window as unknown as { onpointerrawupdate: null }).onpointerrawupdate = null;
    try {
      r = rig({ accel: false });
      const p = pct(70, 40);
      pointer('pointerdown', 1, p.x, p.y); adv(20);
      pointer('pointerrawupdate', 1, p.x + 30, p.y); pointer('pointermove', 1, p.x + 30, p.y);
      adv(20); pointer('pointerrawupdate', 1, p.x + 60, p.y); pointer('pointermove', 1, p.x + 60, p.y);
      expect(r.tick().yaw).toBeCloseTo(-60 * K, 6);
    } finally { delete (window as unknown as { onpointerrawupdate?: null }).onpointerrawupdate; }
  });
  it('gyro deltas (drag mode) are gated by a look pointer and scaled by gyroSens', () => {
    r = rig({ gyro: 'drag', gyroSens: 2, accel: false });
    r.input.gyro.injectRate(0, 1, 0.1);
    expect(r.tick().yaw).toBe(0);
    const p = pct(70, 40);
    pointer('pointerdown', 1, p.x, p.y);
    r.input.gyro.injectRate(0.5, 1, 0.1);
    const c = r.tick();
    expect(c.yaw).toBeCloseTo(0.2, 9); expect(c.pitch).toBeCloseTo(0.1, 9);
  });
});
