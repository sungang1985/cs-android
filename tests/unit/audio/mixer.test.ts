import { describe, it, expect } from 'vitest';
import {
  busFor, volumeGain, variantFor, voicePriority, pickVictim, inverseDistanceGain, DedupeClock, planWorldSound, applyOcclusion, beepInterval, hitCue, roundCue, isBodySound,
  BOT_FOOTSTEP_RANGE, DISTANT_LOWPASS, OCCLUDED_LOWPASS, OCCLUDED_GAIN,
} from '@/audio/mixer';
import { BANK_IDS } from '@/audio/recipes';
import { v3 } from '@/core/math';
import type { SimEvents } from '@/sim/events';

const L = v3(0, 1.65, 0);
const snd = (id: SimEvents['sound']['id'], x: number, loudness: number, player = 5): SimEvents['sound'] => ({ id, pos: v3(x, 0, 0), loudness, player });

describe('mixer decisions (§9.3)', () => {
  it('routes every id to a bus', () => {
    const buses = new Set(BANK_IDS.map(busFor));
    expect(buses).toEqual(new Set(['weapons', 'impacts', 'foley', 'explosions', 'ui', 'ambient']));
    expect(busFor('fire_ak')).toBe('weapons'); expect(busFor('impact_wood')).toBe('impacts'); expect(busFor('footstep_metal')).toBe('foley');
    expect(busFor('bomb_explode')).toBe('explosions'); expect(busFor('ui_tap')).toBe('ui'); expect(busFor('round_win')).toBe('ui'); expect(busFor('ambient_hum')).toBe('ambient');
  });
  it('volume sliders map to (v/100)²', () => {
    expect(volumeGain(100)).toBe(1); expect(volumeGain(50)).toBeCloseTo(0.25); expect(volumeGain(0)).toBe(0); expect(volumeGain(150)).toBe(1);
  });
  it('variant = (tick + player) % variants, no RNG', () => {
    expect(variantFor(10, 3, 2)).toBe(1); expect(variantFor(10, 4, 2)).toBe(0); expect(variantFor(7, 9, 1)).toBe(0);
  });
  it('priority = gain / distance; the lowest-priority voice is stolen only for a louder one', () => {
    expect(voicePriority(1, 10)).toBeCloseTo(0.1); expect(voicePriority(0.5, 0)).toBe(0.5);
    const voices = [{ priority: 0.5 }, { priority: 0.05 }, { priority: 0.3 }];
    expect(pickVictim(voices, 0.2)).toBe(1);
    expect(pickVictim(voices, 0.01)).toBe(-1);
  });
  it('inverse distance model with ref 1.5, rolloff 1.2', () => {
    expect(inverseDistanceGain(1)).toBe(1);
    expect(inverseDistanceGain(11.5)).toBeCloseTo(1.5 / (1.5 + 12));
    expect(inverseDistanceGain(100, 1.5, 40)).toBeCloseTo(inverseDistanceGain(40));
  });
  it('the same id within 25 ms is skipped', () => {
    const d = new DedupeClock();
    expect(d.allow('fire_ak', 1.0)).toBe(true); expect(d.allow('fire_ak', 1.02)).toBe(false); expect(d.allow('fire_m4', 1.02)).toBe(true);
    expect(d.allow('fire_ak', 1.03)).toBe(true);
  });
  it('own body sounds are unpanned; the local player\'s impacts and grenades stay positioned', () => {
    const own = planWorldSound(snd('fire_ak', 30, 40, 1), 1, L, 0.9);
    expect(own).toMatchObject({ play: true, panned: false, occlusionTest: false, lowpass: null });
    expect(planWorldSound(snd('he_explode', 20, 60, 1), 1, L, 1).panned).toBe(true);
    expect(isBodySound('impact_concrete')).toBe(false); expect(isBodySound('footstep_wood')).toBe(true);
  });
  it('bot footsteps only within 14 m; gunfire always (lowpassed beyond 25 m); others culled beyond their loudness', () => {
    expect(planWorldSound(snd('footstep_concrete', BOT_FOOTSTEP_RANGE - 1, 30), 1, L, 0.35).play).toBe(true);
    expect(planWorldSound(snd('footstep_concrete', BOT_FOOTSTEP_RANGE + 1, 30), 1, L, 0.35).play).toBe(false);
    const far = planWorldSound(snd('fire_ak', 80, 40), 1, L, 0.9);
    expect(far.play).toBe(true); expect(far.lowpass).toBe(DISTANT_LOWPASS); expect(far.panned).toBe(true);
    expect(planWorldSound(snd('fire_ak', 20, 40), 1, L, 0.9).lowpass).toBeNull();
    expect(planWorldSound(snd('impact_wood', 12, 10), 1, L, 0.5).play).toBe(false);
    expect(planWorldSound(snd('impact_wood', 8, 10), 1, L, 0.5).play).toBe(true);
  });
  it('global sounds (bomb explosion, loudness 1000) play unattenuated and unpanned', () => {
    expect(planWorldSound(snd('bomb_explode', 300, 1000, 0), 1, L, 1)).toMatchObject({ play: true, panned: false, occlusionTest: false });
  });
  it('occlusion: blocked line of sight → lowpass 700 Hz and −6 dB; the distant lowpass is kept when lower', () => {
    const p = planWorldSound(snd('impact_metal', 5, 10), 1, L, 0.5);
    expect(applyOcclusion(p, true)).toBe(p);
    const o = applyOcclusion(p, false);
    expect(o.lowpass).toBe(OCCLUDED_LOWPASS); expect(o.gain).toBeCloseTo(0.5 * OCCLUDED_GAIN);
    expect(applyOcclusion(planWorldSound(snd('fire_awp', 50, 60), 1, L, 1), false).lowpass).toBe(DISTANT_LOWPASS);
  });
  it('bomb beep interval 1.0·(remaining/35)^1.6 + 0.05', () => {
    expect(beepInterval(35)).toBeCloseTo(1.05); expect(beepInterval(0)).toBeCloseTo(0.05);
    expect(beepInterval(17.5)).toBeCloseTo(Math.pow(0.5, 1.6) + 0.05);
    expect(beepInterval(10)).toBeLessThan(beepInterval(20));
  });
  it('hit cues: attacker → hitmarker / headshot ding; victim → body / armor / head (helmet tink vs wet)', () => {
    const h = (o: Partial<SimEvents['hit']>): SimEvents['hit'] => ({ attacker: 2, victim: 3, weapon: 'ak47', zone: 'chest', damage: 30, armored: false, point: v3(), ...o });
    expect(hitCue(h({ attacker: 1 }), 1)).toEqual({ id: 'hitmarker', variant: 0 });
    expect(hitCue(h({ attacker: 1, zone: 'head' }), 1)).toEqual({ id: 'headshot_ding', variant: 0 });
    expect(hitCue(h({ victim: 1 }), 1)).toEqual({ id: 'hit_body', variant: 0 });
    expect(hitCue(h({ victim: 1, armored: true }), 1)).toEqual({ id: 'hit_armor', variant: 0 });
    expect(hitCue(h({ victim: 1, zone: 'head', armored: true }), 1)).toEqual({ id: 'hit_head', variant: 0 });
    expect(hitCue(h({ victim: 1, zone: 'head' }), 1)).toEqual({ id: 'hit_head', variant: 1 });
    expect(hitCue(h({}), 1)).toBeNull();
  });
  it('round stingers', () => {
    expect(roundCue('roundPhase', { phase: 'LIVE', round: 1, endsTick: 0 }, 'CT')).toBe('round_start');
    expect(roundCue('roundPhase', { phase: 'FREEZE', round: 1, endsTick: 0 }, 'CT')).toBeNull();
    const end = (winner: 'T' | 'CT' | null): SimEvents['roundEnd'] => ({ winner, reason: 'elimination', mvp: 0, deltas: [] });
    expect(roundCue('roundEnd', end('CT'), 'CT')).toBe('round_win');
    expect(roundCue('roundEnd', end('T'), 'CT')).toBe('round_lose');
    expect(roundCue('roundEnd', end(null), 'CT')).toBeNull();
    expect(roundCue('roundEnd', end('T'), null)).toBeNull();
  });
});
