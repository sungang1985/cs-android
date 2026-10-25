/**
 * Onboarding (§7.6, §2.4): three guided steps in the training range — 移动 (reach the marked cell; the UI asks the
 * app for the marker via the `marker` action), 瞄准与射击 (hit 5 targets), 购买 (buy the team rifle with 「全装」) —
 * then a one-line aim-assist choice, `onboardingDone`. The flow is fed by Screens.feedSnapshot/feedEvent (the Hud
 * forwards every snapshot and event), or driven explicitly by the app through Screens.onboardingStep(n).
 */
import type { Vec3 } from '../core/math';
import type { SnapLocal } from '../sim/state';
import type { SimEnvelope, SimEvents } from '../sim/events';
import { el, elt, tx, button } from './dom';
import type { ScreenHost } from './screens/host';

/** depot.training.onboardingCell = (5, 2) → world centre (2·5 + 1, floor 0, 2·2 + 1) (§0 grid convention). */
export const ONBOARDING_TARGET: Vec3 = { x: 11, y: 0, z: 5 };
export const ONBOARDING_RADIUS = 1.6;
export const ONBOARDING_TARGET_HITS = 5;
/** 0 move, 1 aim & fire, 2 buy, 3 aim-assist choice. */
export type OnboardingStep = 0 | 1 | 2 | 3;

export interface OnboardingCallbacks { marker(p: Vec3 | null): void; changed(step: OnboardingStep, stepCompleted: boolean): void }

export class OnboardingFlow {
  step: OnboardingStep = 0;
  hits = 0;
  active = false;
  target: Vec3 = ONBOARDING_TARGET;
  localId = 1;

  constructor(private readonly cb: OnboardingCallbacks) {}

  start(step: OnboardingStep): void { this.active = true; this.enter(step); }
  stop(): void { if (this.active && this.step === 0) this.cb.marker(null); this.active = false; }

  enter(step: OnboardingStep): void {
    this.step = step; this.hits = 0;
    this.cb.marker(step === 0 ? this.target : null);
  }

  feedLocal(l: SnapLocal): void {
    if (!this.active) return;
    if (l.id) this.localId = l.id;
    if (this.step === 0 && l.alive === 1 && Math.hypot(l.x - this.target.x, l.z - this.target.z) < ONBOARDING_RADIUS) this.complete();
  }

  feedEvent(e: SimEnvelope): void {
    if (!this.active) return;
    if (this.step === 1 && e.type === 'targetHit') { this.hits++; if (this.hits >= ONBOARDING_TARGET_HITS) this.complete(); else this.cb.changed(this.step, false); }
    else if (this.step === 2 && e.type === 'buy') {
      const d = e.data as SimEvents['buy'];
      if (d.ok && d.player === this.localId && (d.item === 'ak47' || d.item === 'm4a4')) this.complete();
    }
  }

  private complete(): void {
    const next = Math.min(3, this.step + 1) as OnboardingStep;
    this.enter(next);
    this.cb.changed(next, true);
  }
}

const STEP_KEYS = ['move', 'aim', 'buy'] as const;

/** Non-blocking card (top centre); only its buttons take pointers. */
export function buildOnboarding(h: ScreenHost, flow: OnboardingFlow, justDone: boolean): HTMLElement {
  const layer = el('div', { class: 'screen screen-onboarding', 'data-testid': 'screen-onboarding' });
  const card = el('div', { class: 'ob-card', 'data-testid': `onboarding-step-${flow.step}` });
  if (flow.step < 3) {
    const k = STEP_KEYS[flow.step as 0 | 1 | 2];
    const dots = el('div', { class: 'ob-dots' }, [0, 1, 2].map((i) => el('i', { class: `ob-dot${i < flow.step ? ' done' : i === flow.step ? ' on' : ''}` })));
    card.append(
      el('div', { class: 'ob-head' }, [dots, tx(el('span', { class: 'ob-step' }), 'ui.onboarding.step', { n: flow.step + 1, total: 3 })]),
      elt('h3', `ui.onboarding.${k}.title`),
      elt('p', `ui.onboarding.${k}.text`),
    );
    if (flow.step === 1) card.append(tx(el('div', { class: 'ob-progress', 'data-testid': 'onboarding-progress' }), 'ui.onboarding.aim.progress', { n: flow.hits, total: ONBOARDING_TARGET_HITS }));
    if (justDone) card.append(elt('div', 'ui.onboarding.stepDone', { class: 'ob-done' }));
    card.append(button('ui.onboarding.skip', 'onboarding-skip', () => h.skipOnboarding(), 'btn btn-small btn-ghost'));
  } else {
    card.append(elt('h3', 'ui.onboarding.assist.title'), elt('p', 'ui.onboarding.assist.text'));
    const choices = el('div', { class: 'ob-choices' });
    for (const lvl of [1, 2, 3] as const) choices.append(button(`ui.assist.${lvl}`, `onboarding-assist-${lvl}`, () => h.chooseAssist(lvl), `btn btn-small${lvl === 2 ? ' btn-primary' : ''}`));
    card.append(choices);
  }
  layer.append(card);
  return layer;
}
