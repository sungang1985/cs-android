import { describe, it, expect } from 'vitest';
import { touchCovered } from '@/app/touchCover';

describe('touchCovered', () => {
  it('keeps the controls under the non-blocking onboarding card and the rotate gate', () => {
    expect(touchCovered([], false)).toBe(false);
    expect(touchCovered(['onboarding'], false)).toBe(false);
    expect(touchCovered(['rotate', 'onboarding'], false)).toBe(false);
  });
  it('hides them under blocking screens and the buy menu', () => {
    for (const s of ['pause', 'roundEnd', 'matchEnd', 'scoreboard', 'settings']) expect(touchCovered([s], false)).toBe(true);
    expect(touchCovered(['onboarding', 'pause'], false)).toBe(true);
    expect(touchCovered(['onboarding'], true)).toBe(true);
  });
});
