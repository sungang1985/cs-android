/**
 * Touch-layout editor (§8.5 自定义布局): ghost controls drawn from the TouchLayout at their % positions; drag any of
 * them (snap 1 %), scale 80–120 %, opacity 30–100 %, 左手模式 (mirrors every x), 重置 → DEFAULT_LAYOUT. Every
 * change emits `layoutChanged` with the full TouchLayout; the input lane applies it, the app persists it.
 */
import { DEFAULT_LAYOUT, cloneLayout, type ControlId, type TouchLayout } from '../settings/types';
import { el, elt, tx, button } from './dom';
import { stepper, toggle } from './widgets';

export const CONTROL_IDS = Object.keys(DEFAULT_LAYOUT.controls) as ControlId[];
/** Pills are wide (§7.2): width in % of the viewport. */
const PILL_WIDTH: Partial<Record<ControlId, number>> = { use: 16, buy: 18 };

function clamp(v: number, lo: number, hi: number): number { return v < lo ? lo : v > hi ? hi : v; }

/** Display x of a stored (right-handed) x. */
export function displayX(x: number, leftHanded: boolean): number { return leftHanded ? 100 - x : x; }

/** Pointer position inside the stage → stored layout % (snapped to 1 %, clamped, un-mirrored for left-handed). */
export function dragToPercent(px: number, py: number, w: number, h: number, leftHanded: boolean): { x: number; y: number } {
  const x = clamp(Math.round((px / Math.max(1, w)) * 100), 0, 100);
  const y = clamp(Math.round((py / Math.max(1, h)) * 100), 0, 100);
  return { x: leftHanded ? 100 - x : x, y };
}

export class LayoutEditor {
  private node: HTMLElement | null = null;
  private stage: HTMLElement | null = null;
  private readonly ghosts = new Map<ControlId, HTMLElement>();

  constructor(private readonly parent: HTMLElement, private readonly getLayout: () => TouchLayout, private readonly emit: (l: TouchLayout) => void, private readonly onClose?: () => void) {}

  get isOpen(): boolean { return this.node !== null; }

  open(): void {
    if (this.node) return;
    this.node = this.build();
    this.parent.append(this.node);
  }

  close(): void {
    if (!this.node) return;
    this.node.remove(); this.node = null; this.stage = null; this.ghosts.clear();
    this.onClose?.();
  }

  private build(): HTMLElement {
    const l = this.getLayout();
    const layer = el('div', { class: 'layout-editor', 'data-testid': 'screen-layout' });
    layer.addEventListener('pointerdown', (e) => e.stopPropagation());
    const stage = (this.stage = el('div', { class: 'le-stage' }));
    for (const id of CONTROL_IDS) stage.append(this.ghost(id));
    const bar = el('div', { class: 'le-bar' }, [
      el('div', { class: 'le-field' }, [elt('span', 'ui.layout.scale'), stepper('layout-scale', { min: 80, max: 120, step: 5, value: Math.round(l.scale * 100), fmt: (v) => `${v}%`, range: false }, (v) => { this.getLayout().scale = v / 100; this.paint(); this.emit(this.getLayout()); })]),
      el('div', { class: 'le-field' }, [elt('span', 'ui.layout.opacity'), stepper('layout-opacity', { min: 30, max: 100, step: 5, value: Math.round(l.opacity * 100), fmt: (v) => `${v}%`, range: false }, (v) => { this.getLayout().opacity = v / 100; this.paint(); this.emit(this.getLayout()); })]),
      el('div', { class: 'le-field' }, [elt('span', 'ui.settings.leftHanded'), toggle('layout-lefty', l.leftHanded, (v) => { this.getLayout().leftHanded = v; this.paint(); this.emit(this.getLayout()); })]),
      button('ui.layout.reset', 'layout-reset', () => this.reset(), 'btn btn-small'),
      button('ui.layout.done', 'layout-done', () => this.close(), 'btn btn-small btn-primary'),
      elt('div', 'ui.layout.hint', { class: 'le-hint' }),
    ]);
    layer.append(stage, bar);
    this.paint();
    return layer;
  }

  private reset(): void {
    this.emit(cloneLayout(DEFAULT_LAYOUT));
    if (!this.node) return;
    const old = this.node;
    this.ghosts.clear();
    this.node = this.build();
    old.replaceWith(this.node);
  }

  private ghost(id: ControlId): HTMLElement {
    const g = el('div', { class: `le-ghost le-${id}${PILL_WIDTH[id] ? ' is-pill' : ''}${id === 'joystick' ? ' is-zone' : ''}`, 'data-testid': `layout-${id}` }, [tx(el('span', { class: 'le-label' }), `ui.layout.ctl.${id}`)]);
    g.addEventListener('pointerdown', (e) => this.drag(e, id, g));
    this.ghosts.set(id, g);
    return g;
  }

  private paint(): void {
    const l = this.getLayout();
    for (const [id, g] of this.ghosts) {
      const c = l.controls[id];
      const d = c.size * l.scale;
      g.style.left = `${displayX(c.x, l.leftHanded)}%`;
      g.style.top = `${c.y}%`;
      g.style.height = `${d}vh`;
      g.style.width = PILL_WIDTH[id] ? `${(PILL_WIDTH[id] ?? 0) * l.scale}%` : `${d}vh`;
      g.style.opacity = String(Math.max(0.3, Math.min(1, l.opacity)));
    }
  }

  private drag(e: PointerEvent | MouseEvent, id: ControlId, g: HTMLElement): void {
    e.preventDefault(); e.stopPropagation();
    const pid = (e as PointerEvent).pointerId;
    try { if (pid !== undefined) g.setPointerCapture?.(pid); } catch { /* jsdom / synthetic events */ }
    g.classList.add('is-drag');
    const start = { ...this.getLayout().controls[id] };
    const move = (ev: PointerEvent | MouseEvent) => {
      const r = this.stage?.getBoundingClientRect();
      const w = r && r.width ? r.width : window.innerWidth, h = r && r.height ? r.height : window.innerHeight;
      const p = dragToPercent(ev.clientX - (r?.left ?? 0), ev.clientY - (r?.top ?? 0), w, h, this.getLayout().leftHanded);
      const c = this.getLayout().controls[id];
      c.x = p.x; c.y = p.y;
      this.paint();
    };
    const up = (ev: PointerEvent | MouseEvent) => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up);
      if (ev.type !== 'pointercancel') move(ev);
      g.classList.remove('is-drag');
      const c = this.getLayout().controls[id];
      if (c.x !== start.x || c.y !== start.y) this.emit(this.getLayout());
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
  }
}
