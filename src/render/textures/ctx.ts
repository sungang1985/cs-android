/** The subset of CanvasRenderingContext2D the texture recipes may use (fakeable in Node). §11.16 */
export type Ctx2D = Pick<CanvasRenderingContext2D, 'fillStyle' | 'strokeStyle' | 'lineWidth' | 'globalAlpha' | 'font' | 'textAlign' | 'fillRect' | 'strokeRect' | 'beginPath' | 'moveTo' | 'lineTo' | 'arc' | 'closePath' | 'fill' | 'stroke' | 'fillText' | 'save' | 'restore' | 'translate' | 'rotate' | 'createLinearGradient' | 'createRadialGradient'>;

const STYLE_PROPS = ['fillStyle', 'strokeStyle', 'lineWidth', 'globalAlpha', 'font', 'textAlign'] as const;

/**
 * Recording fake for unit tests: every call is appended to `calls` as [name, ...args]; style property
 * assignments are recorded as ['set', prop, value] (gradients as '[gradient]') so colour changes alter the hash.
 */
export function makeRecordingCtx(): Ctx2D & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  const gradient = { addColorStop: (o: number, c: string) => { calls.push(['addColorStop', o, c]); } } as unknown as CanvasGradient;
  const rec = (name: string) => (...args: unknown[]) => { calls.push([name, ...args]); };
  const values: Record<string, unknown> = { fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, globalAlpha: 1, font: '', textAlign: 'start' };
  const obj: Record<string, unknown> = {
    calls,
    fillRect: rec('fillRect'), strokeRect: rec('strokeRect'), beginPath: rec('beginPath'), moveTo: rec('moveTo'), lineTo: rec('lineTo'), arc: rec('arc'), closePath: rec('closePath'),
    fill: rec('fill'), stroke: rec('stroke'), fillText: rec('fillText'), save: rec('save'), restore: rec('restore'), translate: rec('translate'), rotate: rec('rotate'),
    createLinearGradient: (...a: unknown[]) => { calls.push(['createLinearGradient', ...a]); return gradient; },
    createRadialGradient: (...a: unknown[]) => { calls.push(['createRadialGradient', ...a]); return gradient; },
  };
  for (const p of STYLE_PROPS) {
    Object.defineProperty(obj, p, {
      get: () => values[p],
      set: (v: unknown) => { values[p] = v; calls.push(['set', p, typeof v === 'object' ? '[gradient]' : v]); },
      enumerable: true,
    });
  }
  return obj as unknown as Ctx2D & { calls: unknown[][] };
}

/** FNV-1a over the JSON of a recorded call list (numbers rounded to 1e-4 so the hash is platform-stable). */
export function hashCalls(calls: unknown[][]): number {
  const s = JSON.stringify(calls, (_k, v) => (typeof v === 'number' ? Math.round(v * 1e4) / 1e4 : v));
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}
