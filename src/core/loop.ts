/**
 * Fixed-timestep game loop with render interpolation. Pure (no DOM): the clock and frame scheduler are
 * injected so it can be unit-tested with a fake clock.
 *
 *   accumulator += min(frameDt, maxFrameDt)
 *   while accumulator >= step && steps < maxSteps: tick(step); accumulator -= step
 *   render(alpha = accumulator / step, frameDt)
 */
export interface LoopOptions {
  /** Fixed step in seconds (default 1/60). */
  step?: number;
  /** Max sim steps per frame before dropping time (default 4). */
  maxSteps?: number;
  /** Clamp for a single frame's delta in seconds (default 0.1). */
  maxFrameDt?: number;
  /** Clock returning milliseconds (default performance.now). */
  now?: () => number;
  /** Frame scheduler (default requestAnimationFrame). Must call cb with a timestamp in ms. */
  raf?: (cb: (ms: number) => void) => number;
  caf?: (id: number) => void;
}

export interface LoopStats { fps: number; frameMs: number; simMs: number; renderMs: number; stepsLastFrame: number; droppedTime: number }

export class FixedLoop {
  readonly step: number;
  readonly maxSteps: number;
  readonly maxFrameDt: number;
  private readonly now: () => number;
  private readonly raf: (cb: (ms: number) => void) => number;
  private readonly caf: (id: number) => void;
  private accumulator = 0;
  private last = 0;
  private running = false;
  private paused = false;
  private rafId = 0;
  /** 1 = real time, 0.5 = slow motion, 4 = fast forward (bounded by maxSteps). */
  timeScale = 1;
  /** Optional frame cap (e.g. 30 for battery saver); 0 = uncapped. */
  fpsCap = 0;
  private fpsAccum = 0; private fpsCount = 0;
  readonly stats: LoopStats = { fps: 0, frameMs: 0, simMs: 0, renderMs: 0, stepsLastFrame: 0, droppedTime: 0 };

  constructor(
    private readonly tick: (dt: number) => void,
    private readonly render: (alpha: number, frameDt: number) => void,
    opts: LoopOptions = {},
  ) {
    this.step = opts.step ?? 1 / 60;
    this.maxSteps = opts.maxSteps ?? 4;
    this.maxFrameDt = opts.maxFrameDt ?? 0.1;
    this.now = opts.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    this.raf = opts.raf ?? ((cb) => (typeof requestAnimationFrame !== 'undefined' ? requestAnimationFrame(cb) : (setTimeout(() => cb(this.now()), 16) as unknown as number)));
    this.caf = opts.caf ?? ((id) => (typeof cancelAnimationFrame !== 'undefined' ? cancelAnimationFrame(id) : clearTimeout(id)));
  }

  get isRunning(): boolean { return this.running; }
  get isPaused(): boolean { return this.paused; }
  /** Interpolation factor of the most recent frame. */
  get alpha(): number { return this.accumulator / this.step; }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = this.now();
    this.accumulator = 0;
    this.schedule();
  }

  stop(): void {
    this.running = false;
    if (this.rafId) { this.caf(this.rafId); this.rafId = 0; }
  }

  /** Paused: no sim steps, no accumulation, but frames still render (menus over a frozen world). */
  pause(p: boolean): void {
    if (this.paused === p) return;
    this.paused = p;
    if (!p) { this.last = this.now(); this.accumulator = 0; }
  }

  private schedule(): void { this.rafId = this.raf((ms) => this.frame(ms)); }

  /** Advance by one frame; public so tests and the fake clock can drive it directly. */
  frame(nowMs: number = this.now()): void {
    if (!this.running) return;
    const rawDt = Math.max(0, (nowMs - this.last) / 1000);
    if (this.fpsCap > 0 && rawDt < 1 / this.fpsCap - 0.001) { this.schedule(); return; }
    this.last = nowMs;
    const frameDt = Math.min(rawDt, this.maxFrameDt);
    let steps = 0;
    const t0 = this.now();
    if (!this.paused) {
      this.accumulator += frameDt * this.timeScale;
      while (this.accumulator >= this.step - 1e-9 && steps < this.maxSteps) {
        this.tick(this.step);
        this.accumulator -= this.step;
        steps++;
      }
      if (this.accumulator >= this.step - 1e-9) { // hitch: drop the remainder so we never spiral
        this.stats.droppedTime += this.accumulator - this.step * 0.999;
        this.accumulator = this.step * 0.999;
      }
    }
    const t1 = this.now();
    this.render(this.paused ? 1 : Math.min(0.9999, Math.max(0, this.accumulator / this.step)), frameDt);
    const t2 = this.now();
    this.stats.simMs = t1 - t0; this.stats.renderMs = t2 - t1; this.stats.frameMs = rawDt * 1000; this.stats.stepsLastFrame = steps;
    this.fpsAccum += rawDt; this.fpsCount++;
    if (this.fpsAccum >= 0.5) { this.stats.fps = this.fpsCount / this.fpsAccum; this.fpsAccum = 0; this.fpsCount = 0; }
    if (this.running) this.schedule();
  }
}
