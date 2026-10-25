/**
 * Settings (§8.5): tabs 控制 / 画面 / 声音 / 语言与其他, every row bound to the shared Settings working copy;
 * each change emits `settingsChanged` with the FULL Settings object (the app persists it). 左手模式 and the
 * layout editor edit the TouchLayout and emit `layoutChanged`.
 */
import type { QualityPreset, Settings } from '../settings/types';
import { getLocale } from '../i18n/i18n';
import { el, elt, button } from './dom';
import { segmented, toggle, stepper, row } from './widgets';
import type { ScreenHost, SettingsTab } from './screens/host';
import { APP_VERSION } from './screens/mainMenu';

export const SETTINGS_TABS: readonly SettingsTab[] = ['controls', 'graphics', 'audio', 'other'];

function gyroAvailable(): boolean {
  if (typeof window === 'undefined') return false;
  return 'Gyroscope' in window || 'DeviceOrientationEvent' in window;
}

export function buildSettings(h: ScreenHost, tab: SettingsTab): HTMLElement {
  const layer = el('div', { class: 'screen screen-settings', 'data-testid': 'screen-settings' });
  const s = (): Settings => h.sh.settings;          // always the live working copy (replaced on every settingsChanged)
  const set = (fn: (st: Settings) => void) => { fn(s()); h.emitSettings(); };
  const tabs = el('div', { class: 'tabs', role: 'tablist' });
  for (const id of SETTINGS_TABS) {
    const b = button(`ui.settings.tab.${id}`, `settings-tab-${id}`, () => h.setSettingsTab(id), `tab${id === tab ? ' is-on' : ''}`);
    b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', String(id === tab));
    tabs.append(b);
  }
  const head = el('div', { class: 'panel-head' }, [button('ui.common.back', 'btn-back', () => h.hide('settings'), 'btn btn-back'), elt('h2', 'ui.settings.title'), tabs]);
  const body = el('div', { class: 'panel-body set-grid', 'data-testid': `settings-panel-${tab}` });
  const c = s().controls;
  const onOff = (testid: string, v: boolean, fn: (st: Settings, v: boolean) => void) => toggle(testid, v, (nv) => set((st) => fn(st, nv)));

  switch (tab) {
    case 'controls': {
      body.append(
        row('ui.settings.sens', stepper('set-sens', { min: 1, max: 20, step: 1, value: c.sens }, (v) => set((st) => { st.controls.sens = v; }))),
        row('ui.settings.sensScoped', stepper('set-sensScoped', { min: 1, max: 20, step: 1, value: c.sensScoped }, (v) => set((st) => { st.controls.sensScoped = v; }))),
        row('ui.settings.accel', onOff('set-accel', c.accel, (st, v) => { st.controls.accel = v; })),
        row('ui.settings.aimAssist', segmented<0 | 1 | 2 | 3>('set-aimAssist', [0, 1, 2, 3].map((n) => ({ value: n as 0 | 1 | 2 | 3, key: `ui.assist.${n}` })), c.aimAssist, (v) => set((st) => { st.controls.aimAssist = v; }))),
        row('ui.settings.autoFire', onOff('set-autoFire', c.autoFire, (st, v) => { st.controls.autoFire = v; })),
        row('ui.settings.tapToFire', onOff('set-tapToFire', c.tapToFire, (st, v) => { st.controls.tapToFire = v; })),
        row('ui.settings.doubleTapJump', onOff('set-doubleTapJump', c.doubleTapJump, (st, v) => { st.controls.doubleTapJump = v; })),
        row('ui.settings.twoFingerReload', onOff('set-twoFingerReload', c.twoFingerReload, (st, v) => { st.controls.twoFingerReload = v; })),
        row('ui.settings.recoilCrosshair', onOff('set-recoilCrosshair', c.recoilCrosshair, (st, v) => { st.controls.recoilCrosshair = v; })),
      );
      if (gyroAvailable()) body.append(
        row('ui.settings.gyro', segmented<'off' | 'drag' | 'always'>('set-gyro', [{ value: 'off', key: 'ui.settings.gyro.off' }, { value: 'drag', key: 'ui.settings.gyro.drag' }, { value: 'always', key: 'ui.settings.gyro.always' }], c.gyro, (v) => set((st) => { st.controls.gyro = v; }))),
        row('ui.settings.gyroSens', stepper('set-gyroSens', { min: 0.5, max: 2, step: 0.1, value: c.gyroSens, fmt: (v) => v.toFixed(1) }, (v) => set((st) => { st.controls.gyroSens = v; }))),
      );
      body.append(
        row('ui.settings.crouch', segmented<'toggle' | 'hold'>('set-crouchMode', [{ value: 'toggle', key: 'ui.settings.crouch.toggle' }, { value: 'hold', key: 'ui.settings.crouch.hold' }], c.crouchMode, (v) => set((st) => { st.controls.crouchMode = v; }))),
        row('ui.settings.autoReload', onOff('set-autoReload', c.autoReload, (st, v) => { st.controls.autoReload = v; })),
        row('ui.settings.autoBuy', onOff('set-autoBuy', s().autoBuy, (st, v) => { st.autoBuy = v; })),
        row('ui.settings.autoPickup', onOff('set-autoPickup', s().autoPickup, (st, v) => { st.autoPickup = v; })),
        row('ui.settings.scopeHold', onOff('set-scopeHold', s().scopeHold, (st, v) => { st.scopeHold = v; })),
        row('ui.settings.layout', button('ui.settings.layoutEdit', 'btn-layout', () => h.openLayoutEditor(), 'btn btn-small')),
        row('ui.settings.leftHanded', toggle('set-leftHanded', h.sh.layout.leftHanded, (v) => { h.sh.layout.leftHanded = v; h.emitLayout(); })),
      );
      break;
    }
    case 'graphics': {
      body.append(
        row('ui.settings.quality', segmented<QualityPreset>('set-quality', (['low', 'medium', 'high', 'auto'] as const).map((q) => ({ value: q, key: `ui.settings.quality.${q}` })), s().quality, (v) => { set((st) => { st.quality = v; }); h.bus.emit('qualityChanged', v); })),
        row('ui.settings.fps', segmented<30 | 60 | 0>('set-fpsCap', [{ value: 30, text: '30' }, { value: 60, text: '60' }, { value: 0, key: 'ui.settings.fps.unlimited' }], s().fpsCap, (v) => set((st) => { st.fpsCap = v; }))),
        row('ui.settings.batterySaver', onOff('set-batterySaver', s().batterySaver, (st, v) => { st.batterySaver = v; })),
        row('ui.settings.fov', stepper('set-fov', { min: 65, max: 90, step: 1, value: c.fovDeg, fmt: (v) => `${v}°` }, (v) => set((st) => { st.controls.fovDeg = v; }))),
      );
      break;
    }
    case 'audio': {
      const vol = s().volume;
      body.append(
        row('ui.settings.master', stepper('set-master', { min: 0, max: 100, step: 5, value: vol.master }, (v) => set((st) => { st.volume = { ...st.volume, master: v }; }))),
        row('ui.settings.sfx', stepper('set-sfx', { min: 0, max: 100, step: 5, value: vol.sfx }, (v) => set((st) => { st.volume = { ...st.volume, sfx: v }; }))),
        row('ui.settings.uiVolume', stepper('set-ui', { min: 0, max: 100, step: 5, value: vol.ui }, (v) => set((st) => { st.volume = { ...st.volume, ui: v }; }))),
        row('ui.settings.haptics', onOff('set-haptics', s().haptics, (st, v) => { st.haptics = v; })),
      );
      break;
    }
    case 'other': {
      body.append(
        row('ui.settings.language', segmented<'zh' | 'en'>('set-locale', [{ value: 'zh', text: '中文' }, { value: 'en', text: 'English' }], getLocale(), (v) => h.setLocale(v))),
        row('ui.settings.reset', button('ui.settings.resetBtn', 'btn-resetData', () => h.confirm('ui.settings.resetConfirm', () => h.action('resetData')), 'btn btn-small btn-danger')),
        row('ui.settings.version', el('span', { class: 'set-value', text: `v${APP_VERSION}` })),
      );
      break;
    }
  }
  layer.append(head, body);
  return layer;
}
