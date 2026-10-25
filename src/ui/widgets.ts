/** Small form widgets shared by settings, mode select and the layout editor (thumb-sized, data-testid on every part). */
import { el, tx, type I18nParams } from './dom';

export interface Choice<T> { value: T; key?: string; text?: string; params?: I18nParams }

function label(node: HTMLElement, c: { key?: string; text?: string; params?: I18nParams }): HTMLElement {
  if (c.key) tx(node, c.key, c.params); else node.textContent = c.text ?? '';
  return node;
}

/** Segmented control; each option is `${testid}-${value}`. Returns the root with a `.set(v)` helper attached. */
export function segmented<T extends string | number>(testid: string, options: ReadonlyArray<Choice<T>>, value: T, onChange: (v: T) => void): HTMLElement & { setValue(v: T): void; setDisabled(d: boolean): void } {
  const root = el('div', { class: 'seg', role: 'radiogroup', 'data-testid': testid }) as unknown as HTMLElement & { setValue(v: T): void; setDisabled(d: boolean): void };
  const btns = options.map((o) => {
    const b = label(el('button', { class: 'seg-opt', type: 'button', role: 'radio', 'data-testid': `${testid}-${o.value}` }), o) as HTMLButtonElement;
    b.addEventListener('click', (e) => { e.stopPropagation(); if (root.classList.contains('is-disabled')) return; root.setValue(o.value); onChange(o.value); });
    return b;
  });
  root.setValue = (v: T) => { btns.forEach((b, i) => { const on = options[i].value === v; b.classList.toggle('is-on', on); b.setAttribute('aria-checked', String(on)); }); };
  root.setDisabled = (d: boolean) => { root.classList.toggle('is-disabled', d); for (const b of btns) b.disabled = d; };
  root.setValue(value);
  root.append(...btns);
  return root;
}

/** On/off switch (`aria-pressed`), text 开 / 关. */
export function toggle(testid: string, value: boolean, onChange: (v: boolean) => void): HTMLButtonElement {
  const b = el('button', { class: 'switch', type: 'button', 'data-testid': testid });
  const knob = el('span', { class: 'switch-knob' }), txt = el('span', { class: 'switch-text' });
  b.append(knob, txt);
  let v = value;
  const paint = () => { b.classList.toggle('is-on', v); b.setAttribute('aria-pressed', String(v)); tx(txt, v ? 'ui.common.on' : 'ui.common.off'); };
  b.addEventListener('click', (e) => { e.stopPropagation(); v = !v; paint(); onChange(v); });
  paint();
  return b;
}

export interface StepperOpts { min: number; max: number; step: number; value: number; fmt?: (v: number) => string; /** false: − / + only (compact toolbars) */ range?: boolean }

/** − [slider] + with a value readout: `${testid}` (range input), `-dec`, `-inc`, `-value`. */
export function stepper(testid: string, o: StepperOpts, onChange: (v: number) => void): HTMLElement {
  const fmt = o.fmt ?? ((v: number) => String(v));
  const decimals = (String(o.step).split('.')[1] ?? '').length;
  const snap = (v: number) => Number(Math.min(o.max, Math.max(o.min, Math.round(v / o.step) * o.step)).toFixed(decimals));
  let v = snap(o.value);
  const range = el('input', { class: 'range', type: 'range', min: String(o.min), max: String(o.max), step: String(o.step), value: String(v), 'data-testid': testid });
  const out = el('span', { class: 'stepper-value', 'data-testid': `${testid}-value`, text: fmt(v) });
  const set = (nv: number, emit: boolean) => { nv = snap(nv); if (nv === v && !emit) return; const changed = nv !== v; v = nv; range.value = String(v); out.textContent = fmt(v); if (emit && changed) onChange(v); };
  const dec = el('button', { class: 'stepper-btn', type: 'button', 'data-testid': `${testid}-dec`, text: '−', 'aria-label': '-' });
  const inc = el('button', { class: 'stepper-btn', type: 'button', 'data-testid': `${testid}-inc`, text: '+', 'aria-label': '+' });
  dec.addEventListener('click', (e) => { e.stopPropagation(); set(v - o.step, true); });
  inc.addEventListener('click', (e) => { e.stopPropagation(); set(v + o.step, true); });
  range.addEventListener('input', () => set(Number(range.value), true));
  range.addEventListener('change', () => set(Number(range.value), true));
  return el('div', { class: 'stepper' }, o.range === false ? [dec, out, inc] : [dec, range, inc, out]);
}

/** Settings row: label on the left, control on the right. */
export function row(labelKey: string, control: HTMLElement, testid?: string): HTMLElement {
  const r = el('div', { class: 'set-row' }, [tx(el('span', { class: 'set-label' }), labelKey), el('div', { class: 'set-ctl' }, [control])]);
  if (testid) r.dataset.testid = testid;
  return r;
}
