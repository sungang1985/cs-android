import { describe, it, expect, afterEach, vi } from 'vitest';
import { Btn } from '@/sim/state';
import { DEG } from '@/core/math';
import { cycleSlot } from '@/input/keyboard';
import { rig, makeLocal, pointer, type Rig } from './helpers';

let r: Rig;
afterEach(() => { r?.cleanup(); });

const key = (type: 'keydown' | 'keyup', code: string, target: EventTarget = window) => target.dispatchEvent(new KeyboardEvent(type, { code, bubbles: true, cancelable: true }));
const press = (code: string) => { key('keydown', code); key('keyup', code); };
let locked: Element | null = null;
function setLock(el: Element | null): void {
  Object.defineProperty(document, 'pointerLockElement', { configurable: true, get: () => locked });
  locked = el;
  document.dispatchEvent(new Event('pointerlockchange'));
}
afterEach(() => { locked = null; });

describe('desktop keyboard (§7.7)', () => {
  it('WASD move (normalised), Shift walk, Ctrl crouch hold', () => {
    r = rig();
    key('keydown', 'KeyW'); key('keydown', 'KeyD'); key('keydown', 'ShiftLeft'); key('keydown', 'ControlLeft');
    const c = r.tick();
    expect(c.moveZ).toBeCloseTo(Math.SQRT1_2); expect(c.moveX).toBeCloseTo(Math.SQRT1_2);
    expect(c.buttons & (Btn.WALK | Btn.CROUCH)).toBe(Btn.WALK | Btn.CROUCH);
    key('keyup', 'KeyW'); key('keyup', 'KeyD'); key('keyup', 'ShiftLeft'); key('keyup', 'ControlLeft');
    const d = r.tick();
    expect(d.moveX).toBe(0); expect(d.moveZ).toBe(0); expect(d.buttons).toBe(0);
  });
  it('Space / R / E / G presses shorter than a tick are latched', () => {
    r = rig();
    press('Space'); press('KeyR'); press('KeyE'); press('KeyG');
    expect(r.tick().buttons).toBe(Btn.JUMP | Btn.RELOAD | Btn.USE | Btn.DROP);
    expect(r.tick().buttons).toBe(0);
  });
  it('1–4 select slots, 4 again swaps HE/flash, Q returns to the last weapon', () => {
    r = rig({}, undefined, makeLocal({ primary: 5, activeSlot: 1 }));
    press('Digit2'); expect(r.tick().slot).toBe(2);
    r.local = makeLocal({ primary: 5, activeSlot: 2 }); r.tick();
    press('KeyQ'); expect(r.tick().slot).toBe(1);
    r.local = makeLocal({ activeSlot: 4, he: 1, flash: 1, selectedGrenade: 0 }); r.tick();
    press('Digit4');
    const c = r.tick(); expect(c.grenade).toBe(2); expect(c.slot).toBe(0);
    r.local = makeLocal({ activeSlot: 2, he: 1, flash: 1 }); r.tick();
    press('Digit4'); expect(r.tick().slot).toBe(4);
  });
  it('B buy, Tab scoreboard (hold), Esc pause, ←/→ spectate', () => {
    r = rig();
    press('KeyB'); key('keydown', 'Tab'); key('keyup', 'Tab'); press('Escape');
    expect(r.ui_actions).toEqual([{ id: 'openBuy', down: undefined }, { id: 'scoreboard', down: true }, { id: 'scoreboard', down: false }, { id: 'pause', down: undefined }]);
    press('ArrowLeft'); expect(r.tick().spectate).toBe(-1);
    press('ArrowRight'); expect(r.tick().spectate).toBe(1);
  });
  it('ignores keys typed into text fields', () => {
    r = rig();
    const inp = document.createElement('input'); document.body.append(inp);
    key('keydown', 'KeyR', inp);
    expect(r.tick().buttons).toBe(0);
  });
});

describe('desktop mouse (§7.7)', () => {
  it('click on the game surface requests pointer lock; locked mouse look is 0.022°·sens/8 per px', () => {
    r = rig({ accel: false });
    const req = vi.fn(); (r.canvas as unknown as { requestPointerLock: () => void }).requestPointerLock = req;
    pointer('pointerdown', 1, 400, 200, r.canvas, 'mouse');
    expect(req).toHaveBeenCalledTimes(1);
    expect(r.tick().buttons).toBe(0); // the locking click does not fire
    setLock(r.canvas);
    const mv = new MouseEvent('mousemove', { bubbles: true });
    Object.defineProperty(mv, 'movementX', { value: 80 }); Object.defineProperty(mv, 'movementY', { value: -40 });
    r.canvas.dispatchEvent(mv);
    const c = r.tick();
    expect(c.yaw).toBeCloseTo(-80 * 0.022 * DEG, 8); expect(c.pitch).toBeCloseTo(40 * 0.022 * DEG * 0.85, 8);
  });
  it('LMB fire (THROW while slot 4 is active), RMB scope', () => {
    r = rig();
    setLock(r.canvas);
    pointer('pointerdown', 1, 0, 0, r.canvas, 'mouse');
    expect(r.tick().buttons & Btn.FIRE).toBe(Btn.FIRE);
    expect(r.tick().buttons & Btn.FIRE).toBe(Btn.FIRE);
    pointer('pointerup', 1, 0, 0, r.canvas, 'mouse');
    expect(r.tick().buttons).toBe(0);
    r.local = makeLocal({ activeSlot: 4, he: 1 }); r.tick();
    pointer('pointerdown', 1, 0, 0, r.canvas, 'mouse'); pointer('pointerup', 1, 0, 0, r.canvas, 'mouse');
    expect(r.tick().buttons).toBe(Btn.THROW);
    r.canvas.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, pointerType: 'mouse', button: 2, bubbles: true }));
    expect(r.tick().buttons & Btn.SCOPE).toBe(Btn.SCOPE);
  });
  it('losing the lock unexpectedly pauses; B unlocks without pausing', () => {
    r = rig();
    setLock(r.canvas); setLock(null);
    expect(r.ui_actions.map((a) => a.id)).toEqual(['pause']);
    (document as unknown as { exitPointerLock: () => void }).exitPointerLock = () => setLock(null);
    setLock(r.canvas); press('KeyB');
    expect(r.ui_actions.map((a) => a.id)).toEqual(['pause', 'openBuy']);
  });
  it('wheel cycles owned weapons', () => {
    r = rig({}, undefined, makeLocal({ primary: 5, activeSlot: 2 }));
    r.canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, bubbles: true }));
    expect(r.tick().slot).toBe(3);
    expect(cycleSlot(makeLocal({ primary: 5, activeSlot: 3 }), 1)).toBe(1);
    expect(cycleSlot(makeLocal({ primary: -1, activeSlot: 2 }), -1)).toBe(3);
    expect(cycleSlot(makeLocal({ primary: -1, activeSlot: 3, he: 1 }), 1)).toBe(4);
  });
  it('touch pointers never drive the mouse path and mouse pointers never drive the touch layer', () => {
    r = rig();
    const req = vi.fn(); (r.canvas as unknown as { requestPointerLock: () => void }).requestPointerLock = req;
    const g = r.input.touch.geometry().fireR;
    pointer('pointerdown', 1, g.cx, g.cy, r.canvas, 'mouse'); pointer('pointerup', 1, g.cx, g.cy, r.canvas, 'mouse');
    expect(r.tick().buttons).toBe(0);
    expect(req).toHaveBeenCalledTimes(1); // the mouse click asked for the lock instead
    req.mockClear();
    pointer('pointerdown', 2, 400, 200, r.canvas, 'touch');
    expect(req).not.toHaveBeenCalled();
  });
});
