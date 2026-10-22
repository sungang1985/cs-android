/**
 * InputSystem (§11.8). DAY-0 STUB: desktop keyboard + mouse (pointer lock) only, no touch layer, so the app is
 * playable on a laptop and e2e tests can drive it with setInput. L7 implements touch/joystick/gyro/aim assist.
 */
import { DEG, clamp, wrapAngle } from '../core/math';
import { Btn, IDLE_COMMAND, cloneCommand, type InputCommand, type AimCandidate, type SnapLocal, type LookPreview, type ItemId } from '../sim/state';
import type { ControlSettings, TouchLayout } from '../settings/types';
import { applyAimAssist } from './aimAssist';

export class InputSystem {
  private look: LookPreview = { yaw: 0, pitch: 0 };
  private pendingDelta = { yaw: 0, pitch: 0 };
  private held = 0; private latched = 0;
  private slot: InputCommand['slot'] = 0; private grenade: InputCommand['grenade'] = 0;
  private buyItem: ItemId | null = null; private spectateDir: -1 | 0 | 1 = 0;
  private keys = new Set<string>();
  private attached = false;
  private pointerLocked = false;
  private touchVisible = true;
  private settings: ControlSettings;
  private layout: TouchLayout;
  private readonly onKeyDown = (e: KeyboardEvent) => { if (e.repeat) return; this.keys.add(e.code); this.keyPress(e.code); };
  private readonly onKeyUp = (e: KeyboardEvent) => { this.keys.delete(e.code); };
  private readonly onMouseMove = (e: MouseEvent) => { if (!this.pointerLocked) return; const k = (0.022 * DEG * this.settings.sens) / 8; this.pendingDelta.yaw -= e.movementX * k; this.pendingDelta.pitch -= e.movementY * k * 0.85; };
  private readonly onMouseDown = (e: MouseEvent) => { if (!this.pointerLocked) { this.root.requestPointerLock?.(); return; } if (e.button === 0) { this.held |= Btn.FIRE; this.latched |= Btn.FIRE; } if (e.button === 2) { this.held |= Btn.SCOPE; this.latched |= Btn.SCOPE; } };
  private readonly onMouseUp = (e: MouseEvent) => { if (e.button === 0) this.held &= ~Btn.FIRE; if (e.button === 2) this.held &= ~Btn.SCOPE; };
  private readonly onLockChange = () => { this.pointerLocked = document.pointerLockElement === this.root; };
  private readonly onWheel = (e: WheelEvent) => { this.slot = (e.deltaY > 0 ? 2 : 1) as InputCommand['slot']; };

  constructor(private readonly root: HTMLElement, settings: ControlSettings, layout: TouchLayout) { this.settings = settings; this.layout = layout; }

  private keyPress(code: string): void {
    switch (code) {
      case 'Space': this.latched |= Btn.JUMP; break;
      case 'KeyR': this.latched |= Btn.RELOAD; break;
      case 'KeyE': this.latched |= Btn.USE; break;
      case 'KeyG': this.latched |= Btn.DROP; break;
      case 'Digit1': this.slot = 1; break; case 'Digit2': this.slot = 2; break; case 'Digit3': this.slot = 3; break; case 'Digit4': this.slot = 4; break;
      case 'ArrowLeft': this.spectateDir = -1; break; case 'ArrowRight': this.spectateDir = 1; break;
    }
  }

  private heldFromKeys(): number {
    let b = this.held;
    if (this.keys.has('Space')) b |= Btn.JUMP;
    if (this.keys.has('ControlLeft') || this.keys.has('ControlRight')) b |= Btn.CROUCH;
    if (this.keys.has('ShiftLeft') || this.keys.has('ShiftRight')) b |= Btn.WALK;
    if (this.keys.has('KeyE')) b |= Btn.USE;
    if (this.keys.has('KeyR')) b |= Btn.RELOAD;
    return b;
  }

  private consumeLook(candidates: AimCandidate[], local: SnapLocal, dt: number): void {
    const d = applyAimAssist(this.pendingDelta, this.look, { x: local.eyeX, y: local.eyeY, z: local.eyeZ }, candidates, this.settings.aimAssist, dt, this.pendingDelta.yaw !== 0 || this.pendingDelta.pitch !== 0, false);
    this.look.yaw = wrapAngle(this.look.yaw + d.yaw);
    this.look.pitch = clamp(this.look.pitch + d.pitch, -89 * DEG, 89 * DEG);
    this.pendingDelta.yaw = 0; this.pendingDelta.pitch = 0;
  }

  sample(tick: number, candidates: AimCandidate[], local: SnapLocal): InputCommand {
    this.consumeLook(candidates, local, 1 / 60);
    const c = cloneCommand(IDLE_COMMAND, tick);
    c.yaw = this.look.yaw; c.pitch = this.look.pitch;
    let mx = 0, mz = 0;
    if (this.keys.has('KeyW')) mz += 1; if (this.keys.has('KeyS')) mz -= 1; if (this.keys.has('KeyD')) mx += 1; if (this.keys.has('KeyA')) mx -= 1;
    const len = Math.hypot(mx, mz); if (len > 1) { mx /= len; mz /= len; }
    c.moveX = mx; c.moveZ = mz;
    c.buttons = this.heldFromKeys() | this.latched; this.latched = 0;
    c.slot = this.slot; this.slot = 0; c.grenade = this.grenade; this.grenade = 0;
    c.buy = this.buyItem; this.buyItem = null; c.spectate = this.spectateDir; this.spectateDir = 0;
    return c;
  }

  previewLook(candidates: AimCandidate[], local: SnapLocal): LookPreview {
    const d = applyAimAssist(this.pendingDelta, this.look, { x: local.eyeX, y: local.eyeY, z: local.eyeZ }, candidates, this.settings.aimAssist, 0, this.pendingDelta.yaw !== 0, false);
    return { yaw: wrapAngle(this.look.yaw + d.yaw), pitch: clamp(this.look.pitch + d.pitch, -89 * DEG, 89 * DEG) };
  }

  press(btn: number): void { this.latched |= btn; }
  setBuy(item: ItemId): void { this.buyItem = item; }
  spectate(dir: -1 | 1): void { this.spectateDir = dir; }
  selectSlot(slot: InputCommand['slot']): void { this.slot = slot; }
  selectGrenade(g: InputCommand['grenade']): void { this.grenade = g; }
  setLayout(l: TouchLayout): void { this.layout = l; }
  getLayout(): TouchLayout { return this.layout; }
  setSettings(s: ControlSettings): void { this.settings = s; }
  setTouchVisible(b: boolean): void { this.touchVisible = b; }
  isTouchVisible(): boolean { return this.touchVisible; }
  setLook(yaw: number, pitch: number): void { this.look.yaw = yaw; this.look.pitch = pitch; this.pendingDelta.yaw = 0; this.pendingDelta.pitch = 0; }
  getLook(): LookPreview { return { yaw: this.look.yaw, pitch: this.look.pitch }; }
  attach(): void {
    if (this.attached) return; this.attached = true;
    window.addEventListener('keydown', this.onKeyDown); window.addEventListener('keyup', this.onKeyUp);
    this.root.addEventListener('mousemove', this.onMouseMove); this.root.addEventListener('mousedown', this.onMouseDown); window.addEventListener('mouseup', this.onMouseUp);
    document.addEventListener('pointerlockchange', this.onLockChange); this.root.addEventListener('wheel', this.onWheel, { passive: true });
    this.root.addEventListener('contextmenu', (e) => e.preventDefault());
  }
  detach(): void {
    if (!this.attached) return; this.attached = false;
    window.removeEventListener('keydown', this.onKeyDown); window.removeEventListener('keyup', this.onKeyUp);
    this.root.removeEventListener('mousemove', this.onMouseMove); this.root.removeEventListener('mousedown', this.onMouseDown); window.removeEventListener('mouseup', this.onMouseUp);
    document.removeEventListener('pointerlockchange', this.onLockChange); this.root.removeEventListener('wheel', this.onWheel);
    this.keys.clear(); this.held = 0;
  }
}

/** Replays a command log (golden tests, e2e). */
export class ScriptedInput {
  private i = 0;
  constructor(private readonly log: InputCommand[]) {}
  sample(tick: number): InputCommand { const c = this.log[Math.min(this.i++, this.log.length - 1)] ?? IDLE_COMMAND; return cloneCommand(c, tick); }
  reset(): void { this.i = 0; }
}
