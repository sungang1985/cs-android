/**
 * Touch layer (§7.1–7.3): a purely visual overlay of every TouchLayout control plus coordinate-based pointer
 * ownership on window-level listeners (so the overlay never blocks UI elements): on pointerdown the pointer goes
 * to (1) the visible button whose hit disc (incl. 3 vh margin; nearest centre on overlap) contains it, (2) the
 * floating joystick zone, (3) the look zone; the inert top-left HUD band is ignored. Fire-R/Fire-L are fire + look.
 * Presses are latched until the next sample() so a 10 ms tap never drops a shot. Gestures: tap-to-fire,
 * double-tap jump, two-finger tap reload, pinch scope, spectator swipe.
 *
 * Styling hooks for the UI lane (all default rules use :where(), i.e. zero specificity, so any rule overrides):
 *   .cs-touch (root, opacity = layout.opacity) · .cs-touch-ctl + .cs-touch-<ControlId> (one per button,
 *   data-testid="touch-<ControlId>") · .cs-touch-pill (use, buy) · .cs-touch-icon / .cs-touch-label (contents) ·
 *   .is-held (pressed) · .is-on (crouch toggled) · .is-pulsing (buy) · .cs-touch-joy (.is-active while dragging)
 *   with .cs-touch-joy-ring / .cs-touch-joy-knob (data-testid="touch-joystick").
 * UI elements that must not start a look/joystick pointer: be a button/link/input, live inside `.screen`, carry
 * `data-touch-ignore`, or call preventDefault() on their pointerdown.
 */
import { clamp } from '../core/math';
import { Btn, WEAPON_INDEX, type InputCommand, type SnapLocal } from '../sim/state';
import type { ControlId, ControlSettings, TouchLayout } from '../settings/types';
import { t } from '../i18n/i18n';
import { BUTTON_IDS, PILL_WIDTH_PCT, computeGeometry, hitTest, joystickMetrics, viewportOf, zoneAt, type ControlGeom, type Viewport } from './layout';
import { FloatingJoystick } from './joystick';

export type UiActionId = 'openBuy' | 'pause' | 'skipRound' | 'scoreboard' | 'spectatePrev' | 'spectateNext';

export interface TouchSink {
  local(): SnapLocal | null;
  settings(): ControlSettings;
  /** Look delta in CSS px, acceleration already applied. */
  look(dxPx: number, dyPx: number): void;
  uiAction(id: UiActionId, down?: boolean): void;
  /** Number of look-owning pointers changed (gyro gate / recentre). */
  lookPointers(n: number): void;
  /** First touch of the session (gyro permission prompt needs a gesture). */
  firstTouch(): void;
}

export const TAP_MS = 150, TAP_PX = 8, DOUBLE_TAP_MS = 300, DOUBLE_TAP_PX = 40, TWO_FINGER_MS = 250, PINCH_PX = 40, SWIPE_PX = 60, SWIPE_MS = 600;
const AWP_INDEX = WEAPON_INDEX.indexOf('awp');
const IGNORE_SELECTOR = 'button, a, input, select, textarea, label, [role="button"], [data-touch-ignore], .screen';
const HOLD_BITS: Partial<Record<ControlId, number>> = { fireR: Btn.FIRE, fireL: Btn.FIRE, jump: Btn.JUMP, grenade: Btn.THROW, use: Btn.USE };
const USE_KEYS = ['', 'hud.plant', 'hud.defuse', 'hud.pickup'];
/** Shown before the first snapshot arrives (alive defaults). */
const DEFAULT_VISIBLE: readonly ControlId[] = ['fireR', 'fireL', 'jump', 'crouch', 'reload', 'switch', 'pause'];
const ICONS: Partial<Record<ControlId, string>> = { fireR: '◎', fireL: '◎', jump: '⤒', crouch: '⤓', reload: '↻', switch: '⇄', scope: '⌖', grenade: '◉', grenadeSelect: '⇅', pause: '‖' };

/** §7.4 acceleration: 1 + 0.6 · clamp((v − 400) / 800, 0, 1), v in CSS px/s. */
export function accelFactor(v: number): number { return 1 + 0.6 * clamp((v - 400) / 800, 0, 1); }

/** True when a pointer on `target` belongs to the game (not to a UI control or a menu screen). */
export function isGameSurface(target: EventTarget | null): boolean {
  const el = target as Element | null;
  if (!el || typeof (el as Element).closest !== 'function') return true;
  return el.closest(IGNORE_SELECTOR) === null;
}

/** Switch button: primary → pistol → knife → primary (§7.2); returns the slot to request. */
export function nextSwitchSlot(local: SnapLocal | null): InputCommand['slot'] {
  if (!local) return 2;
  const hasPrimary = local.primary >= 0;
  switch (local.activeSlot) { case 1: return 2; case 2: return 3; default: return hasPrimary ? 1 : 2; }
}

type PtrKind = 'control' | 'joystick' | 'look';
interface Group { members: Ptr[]; ended: number; allTaps: boolean; pinched: boolean; d0: number }
interface Ptr { id: number; kind: PtrKind; control: ControlId | null; x0: number; y0: number; x: number; y: number; t0: number; tLast: number; maxDist: number; raw: boolean; v: number; group: Group | null }

export class TouchLayer {
  readonly root: HTMLDivElement;
  latched = 0;
  slot: InputCommand['slot'] = 0;
  grenade: InputCommand['grenade'] = 0;
  spectate: -1 | 0 | 1 = 0;
  private crouchToggled = false;
  private readonly ptrs = new Map<number, Ptr>();
  private readonly joy = new FloatingJoystick();
  private readonly els = {} as Record<ControlId, HTMLDivElement>;
  private readonly labels = {} as Record<ControlId, HTMLSpanElement>;
  private readonly joyEl: HTMLDivElement; private readonly ringEl: HTMLDivElement; private readonly knobEl: HTMLDivElement;
  private readonly vis = {} as Record<ControlId, boolean>;
  private readonly labelText = {} as Record<ControlId, string>;
  private layout: TouchLayout;
  private vp: Viewport = { left: 0, top: 0, width: 851, height: 393 };
  private geom = {} as Record<ControlId, ControlGeom>;
  private joyMetrics = { ringR: 0, knobR: 0, maxTravel: 1 };
  private attached = false;
  private userVisible = true;
  private autoHidden = false;
  private touched = false;
  private lookCount = 0;
  private useHint: 0 | 1 | 2 | 3 = 0;
  private lastTap = { t: -1e9, x: 0, y: 0 };
  private mq: MediaQueryList | null = null;

  private readonly onDown = (e: PointerEvent) => this.handleDown(e);
  private readonly onMove = (e: PointerEvent) => this.handleMove(e, false);
  private readonly onRaw = (e: PointerEvent) => this.handleMove(e, true);
  private readonly onUp = (e: PointerEvent) => this.handleUp(e, false);
  private readonly onCancel = (e: PointerEvent) => this.handleUp(e, true);
  private readonly onResize = () => this.relayout();
  private readonly onMq = () => { this.autoHidden = !!this.mq?.matches && !this.touched; this.applyVisible(); };

  constructor(private readonly host: HTMLElement, layout: TouchLayout, private readonly sink: TouchSink, private readonly now: () => number) {
    this.layout = layout;
    ensureStyle();
    const root = div('cs-touch');
    root.setAttribute('data-testid', 'touch-layer');
    root.style.cssText = 'position:fixed;top:env(safe-area-inset-top,0px);bottom:env(safe-area-inset-bottom,0px);left:calc(env(safe-area-inset-left,0px) + var(--cutout-left,0px));right:calc(env(safe-area-inset-right,0px) + var(--cutout-right,0px));pointer-events:none;touch-action:none;user-select:none;-webkit-user-select:none;';
    this.root = root;
    for (const id of BUTTON_IDS) {
      const el = div(`cs-touch-ctl cs-touch-${id}${PILL_WIDTH_PCT[id] !== undefined ? ' cs-touch-pill' : ''}`);
      el.setAttribute('data-testid', `touch-${id}`); el.setAttribute('data-control', id);
      const icon = document.createElement('span'); icon.className = 'cs-touch-icon'; icon.textContent = ICONS[id] ?? '';
      const label = document.createElement('span'); label.className = 'cs-touch-label';
      el.append(icon, label);
      root.append(el);
      this.els[id] = el; this.labels[id] = label; this.vis[id] = DEFAULT_VISIBLE.includes(id); this.labelText[id] = '';
      el.style.display = this.vis[id] ? '' : 'none';
    }
    this.joyEl = div('cs-touch-joy'); this.joyEl.setAttribute('data-testid', 'touch-joystick');
    this.ringEl = div('cs-touch-joy-ring'); this.knobEl = div('cs-touch-joy-knob');
    this.joyEl.append(this.ringEl, this.knobEl);
    root.append(this.joyEl);
  }

  attach(): void {
    if (this.attached) return; this.attached = true;
    const parent = this.host;
    const anchor = parent.querySelector(':scope > #hud, :scope > [data-testid="hud"]');
    const screens = parent.querySelector(':scope > #screens');
    if (anchor && anchor.nextSibling) parent.insertBefore(this.root, anchor.nextSibling);
    else if (screens) parent.insertBefore(this.root, screens);
    else parent.append(this.root);
    const opts: AddEventListenerOptions = { passive: false };
    window.addEventListener('pointerdown', this.onDown, opts);
    window.addEventListener('pointermove', this.onMove, opts);
    if ('onpointerrawupdate' in window) window.addEventListener('pointerrawupdate' as 'pointermove', this.onRaw, opts);
    window.addEventListener('pointerup', this.onUp, opts);
    window.addEventListener('pointercancel', this.onCancel, opts);
    window.addEventListener('resize', this.onResize);
    window.addEventListener('orientationchange', this.onResize);
    this.mq = typeof window.matchMedia === 'function' ? window.matchMedia('(pointer: fine)') : null;
    this.mq?.addEventListener?.('change', this.onMq);
    this.autoHidden = !!this.mq?.matches && !this.touched;
    this.applyVisible();
    this.relayout();
  }

  detach(): void {
    if (!this.attached) return; this.attached = false;
    window.removeEventListener('pointerdown', this.onDown);
    window.removeEventListener('pointermove', this.onMove);
    window.removeEventListener('pointerrawupdate' as 'pointermove', this.onRaw);
    window.removeEventListener('pointerup', this.onUp);
    window.removeEventListener('pointercancel', this.onCancel);
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('orientationchange', this.onResize);
    this.mq?.removeEventListener?.('change', this.onMq);
    this.root.remove();
    this.reset();
  }

  reset(): void {
    this.ptrs.clear(); this.joy.end(); this.latched = 0; this.slot = 0; this.grenade = 0; this.spectate = 0; this.crouchToggled = false;
    for (const id of BUTTON_IDS) this.els[id].classList.remove('is-held');
    this.setLookCount(0); this.renderJoy();
  }

  get isAttached(): boolean { return this.attached; }
  get visible(): boolean { return this.userVisible && !this.autoHidden; }
  get userEnabled(): boolean { return this.userVisible; }
  setUserVisible(b: boolean): void { this.userVisible = b; if (!b) this.reset(); this.applyVisible(); }
  setLayout(l: TouchLayout): void { this.layout = l; this.relayout(); }
  setUseHint(a: 0 | 1 | 2 | 3): void { this.useHint = a; }
  /** Control currently visible (hit-testable). */
  isControlVisible(id: ControlId): boolean { return !!this.vis[id]; }
  geometry(): Record<ControlId, ControlGeom> { return this.geom; }
  viewport(): Viewport { return this.vp; }

  /** Held bits from the pointers that are down (+ the crouch toggle). */
  heldBits(): number {
    let b = 0;
    const hold = this.sink.settings().crouchMode === 'hold';
    for (const p of this.ptrs.values()) {
      if (p.kind !== 'control' || !p.control) continue;
      b |= HOLD_BITS[p.control] ?? 0;
      if (p.control === 'crouch' && hold) b |= Btn.CROUCH;
    }
    if (!hold && this.crouchToggled) b |= Btn.CROUCH;
    return b;
  }

  move(): { x: number; z: number; active: boolean } {
    const o = this.joy.output(this.joyMetrics.maxTravel);
    return { x: o.moveX, z: o.moveZ, active: this.joy.active };
  }

  /** Contextual visibility and labels from the latest snapshot (called by sample()). */
  update(local: SnapLocal): void {
    const alive = local.alive === 1;
    if (!alive) this.crouchToggled = false;
    const useAction = local.useAction || this.useHint || (local.hasBomb ? 1 : 0);
    this.setVis('fireR', alive); this.setVis('fireL', alive); this.setVis('jump', alive); this.setVis('crouch', alive);
    this.setVis('reload', alive); this.setVis('switch', alive); this.setVis('scope', alive && local.weapon === AWP_INDEX);
    this.setVis('grenade', alive && local.he + local.flash > 0); this.setVis('grenadeSelect', alive && local.he > 0 && local.flash > 0);
    this.setVis('use', alive && (local.hasBomb === 1 || local.useAction !== 0 || this.useHint !== 0)); this.setVis('buy', local.canBuy === 1); this.setVis('pause', true);
    this.setLabel('use', useAction ? t(USE_KEYS[useAction]) : '');
    this.setLabel('buy', t('menu.buy'));
    const next = nextSwitchSlot(local);
    const nextId = next === 1 ? WEAPON_INDEX[local.primary] : next === 2 ? WEAPON_INDEX[local.pistol] : 'knife';
    this.setLabel('switch', nextId ? t('weapon.' + nextId) : '');
    this.setLabel('grenade', String(local.selectedGrenade === 0 ? local.he : local.flash));
    this.setLabel('grenadeSelect', t(local.selectedGrenade === 0 ? 'weapon.flash' : 'weapon.he'));
    this.els.crouch.classList.toggle('is-on', this.crouchToggled);
    this.els.buy.classList.toggle('is-pulsing', local.canBuy === 1);
  }

  // ───────── pointer handling ─────────
  private handleDown(e: PointerEvent): void {
    if (!this.attached || !this.userVisible || e.pointerType === 'mouse') return;
    if (e.defaultPrevented || !isGameSurface(e.target) || this.ptrs.has(e.pointerId)) return;
    if (!this.touched) { this.touched = true; if (this.autoHidden) { this.autoHidden = false; this.applyVisible(); this.relayout(); } this.sink.firstTouch(); }
    const x = e.clientX, y = e.clientY, now = this.now();
    const ctl = hitTest(this.geom, (id) => this.vis[id], x, y);
    let kind: PtrKind;
    if (ctl) kind = 'control';
    else {
      const z = zoneAt(this.layout, this.vp, x, y);
      if (z === 'inert') return;
      kind = z === 'joystick' && !this.joy.active ? 'joystick' : 'look';
    }
    if (e.cancelable) e.preventDefault();
    try { (e.target as Element | null)?.setPointerCapture?.(e.pointerId); } catch { /* not capturable */ }
    const p: Ptr = { id: e.pointerId, kind, control: ctl, x0: x, y0: y, x, y, t0: now, tLast: now, maxDist: 0, raw: false, v: 0, group: null };
    this.ptrs.set(p.id, p);
    if (kind === 'control') this.press(ctl!);
    else if (kind === 'joystick') { this.joy.start(p.id, x, y); this.renderJoy(); }
    else this.joinGroup(p);
    this.countLook();
  }

  private handleMove(e: PointerEvent, raw: boolean): void {
    const p = this.ptrs.get(e.pointerId); if (!p) return;
    if (raw) p.raw = true; else if (p.raw) return;
    const x = e.clientX, y = e.clientY, dx = x - p.x, dy = y - p.y;
    if (dx === 0 && dy === 0) return;
    if (e.cancelable && !raw) e.preventDefault();
    const now = this.now();
    const dt = clamp((now - p.tLast) / 1000, 0.004, 0.1);
    const vi = Math.hypot(dx, dy) / dt;
    p.v = p.v > 0 ? 0.5 * p.v + 0.5 * vi : vi;
    p.x = x; p.y = y; p.tLast = now; p.maxDist = Math.max(p.maxDist, Math.hypot(x - p.x0, y - p.y0));
    if (p.kind === 'joystick') { this.joy.move(x, y); this.renderJoy(); return; }
    if (p.kind === 'look' || p.control === 'fireR' || p.control === 'fireL') {
      const local = this.sink.local();
      if (!local || local.alive === 1) { const f = this.sink.settings().accel ? accelFactor(p.v) : 1; this.sink.look(dx * f, dy * f); }
    }
    if (p.group) this.checkPinch(p.group);
  }

  private handleUp(e: PointerEvent, cancelled: boolean): void {
    const p = this.ptrs.get(e.pointerId); if (!p) return;
    this.ptrs.delete(p.id);
    if (e.clientX || e.clientY) { p.x = e.clientX; p.y = e.clientY; p.maxDist = Math.max(p.maxDist, Math.hypot(p.x - p.x0, p.y - p.y0)); }
    const now = this.now();
    if (p.kind === 'control' && p.control) {
      const id = p.control;
      let still = false; for (const q of this.ptrs.values()) if (q.control === id) still = true;
      if (!still) this.els[id].classList.remove('is-held');
    } else if (p.kind === 'joystick') { this.joy.end(); this.renderJoy(); }
    else this.lookUp(p, now - p.t0, now, cancelled);
    this.countLook();
  }

  private press(id: ControlId): void {
    this.els[id].classList.add('is-held');
    const local = this.sink.local(), s = this.sink.settings();
    switch (id) {
      case 'fireR': case 'fireL': this.latched |= Btn.FIRE; break;
      case 'jump': this.latched |= Btn.JUMP; break;
      case 'crouch': if (s.crouchMode === 'toggle') this.crouchToggled = !this.crouchToggled; else this.latched |= Btn.CROUCH; this.els.crouch.classList.toggle('is-on', this.crouchToggled); break;
      case 'reload': this.latched |= Btn.RELOAD; break;
      case 'switch': this.slot = nextSwitchSlot(local); break;
      case 'scope': this.latched |= Btn.SCOPE; break;
      case 'grenade': this.latched |= Btn.THROW; break;
      case 'grenadeSelect': this.grenade = local && local.selectedGrenade === 1 ? 1 : 2; break;
      case 'use': this.latched |= Btn.USE; break;
      case 'buy': this.sink.uiAction('openBuy'); break;
      case 'pause': this.sink.uiAction('pause'); break;
      default: break;
    }
  }

  private joinGroup(p: Ptr): void {
    for (const q of this.ptrs.values()) {
      if (q === p || q.kind !== 'look' || q.maxDist >= TAP_PX || p.t0 - q.t0 > TWO_FINGER_MS) continue;
      const g = q.group ?? { members: [q], ended: 0, allTaps: true, pinched: false, d0: 0 };
      q.group = g; p.group = g; g.members.push(p);
      g.d0 = Math.hypot(g.members[0].x - g.members[1].x, g.members[0].y - g.members[1].y);
      return;
    }
  }

  private checkPinch(g: Group): void {
    if (g.pinched || g.members.length < 2 || !this.ptrs.has(g.members[0].id) || !this.ptrs.has(g.members[1].id)) return;
    const a = g.members[0], b = g.members[1];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    if (Math.abs(d - g.d0) > Math.max(PINCH_PX, 0.25 * g.d0)) {
      g.pinched = true; g.allTaps = false;
      const local = this.sink.local();
      if (local && local.weapon === AWP_INDEX) this.latched |= Btn.SCOPE;
    }
  }

  private lookUp(p: Ptr, dur: number, now: number, cancelled: boolean): void {
    const local = this.sink.local(), s = this.sink.settings();
    if (local && local.alive === 0) {
      const dx = p.x - p.x0, dy = p.y - p.y0;
      if (!cancelled && dur < SWIPE_MS && Math.abs(dx) >= SWIPE_PX && Math.abs(dx) > 1.5 * Math.abs(dy)) this.spectate = dx < 0 ? -1 : 1;
      return;
    }
    const isTap = !cancelled && dur < TAP_MS && p.maxDist < TAP_PX;
    const g = p.group;
    if (g) {
      g.ended++;
      if (cancelled || dur >= TWO_FINGER_MS || p.maxDist >= TAP_PX) g.allTaps = false;
      if (g.ended >= g.members.length && g.allTaps && !g.pinched && s.twoFingerReload) this.latched |= Btn.RELOAD;
      if (s.twoFingerReload || g.pinched) return;
    }
    if (!isTap) return;
    if (s.tapToFire) this.latched |= Btn.FIRE;
    if (s.doubleTapJump) {
      if (p.t0 - this.lastTap.t < DOUBLE_TAP_MS && Math.hypot(p.x0 - this.lastTap.x, p.y0 - this.lastTap.y) < DOUBLE_TAP_PX) { this.latched |= Btn.JUMP; this.lastTap.t = -1e9; }
      else this.lastTap = { t: now, x: p.x0, y: p.y0 };
    }
  }

  private countLook(): void {
    let n = 0;
    for (const p of this.ptrs.values()) if (p.kind === 'look' || p.control === 'fireR' || p.control === 'fireL') n++;
    this.setLookCount(n);
  }
  private setLookCount(n: number): void { if (n !== this.lookCount) { this.lookCount = n; this.sink.lookPointers(n); } }

  // ───────── rendering ─────────
  private applyVisible(): void { this.root.style.display = this.visible ? '' : 'none'; }

  private setVis(id: ControlId, v: boolean): void {
    if (this.vis[id] === v) return;
    this.vis[id] = v; this.els[id].style.display = v ? '' : 'none';
  }
  private setLabel(id: ControlId, s: string): void { if (this.labelText[id] !== s) { this.labelText[id] = s; this.labels[id].textContent = s; } }

  relayout(): void {
    this.vp = viewportOf(this.attached && this.visible ? this.root : null);
    this.geom = computeGeometry(this.layout, this.vp);
    this.joyMetrics = joystickMetrics(this.layout, this.vp);
    this.root.style.opacity = String(clamp(this.layout.opacity, 0.3, 1));
    for (const id of BUTTON_IDS) {
      const g = this.geom[id], st = this.els[id].style;
      st.left = `${g.cx - g.hw - this.vp.left}px`; st.top = `${g.cy - g.hh - this.vp.top}px`;
      st.width = `${2 * g.hw}px`; st.height = `${2 * g.hh}px`;
      st.fontSize = `${Math.max(10, g.hh * 0.6)}px`;
    }
    this.renderJoy();
  }

  private renderJoy(): void {
    const m = this.joyMetrics, vp = this.vp;
    let cx: number, cy: number, kx = 0, ky = 0;
    if (this.joy.active) {
      cx = this.joy.originX - vp.left; cy = this.joy.originY - vp.top;
      const o = this.joy.output(m.maxTravel); kx = o.knobX; ky = o.knobY;
    } else {
      const j = this.layout.controls.joystick;
      cx = ((this.layout.leftHanded ? 100 - j.x : j.x) / 100) * vp.width; cy = (j.y / 100) * vp.height;
    }
    this.joyEl.classList.toggle('is-active', this.joy.active);
    const r = this.ringEl.style;
    r.left = `${cx - m.ringR}px`; r.top = `${cy - m.ringR}px`; r.width = r.height = `${2 * m.ringR}px`;
    const k = this.knobEl.style;
    k.left = `${cx + kx - m.knobR}px`; k.top = `${cy + ky - m.knobR}px`; k.width = k.height = `${2 * m.knobR}px`;
  }
}

function div(cls: string): HTMLDivElement { const d = document.createElement('div'); d.className = cls; return d; }

const STYLE_ID = 'cs-touch-style';
function ensureStyle(): void {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = [
    ':where(.cs-touch) { z-index: 0; font-family: inherit; color: #fff; }',
    ':where(.cs-touch-ctl) { position: absolute; box-sizing: border-box; border-radius: 50%; border: 2px solid rgba(255,255,255,0.55); background: rgba(20,22,26,0.35); display: flex; flex-direction: column; align-items: center; justify-content: center; line-height: 1; text-shadow: 0 0 2px #000; pointer-events: none; transition: transform 60ms, background 60ms; }',
    ':where(.cs-touch-pill) { border-radius: 999px; }',
    ':where(.cs-touch-fireR, .cs-touch-fireL) { background: rgba(224,69,69,0.30); border-color: rgba(255,140,140,0.8); }',
    ':where(.cs-touch-label) { font-size: 0.45em; margin-top: 0.15em; white-space: nowrap; }',
    ':where(.cs-touch-pill .cs-touch-label) { font-size: 0.7em; margin: 0; }',
    ':where(.cs-touch-ctl.is-held) { background: rgba(255,255,255,0.35); transform: scale(0.94); }',
    ':where(.cs-touch-ctl.is-on) { background: rgba(79,195,247,0.45); }',
    ':where(.cs-touch-ctl.is-pulsing) { animation: cs-touch-pulse 1.2s ease-in-out infinite; }',
    '@keyframes cs-touch-pulse { 50% { background: rgba(255,213,79,0.45); } }',
    ':where(.cs-touch-joy-ring) { position: absolute; box-sizing: border-box; border-radius: 50%; border: 2px solid rgba(255,255,255,0.35); background: rgba(255,255,255,0.06); pointer-events: none; }',
    ':where(.cs-touch-joy-knob) { position: absolute; box-sizing: border-box; border-radius: 50%; background: rgba(255,255,255,0.45); pointer-events: none; }',
    ':where(.cs-touch-joy:not(.is-active)) { opacity: 0.35; }',
  ].join('\n');
  document.head.append(s);
}
