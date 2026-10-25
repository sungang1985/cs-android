/** What every screen builder may use from Screens (kept as an interface so builders never import screens.ts). */
import type { EventBus } from '../../core/events';
import type { UiEvents, UiAction, ScreenName, ScreenData } from '../dom';
import type { UiShared } from '../context';

export type SettingsTab = 'controls' | 'graphics' | 'audio' | 'other';

export interface ScreenHost {
  readonly bus: EventBus<UiEvents>;
  readonly sh: UiShared;
  action(id: UiAction, payload?: unknown): void;
  show<S extends ScreenName>(s: S, data?: ScreenData[S]): void;
  hide(s: ScreenName): void;
  confirm(messageKey: string, onYes: () => void): void;
  /** Writes the shared Settings working copy and emits `settingsChanged` with the FULL object. */
  emitSettings(): void;
  emitLayout(): void;
  setLocale(l: 'zh' | 'en'): void;
  setSettingsTab(t: SettingsTab): void;
  openLayoutEditor(): void;
  startTraining(): void;
  chooseAssist(level: 1 | 2 | 3): void;
  skipOnboarding(): void;
}
