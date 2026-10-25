/**
 * InputSystem (§7, §11.8): merges touch (touch.ts + joystick.ts + layout.ts), desktop keyboard/mouse
 * (keyboard.ts) and gyro (gyro.ts) into one InputCommand per tick. Look deltas accumulate between ticks in
 * radians (sens, FOV, scoped sens, acceleration) and are consumed by sample(); previewLook() shows the
 * not-yet-consumed delta through the same applyAimAssist (dt = 0). Presses are latched until the next sample().
 */
import { DEG, clamp, wrapAngle } from '../core/math';
import { Btn, IDLE_COMMAND, cloneCommand, type InputCommand, type AimCandidate, type SnapLocal, type LookPreview, type ItemId } from '../sim/state';
import type { ControlSettings, TouchLayout } from '../settings/types';
import { AWP_FOV } from '../weapons/defs';
import { applyAimAssist, autoFireStep, autoReloadStep, createAutoState } from './aimAssist';
import { TouchLayer, type UiActionId } from './touch';
import { DesktopInput } from './keyboard';
import { GyroInput } from './gyro';

export type { UiActionId } from './touch';

/** 0.022° per px at sens 1 (§7.4); pitch is 0.85 × yaw; mouse is 1/8 of touch. */
export const LOOK_DEG_PER_PX = 0.022;
export const PITCH_RATIO = 0.85;
export const MOUSE_DIVISOR = 8;
const PITCH_LIMIT = 89 * DEG;

export interface InputOptions { now?: () => number; uiRoot?: HTMLElement | null }

export class InputSystem {
  private look: LookPreview = { yaw: 0, pitch: 0 };
  private readonly pending = { yaw: 0, pitch: 0 };
  private dragged = false;
  private latched = 0;
  private slot: InputCommand['slot'] = 0; private grenade: InputCommand['grenade'] = 0;
  private buyItem: ItemId | null = null; private spectateDir: -1 | 0 | 1 = 0;
  private attached = false;
  private settings: ControlSettings;
  private layout: TouchLayout;
  private local: SnapLocal | null = null;
  private scoped: 0 | 1 | 2 = 0;
  private readonly auto = createAutoState();
  private uiHandler: ((id: UiActionId, down?: boolean) => void) | null = null;
  private readonly now: () => number;
  readonly touch: TouchLayer;
  readonly desktop: DesktopInput;
  readonly gyro = new GyroInput();

  constructor(private readonly root: HTMLElement, settings: ControlSettings, layout: TouchLayout, opts: InputOptions = {}) {
    this.settings = settings; this.layout = layout;
    this.now = opts.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    const host = opts.uiRoot ?? (typeof document !== 'undefined' ? document.getElementById('ui') : null) ?? root.parentElement ?? document.body;
    this.touch = new TouchLayer(host, layout, {
      local: () => this.local,
      settings: () => this.settings,
      look: (dx, dy) => this.addLookPx(dx, dy, 1),
      uiAction: (id, down) => this.emitUi(id, down),
      lookPointers: (n) => { this.gyro.active = this.settings.gyro === 'always' || (this.settings.gyro === 'drag' && n > 0); if (n === 0 && this.settings.gyro === 'drag') this.gyro.recentre(); },
      firstTouch: () => { if (this.settings.gyro !== 'off') this.gyro.requestPermission(); },
    }, this.now);
    this.desktop = new DesktopInput(root, {
      local: () => this.local,
      mouseLook: (dx, dy) => this.addLookPx(dx, dy, 1 / MOUSE_DIVISOR),
      uiAction: (id, down) => this.emitUi(id, down),
    }, this.now);
  }

  // ───────── look ─────────
  /** Radians per CSS px for the current sens / FOV / scope state (§7.4). */
  lookScale(): number {
    const s = this.settings;
    const sens = this.scoped ? s.sensScoped : s.sens;
    const fov = this.scoped ? AWP_FOV[this.scoped] : s.fovDeg;
    return LOOK_DEG_PER_PX * DEG * sens * (fov / 75);
  }

  private addLookPx(dx: number, dy: number, mult: number): void {
    const k = this.lookScale() * mult;
    this.pending.yaw -= dx * k;
    this.pending.pitch -= dy * k * PITCH_RATIO;
    this.dragged = true;
  }

  private pullGyro(): void {
    const g = this.gyro.consume();
    if (this.settings.gyro === 'off' || (g.yaw === 0 && g.pitch === 0)) return;
    this.pending.yaw += g.yaw * this.settings.gyroSens;
    this.pending.pitch += g.pitch * this.settings.gyroSens;
  }

  private assisted(candidates: AimCandidate[], local: SnapLocal, dt: number, strafing: boolean): { yaw: number; pitch: number } {
    const dragging = this.dragged || this.pending.yaw !== 0 || this.pending.pitch !== 0;
    return applyAimAssist(this.pending, this.look, { x: local.eyeX, y: local.eyeY, z: local.eyeZ }, local.alive === 1 ? candidates : [], this.settings.aimAssist, dt, dragging, strafing);
  }

  // ───────── per tick ─────────
  sample(tick: number, candidates: AimCandidate[], local: SnapLocal): InputCommand {
    this.noteLocal(local);
    this.pullGyro();
    const touchMove = this.touch.move();
    const keyMove = this.desktop.move();
    const move = touchMove.active ? touchMove : keyMove;
    const d = this.assisted(candidates, local, 1 / 60, Math.abs(move.x) > 1e-3);
    this.look.yaw = wrapAngle(this.look.yaw + d.yaw);
    this.look.pitch = clamp(this.look.pitch + d.pitch, -PITCH_LIMIT, PITCH_LIMIT);
    this.pending.yaw = 0; this.pending.pitch = 0; this.dragged = false;

    const c = cloneCommand(IDLE_COMMAND, tick);
    c.yaw = this.look.yaw; c.pitch = this.look.pitch;
    c.moveX = move.x; c.moveZ = move.z;
    let b = this.touch.heldBits() | this.touch.latched | this.desktop.held() | this.desktop.latched | this.latched;
    if (autoFireStep(this.auto, local, this.settings.autoFire)) b |= Btn.FIRE;
    if (autoReloadStep(this.auto, local, candidates.length, this.settings.autoReload)) b |= Btn.RELOAD;
    c.buttons = b;
    this.touch.latched = 0; this.desktop.latched = 0; this.latched = 0;
    c.slot = this.touch.slot || this.desktop.slot || this.slot; this.touch.slot = 0; this.desktop.slot = 0; this.slot = 0;
    c.grenade = this.touch.grenade || this.desktop.grenade || this.grenade; this.touch.grenade = 0; this.desktop.grenade = 0; this.grenade = 0;
    c.buy = this.buyItem; this.buyItem = null;
    c.spectate = this.touch.spectate || this.desktop.spectate || this.spectateDir; this.touch.spectate = 0; this.desktop.spectate = 0; this.spectateDir = 0;
    return c;
  }

  previewLook(candidates: AimCandidate[], local: SnapLocal): LookPreview {
    this.pullGyro();
    const touchMove = this.touch.move();
    const strafing = Math.abs(touchMove.active ? touchMove.x : this.desktop.move().x) > 1e-3;
    const d = this.assisted(candidates, local, 0, strafing);
    return { yaw: wrapAngle(this.look.yaw + d.yaw), pitch: clamp(this.look.pitch + d.pitch, -PITCH_LIMIT, PITCH_LIMIT) };
  }

  private noteLocal(local: SnapLocal): void {
    this.local = local;
    this.scoped = local.scoped;
    this.desktop.noteActiveSlot(local.activeSlot);
    if (this.attached) this.touch.update(local);
  }

  // ───────── UI → next command ─────────
  press(btn: number): void { this.latched |= btn; }
  setBuy(item: ItemId): void { this.buyItem = item; }
  spectate(dir: -1 | 1): void { this.spectateDir = dir; }
  selectSlot(slot: InputCommand['slot']): void { this.slot = slot; }
  selectGrenade(g: InputCommand['grenade']): void { this.grenade = g; }
  /** UI-originated actions the input layer cannot reach on its own (Buy pill, pause, B/Tab/Esc). */
  onUiAction(fn: (id: UiActionId, down?: boolean) => void): void { this.uiHandler = fn; }
  private emitUi(id: UiActionId, down?: boolean): void { this.uiHandler?.(id, down); }
  /** Desktop: leave pointer lock without the lock-loss pause (call when a modal screen opens). */
  releasePointer(): void { this.desktop.releaseLock(); }
  /** Optional: forces the Use pill (1 plant, 2 defuse, 3 pick up) when the app knows an action is available. */
  setUseHint(a: 0 | 1 | 2 | 3): void { this.touch.setUseHint(a); }

  // ───────── configuration ─────────
  setLayout(l: TouchLayout): void { this.layout = l; this.touch.setLayout(l); }
  getLayout(): TouchLayout { return this.layout; }
  setSettings(s: ControlSettings): void {
    this.settings = s;
    if (this.attached && s.gyro !== 'off') { this.gyro.start(); this.gyro.active = s.gyro === 'always'; } else this.gyro.stop();
  }
  getSettings(): ControlSettings { return this.settings; }
  setTouchVisible(b: boolean): void { this.touch.setUserVisible(b); }
  isTouchVisible(): boolean { return this.touch.userEnabled; }
  gyroAvailable(): boolean { return GyroInput.available(); }
  setLook(yaw: number, pitch: number): void { this.look.yaw = wrapAngle(yaw); this.look.pitch = clamp(pitch, -PITCH_LIMIT, PITCH_LIMIT); this.pending.yaw = 0; this.pending.pitch = 0; this.gyro.consume(); }
  getLook(): LookPreview { return { yaw: this.look.yaw, pitch: this.look.pitch }; }

  attach(): void {
    if (this.attached) return; this.attached = true;
    this.root.style.touchAction = 'none';
    this.touch.attach(); this.desktop.attach();
    if (this.local) this.touch.update(this.local);
    this.setSettings(this.settings);
  }
  detach(): void {
    if (!this.attached) return; this.attached = false;
    this.touch.detach(); this.desktop.detach(); this.gyro.stop();
    this.latched = 0; this.pending.yaw = 0; this.pending.pitch = 0; this.dragged = false;
    this.slot = 0; this.grenade = 0; this.buyItem = null; this.spectateDir = 0;
    Object.assign(this.auto, createAutoState());
  }
  get isAttached(): boolean { return this.attached; }
}

/** Replays a command log (golden tests, e2e). */
export class ScriptedInput {
  private i = 0;
  constructor(private readonly log: InputCommand[]) {}
  sample(tick: number): InputCommand { const c = this.log[Math.min(this.i++, this.log.length - 1)] ?? IDLE_COMMAND; return cloneCommand(c, tick); }
  reset(): void { this.i = 0; }
}
