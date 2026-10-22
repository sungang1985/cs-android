/**
 * Platform bridge: Android WebView (window.CSNative, see android/.../NativeBridge.kt), installed PWA, or
 * plain browser. Provides haptics, back-button routing, platform detection and safe-area insets.
 */
export interface NativeBridge {
  platform(): string;
  version(): string;
  vibrate(ms: number, amplitude: number): void;
  cancelVibration(): void;
  exit(): void;
}

declare global {
  interface Window {
    CSNative?: NativeBridge;
    /** Called by the Android host on hardware back. Return 'handled' | 'exit' | 'none'. */
    __csBack?: () => 'handled' | 'exit' | 'none';
  }
}

export type HapticKind = 'light' | 'medium' | 'heavy' | 'fire' | 'hit' | 'kill' | 'damage';

const HAPTICS: Record<HapticKind, { ms: number; amp: number }> = {
  light: { ms: 10, amp: 60 }, medium: { ms: 20, amp: 140 }, heavy: { ms: 40, amp: 255 },
  fire: { ms: 12, amp: 110 }, hit: { ms: 15, amp: 160 }, kill: { ms: 35, amp: 255 }, damage: { ms: 30, amp: 200 },
};

function native(): NativeBridge | undefined {
  return typeof window !== 'undefined' ? window.CSNative : undefined;
}

export const bridge = {
  isAndroidApp(): boolean {
    try { return !!native() && native()!.platform() === 'android'; } catch { return false; }
  },
  isStandalonePwa(): boolean {
    if (typeof window === 'undefined') return false;
    const nav = window.navigator as Navigator & { standalone?: boolean };
    return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || (window.matchMedia && window.matchMedia('(display-mode: fullscreen)').matches) || nav.standalone === true;
  },
  platformName(): 'android-app' | 'pwa' | 'browser' {
    return bridge.isAndroidApp() ? 'android-app' : bridge.isStandalonePwa() ? 'pwa' : 'browser';
  },
  /** True on touch-first devices. */
  isTouch(): boolean {
    if (typeof window === 'undefined') return false;
    return 'ontouchstart' in window || (navigator.maxTouchPoints ?? 0) > 0;
  },
  hapticsEnabled: true,
  haptic(kind: HapticKind): void {
    if (!bridge.hapticsEnabled) return;
    const h = HAPTICS[kind];
    const n = native();
    try {
      if (n) n.vibrate(h.ms, h.amp);
      else if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') navigator.vibrate(h.ms);
    } catch { /* ignore */ }
  },
  /** Register the back-button handler used by the Android host (and desktop Escape via the input layer). */
  onBack(handler: () => 'handled' | 'exit' | 'none'): () => void {
    if (typeof window === 'undefined') return () => {};
    window.__csBack = handler;
    const domHandler = () => { handler(); };
    window.addEventListener('cs-back', domHandler);
    return () => { window.removeEventListener('cs-back', domHandler); if (window.__csBack === handler) delete window.__csBack; };
  },
  /** Fired by the host on pause/resume (and by the page on visibilitychange). */
  onLifecycle(handler: (state: 'pause' | 'resume') => void): () => void {
    if (typeof window === 'undefined') return () => {};
    const p = () => handler('pause'), r = () => handler('resume');
    const vis = () => handler(document.visibilityState === 'hidden' ? 'pause' : 'resume');
    window.addEventListener('cs-pause', p); window.addEventListener('cs-resume', r);
    document.addEventListener('visibilitychange', vis);
    return () => { window.removeEventListener('cs-pause', p); window.removeEventListener('cs-resume', r); document.removeEventListener('visibilitychange', vis); };
  },
  exit(): void {
    const n = native();
    if (n) { try { n.exit(); return; } catch { /* fallthrough */ } }
    try { window.close(); } catch { /* ignore */ }
  },
  /** Request fullscreen + landscape where the browser allows it (no-op inside the Android app). */
  async requestImmersive(): Promise<void> {
    if (typeof document === 'undefined' || bridge.isAndroidApp()) return;
    try {
      const el = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> };
      if (!document.fullscreenElement) { if (el.requestFullscreen) await el.requestFullscreen({ navigationUI: 'hide' } as FullscreenOptions); else if (el.webkitRequestFullscreen) await el.webkitRequestFullscreen(); }
    } catch { /* ignore */ }
    try {
      const so = (screen as Screen & { orientation?: ScreenOrientation & { lock?: (o: string) => Promise<void> } }).orientation;
      if (so && so.lock) await so.lock('landscape');
    } catch { /* ignore */ }
  },
};
