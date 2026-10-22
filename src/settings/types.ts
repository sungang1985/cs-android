/**
 * Shared settings types (frozen day 0). Zero dependencies. Imported by input/, ui/, render/, platform/, app/.
 * Values follow DESIGN.md §7.2 (layout) and §8.5 (settings).
 */
export type QualityPreset = 'low' | 'medium' | 'high' | 'auto';
export type ControlId = 'joystick' | 'fireR' | 'fireL' | 'jump' | 'crouch' | 'reload' | 'switch' | 'scope' | 'grenade' | 'grenadeSelect' | 'use' | 'buy' | 'pause';

export interface ControlPlacement { x: number /* % of width */; y: number /* % of height */; size: number /* vh */ }
export interface TouchLayout { controls: Record<ControlId, ControlPlacement>; scale: number /* 0.8–1.2 */; opacity: number /* 0.3–1 */; leftHanded: boolean }

export interface ControlSettings {
  sens: number; sensScoped: number; accel: boolean;
  aimAssist: 0 | 1 | 2 | 3; autoFire: boolean; tapToFire: boolean; doubleTapJump: boolean; twoFingerReload: boolean;
  recoilCrosshair: boolean; gyro: 'off' | 'drag' | 'always'; gyroSens: number; crouchMode: 'toggle' | 'hold'; autoReload: boolean; fovDeg: number;
}

export interface Settings {
  controls: ControlSettings;
  autoBuy: boolean; autoPickup: boolean; scopeHold: boolean;
  quality: QualityPreset; fpsCap: 30 | 60 | 0; batterySaver: boolean; haptics: boolean;
  volume: { master: number; sfx: number; ui: number };
  locale: 'zh' | 'en' | 'auto';
}

export const DEFAULT_CONTROLS: ControlSettings = {
  sens: 8, sensScoped: 8, accel: true,
  aimAssist: 2, autoFire: false, tapToFire: true, doubleTapJump: false, twoFingerReload: false,
  recoilCrosshair: true, gyro: 'off', gyroSens: 1.0, crouchMode: 'toggle', autoReload: true, fovDeg: 75,
};

export const DEFAULT_SETTINGS: Settings = {
  controls: DEFAULT_CONTROLS,
  autoBuy: false, autoPickup: true, scopeHold: true,
  quality: 'auto', fpsCap: 60, batterySaver: false, haptics: true,
  volume: { master: 80, sfx: 100, ui: 70 },
  locale: 'auto',
};

/** "Classic" layout, DESIGN.md §7.2 (centres in % of viewport, sizes in vh). The joystick entry is its floating zone anchor. */
export const DEFAULT_LAYOUT: TouchLayout = {
  controls: {
    joystick: { x: 22, y: 62, size: 24 },
    fireR: { x: 90, y: 72, size: 18 },
    fireL: { x: 8, y: 46, size: 13 },
    jump: { x: 78, y: 58, size: 10 },
    crouch: { x: 78, y: 86, size: 10 },
    reload: { x: 69, y: 72, size: 9 },
    switch: { x: 69, y: 56, size: 9 },
    scope: { x: 78, y: 44, size: 9 },
    grenade: { x: 69, y: 88, size: 9 },
    grenadeSelect: { x: 60, y: 76, size: 7 },
    use: { x: 57, y: 90, size: 8 },
    buy: { x: 10, y: 92, size: 8 },
    pause: { x: 84, y: 6, size: 7 },
  },
  scale: 1, opacity: 0.7, leftHanded: false,
};

/** Deep-ish clone helpers so callers never mutate the defaults. */
export function cloneSettings(s: Settings = DEFAULT_SETTINGS): Settings {
  return { ...s, controls: { ...s.controls }, volume: { ...s.volume } };
}
export function cloneLayout(l: TouchLayout = DEFAULT_LAYOUT): TouchLayout {
  const controls = {} as TouchLayout['controls'];
  for (const k of Object.keys(l.controls) as ControlId[]) controls[k] = { ...l.controls[k] };
  return { controls, scale: l.scale, opacity: l.opacity, leftHanded: l.leftHanded };
}
