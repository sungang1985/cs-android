import { describe, it, expect, vi, afterEach } from 'vitest';

type Listener = () => void;
function fakeWorker(state: string) {
  const ls: Record<string, Listener[]> = {};
  return { state, postMessage: vi.fn(), addEventListener: (t: string, fn: Listener) => { (ls[t] ??= []).push(fn); } };
}

/** A registration whose new worker is reported as waiting while an older worker controls the page (the toast case). */
async function setup(swState: string, controllerIsNew: boolean) {
  vi.resetModules();
  const sw = fakeWorker(swState);
  const container = { controller: controllerIsNew ? sw : { old: true }, register: vi.fn(async () => ({ waiting: sw, installing: null, addEventListener: () => {} })), addEventListener: vi.fn() };
  const reload = vi.fn();
  vi.stubGlobal('navigator', { serviceWorker: container });
  vi.stubGlobal('location', { protocol: 'https:', hostname: 'example.com', reload });
  const { pwa } = await import('@/platform/pwa');
  pwa.register();
  await new Promise((r) => setTimeout(r, 0));
  expect(pwa.hasUpdate()).toBe(true);
  return { pwa, sw, container, reload };
}

describe('pwa.applyUpdate', () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  it('reloads at once when the new worker already activated (sw.js skips waiting on install)', async () => {
    const { pwa, reload } = await setup('activated', false);
    pwa.applyUpdate();
    expect(reload).toHaveBeenCalledTimes(1);
  });
  it('reloads at once when the new worker already controls the page (clients.claim)', async () => {
    const { pwa, reload } = await setup('installed', true);
    pwa.applyUpdate();
    expect(reload).toHaveBeenCalledTimes(1);
  });
  it('a still-waiting worker is asked to skip waiting; reload follows controllerchange', async () => {
    const { pwa, sw, container, reload } = await setup('installed', false);
    pwa.applyUpdate();
    expect(sw.postMessage).toHaveBeenCalledWith('skipWaiting');
    expect(reload).not.toHaveBeenCalled();
    expect(container.addEventListener).toHaveBeenCalledWith('controllerchange', expect.any(Function), { once: true });
  });
});
