/** Service worker registration and update flow (§14.3). Skipped inside the Android app (assets are bundled). */
import { bridge } from './android';

let waiting: ServiceWorker | null = null;
const listeners = new Set<() => void>();

export const pwa = {
  register(): void {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator) || bridge.isAndroidApp()) return;
    if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') return;
    navigator.serviceWorker.register('./sw.js').then((reg) => {
      const track = (sw: ServiceWorker | null) => { if (!sw) return; sw.addEventListener('statechange', () => { if (sw.state === 'installed' && navigator.serviceWorker.controller) { waiting = sw; for (const fn of listeners) fn(); } }); };
      if (reg.waiting && navigator.serviceWorker.controller) { waiting = reg.waiting; for (const fn of listeners) fn(); }
      track(reg.installing);
      reg.addEventListener('updatefound', () => track(reg.installing));
    }).catch(() => { /* offline or unsupported */ });
    try { void navigator.storage?.persist?.(); } catch { /* ignore */ }
  },
  onUpdateAvailable(fn: () => void): void { listeners.add(fn); if (waiting) fn(); },
  applyUpdate(): void { if (waiting) { waiting.postMessage('skipWaiting'); navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), { once: true }); } },
  hasUpdate(): boolean { return waiting !== null; },
};
