/** Shared jsdom helpers for the input tests: PointerEvent polyfill, fake viewport, snapshot local, InputSystem rig. */
import { createSnapshot, type SnapLocal } from '@/sim/state';
import { DEFAULT_CONTROLS, cloneLayout, type ControlSettings, type TouchLayout } from '@/settings/types';
import { InputSystem } from '@/input/inputSystem';

if (typeof (globalThis as { PointerEvent?: unknown }).PointerEvent === 'undefined') {
  class PointerEventPolyfill extends MouseEvent {
    readonly pointerId: number; readonly pointerType: string; readonly isPrimary: boolean;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1; this.pointerType = init.pointerType ?? 'mouse'; this.isPrimary = init.isPrimary ?? true;
    }
  }
  (globalThis as { PointerEvent?: unknown }).PointerEvent = PointerEventPolyfill;
}

export function setViewport(w = 851, h = 393): void {
  Object.defineProperty(window, 'innerWidth', { value: w, configurable: true, writable: true });
  Object.defineProperty(window, 'innerHeight', { value: h, configurable: true, writable: true });
}

export function makeLocal(over: Partial<SnapLocal> = {}): SnapLocal {
  const l = createSnapshot().local;
  Object.assign(l, { id: 1, alive: 1, hp: 100, weapon: 2, activeSlot: 2, mag: 12, reserve: 24, pistol: 2, primary: -1, eyeX: 0, eyeY: 1.65, eyeZ: 0 }, over);
  return l;
}

export function pct(xPct: number, yPct: number): { x: number; y: number } { return { x: (window.innerWidth * xPct) / 100, y: (window.innerHeight * yPct) / 100 }; }

export function pointer(type: string, id: number, x: number, y: number, target: EventTarget = document.body, pointerType = 'touch'): PointerEvent {
  const e = new PointerEvent(type, { pointerId: id, pointerType, clientX: x, clientY: y, bubbles: true, cancelable: true, button: 0, buttons: type === 'pointerup' ? 0 : 1 });
  target.dispatchEvent(e);
  return e;
}

export interface Rig { input: InputSystem; canvas: HTMLCanvasElement; ui: HTMLElement; ui_actions: { id: string; down?: boolean }[]; local: SnapLocal; tick: () => ReturnType<InputSystem['sample']>; cleanup: () => void }

/** Builds the DOM the app provides (#ui with #hud, canvas) and an attached InputSystem on Date.now (fake timers). */
export function rig(settings: Partial<ControlSettings> = {}, layout: TouchLayout = cloneLayout(), local: SnapLocal = makeLocal()): Rig {
  setViewport();
  document.body.innerHTML = '';
  const canvas = document.createElement('canvas'); canvas.id = 'gl';
  const ui = document.createElement('div'); ui.id = 'ui';
  const hud = document.createElement('div'); hud.id = 'hud';
  const screens = document.createElement('div'); screens.id = 'screens';
  ui.append(hud, screens);
  document.body.append(canvas, ui);
  const input = new InputSystem(canvas, { ...DEFAULT_CONTROLS, ...settings }, layout, { now: () => Date.now() });
  const ui_actions: { id: string; down?: boolean }[] = [];
  input.onUiAction((id, down) => ui_actions.push({ id, down }));
  input.attach();
  let n = 0;
  const r: Rig = { input, canvas, ui, ui_actions, local, tick: () => input.sample(++n, [], r.local), cleanup: () => { input.detach(); document.body.innerHTML = ''; } };
  r.tick();
  return r;
}

/** Dispatches a drag in `steps` moves, advancing fake time `stepMs` per move (≈ constant velocity). */
export function drag(id: number, x0: number, y0: number, dx: number, dy: number, steps: number, stepMs: number, advance: (ms: number) => void): void {
  for (let i = 1; i <= steps; i++) { advance(stepMs); pointer('pointermove', id, x0 + (dx * i) / steps, y0 + (dy * i) / steps); }
}
