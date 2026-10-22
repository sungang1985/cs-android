/** The subset of CanvasRenderingContext2D the texture recipes may use (fakeable in Node). */
export type Ctx2D = Pick<CanvasRenderingContext2D, 'fillStyle' | 'strokeStyle' | 'lineWidth' | 'globalAlpha' | 'font' | 'textAlign' | 'fillRect' | 'strokeRect' | 'beginPath' | 'moveTo' | 'lineTo' | 'arc' | 'closePath' | 'fill' | 'stroke' | 'fillText' | 'save' | 'restore' | 'translate' | 'rotate' | 'createLinearGradient' | 'createRadialGradient'>;

/** Recording fake for unit tests: every call is appended to `calls` as [name, ...args]. */
export function makeRecordingCtx(): Ctx2D & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  const gradient = { addColorStop: (o: number, c: string) => { calls.push(['addColorStop', o, c]); } } as unknown as CanvasGradient;
  const rec = (name: string) => (...args: unknown[]) => { calls.push([name, ...args]); };
  const obj = {
    calls, fillStyle: '#000' as string | CanvasGradient | CanvasPattern, strokeStyle: '#000' as string | CanvasGradient | CanvasPattern, lineWidth: 1, globalAlpha: 1, font: '', textAlign: 'start' as CanvasTextAlign,
    fillRect: rec('fillRect'), strokeRect: rec('strokeRect'), beginPath: rec('beginPath'), moveTo: rec('moveTo'), lineTo: rec('lineTo'), arc: rec('arc'), closePath: rec('closePath'),
    fill: rec('fill'), stroke: rec('stroke'), fillText: rec('fillText'), save: rec('save'), restore: rec('restore'), translate: rec('translate'), rotate: rec('rotate'),
    createLinearGradient: (...a: unknown[]) => { calls.push(['createLinearGradient', ...a]); return gradient; },
    createRadialGradient: (...a: unknown[]) => { calls.push(['createRadialGradient', ...a]); return gradient; },
  };
  return obj as unknown as Ctx2D & { calls: unknown[][] };
}
