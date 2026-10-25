/**
 * Desktop fallback (§7.7): WASD, Shift walk, Ctrl crouch (hold), Space jump, R reload, Q last weapon, 1–4 slots
 * (4 again swaps HE/flash), G drop, E use, B buy, Tab scoreboard (hold), Esc pause, ←/→ spectate; mouse look under
 * Pointer Lock, LMB fire (= THROW while slot 4 is active), RMB scope, wheel cycles weapons.
 */
import { Btn, type InputCommand, type SnapLocal } from '../sim/state';
import { isGameSurface, type UiActionId } from './touch';

export interface DesktopSink {
  local(): SnapLocal | null;
  mouseLook(dx: number, dy: number): void;
  uiAction(id: UiActionId, down?: boolean): void;
}

type SlotReq = InputCommand['slot'];

/** Next / previous owned slot for the wheel (1 primary, 2 pistol, 3 knife, 4 grenade). */
export function cycleSlot(local: SnapLocal | null, dir: 1 | -1): SlotReq {
  const owned: number[] = [];
  if (!local || local.primary >= 0) owned.push(1);
  owned.push(2, 3);
  if (local && local.he + local.flash > 0) owned.push(4);
  const cur = local ? local.activeSlot : 2;
  const i = owned.indexOf(cur);
  const n = owned.length;
  return owned[i < 0 ? 0 : (i + dir + n) % n] as SlotReq;
}

export class DesktopInput {
  latched = 0;
  slot: SlotReq = 0;
  grenade: InputCommand['grenade'] = 0;
  spectate: -1 | 0 | 1 = 0;
  private mouseBits = 0;
  /** Physical button mask (1 LMB, 2 RMB) as last seen; `armed` = the subset pressed while locked (drives mouseBits). */
  private mouseMask = 0; private armed = 0;
  private fireBit: number = Btn.FIRE;
  private readonly keys = new Set<string>();
  private locked = false;
  private attached = false;
  private intentionalUnlock = false;
  private lastSlot: number = 0; private curSlot: number = 0;
  private lastWheelT = -1e9; private lastPauseT = -1e9;

  private readonly onKeyDown = (e: KeyboardEvent) => {
    if (isTextField(e.target)) return;
    if (e.code === 'Tab' || e.code === 'Space' || e.code === 'F1') e.preventDefault();
    if (e.repeat) return;
    this.keys.add(e.code);
    this.keyPress(e.code);
  };
  private readonly onKeyUp = (e: KeyboardEvent) => {
    this.keys.delete(e.code);
    if (e.code === 'Tab') this.sink.uiAction('scoreboard', false);
  };
  private readonly onBlur = () => { this.keys.clear(); this.mouseBits = 0; this.armed = 0; this.mouseMask = 0; };
  private readonly onPointerDown = (e: PointerEvent) => {
    if (e.pointerType !== 'mouse') return;
    if (!this.locked && e.button === 0 && isGameSurface(e.target) && !e.defaultPrevented) this.requestLock(); // the locking click does not fire
    this.syncButtons(e);
  };
  /**
   * Chorded presses (Pointer Events): only the first button down fires pointerdown and only the last one up fires
   * pointerup; the others arrive as pointermove. Held bits are therefore derived from `e.buttons` on every event.
   */
  private readonly onPointerMoveOrUp = (e: PointerEvent) => { if (e.pointerType === 'mouse') this.syncButtons(e); };
  private readonly onMouseMove = (e: MouseEvent) => { if (this.locked && (e.movementX || e.movementY)) this.sink.mouseLook(e.movementX, e.movementY); };
  private readonly onWheel = (e: WheelEvent) => {
    if (!this.locked && !isGameSurface(e.target)) return;
    const t = this.now();
    if (t - this.lastWheelT < 90 || e.deltaY === 0) return;
    this.lastWheelT = t;
    this.slot = cycleSlot(this.sink.local(), e.deltaY > 0 ? 1 : -1);
  };
  private readonly onContextMenu = (e: Event) => { if (this.locked || isGameSurface(e.target)) e.preventDefault(); };
  private readonly onLockChange = () => {
    const was = this.locked;
    this.locked = document.pointerLockElement === this.root;
    if (was && !this.locked) {
      this.mouseBits = 0; this.armed = 0;
      if (!this.intentionalUnlock && this.attached) this.pause();
      this.intentionalUnlock = false;
    }
  };

  constructor(private readonly root: HTMLElement, private readonly sink: DesktopSink, private readonly now: () => number) {}

  get pointerLocked(): boolean { return this.locked; }

  attach(): void {
    if (this.attached) return; this.attached = true;
    window.addEventListener('keydown', this.onKeyDown); window.addEventListener('keyup', this.onKeyUp); window.addEventListener('blur', this.onBlur);
    window.addEventListener('pointerdown', this.onPointerDown); window.addEventListener('pointerup', this.onPointerMoveOrUp); window.addEventListener('pointermove', this.onPointerMoveOrUp);
    window.addEventListener('mousemove', this.onMouseMove); window.addEventListener('wheel', this.onWheel, { passive: true });
    window.addEventListener('contextmenu', this.onContextMenu);
    document.addEventListener('pointerlockchange', this.onLockChange);
  }

  detach(): void {
    if (!this.attached) return; this.attached = false;
    window.removeEventListener('keydown', this.onKeyDown); window.removeEventListener('keyup', this.onKeyUp); window.removeEventListener('blur', this.onBlur);
    window.removeEventListener('pointerdown', this.onPointerDown); window.removeEventListener('pointerup', this.onPointerMoveOrUp); window.removeEventListener('pointermove', this.onPointerMoveOrUp);
    window.removeEventListener('mousemove', this.onMouseMove); window.removeEventListener('wheel', this.onWheel);
    window.removeEventListener('contextmenu', this.onContextMenu);
    document.removeEventListener('pointerlockchange', this.onLockChange);
    this.releaseLock();
    this.locked = false; this.keys.clear(); this.mouseBits = 0; this.armed = 0; this.mouseMask = 0; this.latched = 0; this.slot = 0; this.grenade = 0; this.spectate = 0;
  }

  /** Frees the mouse (modal screens) without the lock-loss pause. */
  releaseLock(): void { if (this.locked) { this.intentionalUnlock = true; document.exitPointerLock?.(); } }

  /** Tracks the active slot for Q (last weapon). */
  noteActiveSlot(slot: number): void { if (slot !== this.curSlot) { if (this.curSlot) this.lastSlot = this.curSlot; this.curSlot = slot; } }

  move(): { x: number; z: number } {
    let x = 0, z = 0;
    if (this.keys.has('KeyW')) z += 1; if (this.keys.has('KeyS')) z -= 1; if (this.keys.has('KeyD')) x += 1; if (this.keys.has('KeyA')) x -= 1;
    const len = Math.hypot(x, z); if (len > 1) { x /= len; z /= len; }
    return { x, z };
  }

  held(): number {
    let b = this.mouseBits;
    const k = this.keys;
    if (k.has('Space')) b |= Btn.JUMP;
    if (k.has('ControlLeft') || k.has('ControlRight')) b |= Btn.CROUCH;
    if (k.has('ShiftLeft') || k.has('ShiftRight')) b |= Btn.WALK;
    if (k.has('KeyE')) b |= Btn.USE;
    if (k.has('KeyR')) b |= Btn.RELOAD;
    return b;
  }

  private keyPress(code: string): void {
    const local = this.sink.local();
    switch (code) {
      case 'Space': this.latched |= Btn.JUMP; break;
      case 'KeyR': this.latched |= Btn.RELOAD; break;
      case 'KeyE': this.latched |= Btn.USE; break;
      case 'KeyG': this.latched |= Btn.DROP; break;
      case 'ControlLeft': case 'ControlRight': this.latched |= Btn.CROUCH; break;
      case 'KeyQ': if (this.lastSlot) this.slot = this.lastSlot as SlotReq; break;
      case 'Digit1': this.slot = 1; break;
      case 'Digit2': this.slot = 2; break;
      case 'Digit3': this.slot = 3; break;
      case 'Digit4':
        if (local && local.activeSlot === 4 && local.he > 0 && local.flash > 0) this.grenade = local.selectedGrenade === 0 ? 2 : 1;
        else this.slot = 4;
        break;
      case 'KeyB': this.releaseLock(); this.sink.uiAction('openBuy'); break;
      case 'Tab': this.sink.uiAction('scoreboard', true); break;
      case 'Escape': this.pause(); break;
      case 'ArrowLeft': this.spectate = -1; break;
      case 'ArrowRight': this.spectate = 1; break;
    }
  }

  /** LMB = FIRE (THROW while slot 4 is active, fixed at the press), RMB = SCOPE; rising edges are latched. */
  private syncButtons(e: PointerEvent): void {
    const bit = e.button === 0 ? 1 : e.button === 2 ? 2 : 0;
    let mask = (e.buttons ?? 0) & 3;
    let prev = this.mouseMask;
    if (e.type === 'pointerdown') { mask |= bit; prev &= ~bit; }   // a pointerdown is always a fresh press of e.button
    else if (e.type === 'pointerup') mask &= ~bit;
    this.mouseMask = mask;
    const rise = mask & ~prev;
    this.armed &= mask;
    if (this.locked && rise) {
      if (rise & 1) { const local = this.sink.local(); this.fireBit = local && local.activeSlot === 4 ? Btn.THROW : Btn.FIRE; this.latched |= this.fireBit; }
      if (rise & 2) this.latched |= Btn.SCOPE;
      this.armed |= rise;
    }
    this.mouseBits = (this.armed & 1 ? this.fireBit : 0) | (this.armed & 2 ? Btn.SCOPE : 0);
  }

  private pause(): void {
    const t = this.now();
    if (t - this.lastPauseT < 300) return;
    this.lastPauseT = t;
    this.sink.uiAction('pause');
  }

  private requestLock(): void {
    try { const r = this.root.requestPointerLock?.() as unknown; if (r && typeof (r as Promise<void>).catch === 'function') (r as Promise<void>).catch(() => undefined); } catch { /* unsupported */ }
  }
}

function isTextField(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  return !!el && typeof el.tagName === 'string' && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable === true);
}
