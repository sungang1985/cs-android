/**
 * Viewmodel + camera motion math (§10.4), pure (no three/DOM) so it is unit-testable in Node.
 * All angles in radians, distances in metres, times in seconds.
 */
import { DEG, clamp, smoothstep } from '../core/math';

export interface Spring1 { x: number; v: number }
/** Damped spring toward 0 (x'' = −k·x − c·x'), semi-implicit Euler with ≤ 1/240 s sub-steps. */
export function stepSpring(s: Spring1, k: number, c: number, dt: number): void {
  const n = Math.max(1, Math.ceil(dt * 240)), h = dt / n;
  for (let i = 0; i < n; i++) { s.v += (-k * s.x - c * s.v) * h; s.x += s.v * h; }
}
/** Frame-rate independent exponential smoothing toward `target` with time constant `tau`. */
export function smoothTo(cur: number, target: number, tau: number, dt: number): number { return cur + (target - cur) * (1 - Math.exp(-dt / tau)); }

export const VM = {
  base: { x: 0.18, y: -0.16, z: -0.35 },
  idle: { ax: 0.004, fx: 0.9, ay: 0.003, fy: 1.3, breath: 0.3 * DEG },
  sway: { gain: 0.6, maxYaw: 4 * DEG, maxPitch: 3 * DEG, tau: 0.08 },
  bob: { rate: 2.4, ax: 0.012, ay: 0.008 },
  land: { k: 0.05 / 8, max: 0.08, tau: 0.12 },
  kick: { z: 0.03, rx: 2.5 * DEG, k: 160, c: 14, maxKick: 3 },
  reload: { tilt: 25 * DEG, lower: 0.08, mag: 0.15, slide: 0.04 },
  switch: { lower: 0.25, rot: -40 * DEG, down: 0.15, up: 0.2 },
  knife: { swingFrom: -60 * DEG, swingTo: 30 * DEG, swingT: 0.25, stabZ: -0.15, stabT: 0.12, stabBack: 0.2 },
  throw: { rx: -35 * DEG, windT: 0.2, lowerT: 0.3, lower: 0.2 },
} as const;

/** kick = P[0].pitch / 0.4 (§10.4), clamped so the AWP/Deagle do not punch the gun through the camera. */
export function kickFromPattern(pitch0Deg: number): number { return clamp(pitch0Deg / 0.4, 0, VM.kick.maxKick); }

export interface VmInput {
  dt: number; speed: number; maxSpeed: number; crouch: boolean; grounded: boolean;
  /** look delta since the previous frame (radians) */
  dYaw: number; dPitch: number;
  /** SnapPlayer.reloadT of the local player: −1 or 0..1 */
  reloadT: number;
}
export interface VmPose { x: number; y: number; z: number; rx: number; ry: number; rz: number; magY: number; slideZ: number; swapNow: boolean }

/** Reload phases (§10.4): tilt+lower 0–25 %, mag drop/return 25–70 %, slide/bolt pull 70–100 %; tilt returns 85–100 %. */
export function reloadPose(r: number): { tilt: number; lower: number; magY: number; slideZ: number } {
  if (r < 0 || r > 1) return { tilt: 0, lower: 0, magY: 0, slideZ: 0 };
  const e = r < 0.25 ? smoothstep(0, 0.25, r) : r > 0.85 ? 1 - smoothstep(0.85, 1, r) : 1;
  let magY = 0;
  if (r >= 0.25 && r <= 0.7) { const u = (r - 0.25) / 0.45; magY = -VM.reload.mag * (u < 0.5 ? smoothstep(0, 0.5, u) : 1 - smoothstep(0.5, 1, u)); }
  const slideZ = r >= 0.7 ? VM.reload.slide * Math.sin(Math.PI * clamp((r - 0.7) / 0.3, 0, 1)) : 0;
  return { tilt: VM.reload.tilt * e, lower: VM.reload.lower * e, magY, slideZ };
}

/** Walk bob offsets for a phase and normalised speed s ∈ [0, 1]. */
export function bobOffset(phase: number, s: number): { x: number; y: number } {
  return { x: VM.bob.ax * Math.sin(phase) * s, y: VM.bob.ay * Math.abs(Math.sin(2 * phase)) * s };
}

export class ViewmodelMotion {
  t = 0; bobPhase = 0; swayYaw = 0; swayPitch = 0; land = 0;
  readonly kickZ: Spring1 = { x: 0, v: 0 };
  readonly kickRx: Spring1 = { x: 0, v: 0 };
  /** seconds since the switch started, −1 idle */
  switchT = -1; private swapped = true;
  knifeT = -1; knifeStab = false; throwT = -1;

  onShot(kick: number): void { this.kickZ.x += VM.kick.z * kick; this.kickRx.x += VM.kick.rx * kick; }
  onLand(impact: number): void { this.land = Math.max(-VM.land.max, this.land - VM.land.k * Math.max(0, impact)); }
  startSwitch(): void { this.switchT = 0; this.swapped = false; this.knifeT = -1; this.throwT = -1; }
  onKnife(stab: boolean): void { this.knifeT = 0; this.knifeStab = stab; }
  onThrow(): void { this.throwT = 0; }
  get switching(): boolean { return this.switchT >= 0; }

  update(inp: VmInput, out: VmPose): VmPose {
    const dt = inp.dt; this.t += dt;
    const S = VM;
    let x = S.base.x, y = S.base.y, z = S.base.z, rx = 0, ry = 0, rz = 0;
    // idle sway + breathing
    x += S.idle.ax * Math.sin(S.idle.fx * this.t); y += S.idle.ay * Math.sin(S.idle.fy * this.t + 1); rx += S.idle.breath * Math.sin(0.9 * this.t);
    // look sway: deltas normalised to a 60 Hz frame so the lag is frame-rate independent
    const norm = dt > 0 ? 1 / (60 * dt) : 0;
    const tYaw = -clamp(inp.dYaw * norm * S.sway.gain, -S.sway.maxYaw, S.sway.maxYaw);
    const tPitch = -clamp(inp.dPitch * norm * S.sway.gain, -S.sway.maxPitch, S.sway.maxPitch);
    this.swayYaw = smoothTo(this.swayYaw, tYaw, S.sway.tau, dt); this.swayPitch = smoothTo(this.swayPitch, tPitch, S.sway.tau, dt);
    ry += this.swayYaw; rx += this.swayPitch;
    // walk bob
    const s = inp.grounded ? clamp(inp.maxSpeed > 0 ? inp.speed / inp.maxSpeed : 0, 0, 1) * (inp.crouch ? 0.5 : 1) : 0;
    this.bobPhase = (this.bobPhase + inp.speed * dt * S.bob.rate) % (Math.PI * 2);
    const b = bobOffset(this.bobPhase, s); x += b.x; y += b.y;
    // land dip
    this.land *= Math.exp(-dt / S.land.tau); y += this.land;
    // recoil springs
    stepSpring(this.kickZ, S.kick.k, S.kick.c, dt); stepSpring(this.kickRx, S.kick.k, S.kick.c, dt);
    z += this.kickZ.x; rx += this.kickRx.x;
    // reload
    const rl = reloadPose(inp.reloadT);
    rz += rl.tilt; y -= rl.lower; rx += rl.tilt * 0.3;
    // switch: lower + rotate, swap at the bottom, raise
    let swapNow = false;
    if (this.switchT >= 0) {
      this.switchT += dt;
      const tt = this.switchT; let f: number;
      if (tt < S.switch.down) f = smoothstep(0, S.switch.down, tt);
      else { if (!this.swapped) { this.swapped = true; swapNow = true; } f = 1 - smoothstep(S.switch.down, S.switch.down + S.switch.up, tt); }
      if (tt >= S.switch.down + S.switch.up) { this.switchT = -1; f = 0; if (!this.swapped) { this.swapped = true; swapNow = true; } }
      y -= S.switch.lower * f; rx += S.switch.rot * f;
    }
    // knife swing / stab
    if (this.knifeT >= 0) {
      this.knifeT += dt;
      if (this.knifeStab) {
        const tt = this.knifeT, a = S.knife.stabT, bk = S.knife.stabBack;
        const f = tt < a ? smoothstep(0, a, tt) : 1 - smoothstep(a, a + bk, tt);
        z += S.knife.stabZ * f; if (tt > a + bk) this.knifeT = -1;
      } else {
        const u = clamp(this.knifeT / S.knife.swingT, 0, 1);
        const env = Math.sin(Math.PI * u);
        ry += (S.knife.swingFrom + (S.knife.swingTo - S.knife.swingFrom) * smoothstep(0, 1, u)) * env; x -= 0.05 * env;
        if (u >= 1) this.knifeT = -1;
      }
    }
    // throw: wind up, release, lower
    if (this.throwT >= 0) {
      this.throwT += dt;
      const tt = this.throwT;
      if (tt < S.throw.windT) rx += S.throw.rx * smoothstep(0, S.throw.windT, tt);
      else { const u = smoothstep(S.throw.windT, S.throw.windT + S.throw.lowerT, tt); rx += S.throw.rx * (1 - u); y -= S.throw.lower * u; }
      if (tt > S.throw.windT + S.throw.lowerT + 0.4) this.throwT = -1;
    }
    out.x = x; out.y = y; out.z = z; out.rx = rx; out.ry = ry; out.rz = rz; out.magY = rl.magY; out.slideZ = rl.slideZ; out.swapNow = swapNow;
    return out;
  }
}

/** Camera shake (§10.4): sum of decaying sines. Amplitudes in radians. */
export class Shake {
  private readonly e: { amp: number; dur: number; t: number; seed: number }[] = [];
  private n = 0;
  add(amp: number, dur: number): void {
    if (amp <= 0 || dur <= 0) return;
    if (this.e.length >= 6) this.e.shift();
    this.e.push({ amp, dur, t: 0, seed: (this.n++ * 1.618) % 6.283 });
  }
  /** Advances time and returns the current offset. */
  sample(dt: number, out: { yaw: number; pitch: number }): { yaw: number; pitch: number } {
    out.yaw = 0; out.pitch = 0;
    for (let i = this.e.length - 1; i >= 0; i--) {
      const s = this.e[i]; s.t += dt;
      if (s.t >= s.dur) { this.e.splice(i, 1); continue; }
      const k = s.amp * (1 - s.t / s.dur);
      out.yaw += k * Math.sin(s.t * 53 + s.seed); out.pitch += k * Math.sin(s.t * 67 + s.seed * 2.1);
    }
    return out;
  }
  get active(): boolean { return this.e.length > 0; }
}

/** HE / bomb explosion shake amplitude (degrees → radians): 0.4 · clamp(1 − dist / 30). */
export function explosionShake(dist: number): number { return 0.4 * DEG * clamp(1 - dist / 30, 0, 1); }

/** Linear FOV approach so a full 75° → 20° zoom takes 0.15 s. */
export function approachFov(cur: number, target: number, dt: number): number {
  const rate = (75 - 20) / 0.15;
  const d = target - cur, step = rate * dt;
  return Math.abs(d) <= step ? target : cur + Math.sign(d) * step;
}

/** C4 LED blink interval (§10.5): 1.0 · (remaining / 35)^1.6 + 0.05 s. */
export function bombBlinkInterval(remaining: number): number { return 1.0 * Math.pow(clamp(remaining / 35, 0, 1), 1.6) + 0.05; }

/**
 * Elapsed ticks after the plant at which `bomb_beep` plays — the same tick schedule as the audio engine
 * (first beep on the plant tick, then `round(interval(remaining) · 60)` ticks apart), so the LED (§10.5)
 * blinks with the beep on sim time (skip ×4, pause and slow motion included).
 */
const BEEP_SCHEDULE: number[] = (() => {
  const timerTicks = 35 * 60, out: number[] = [];
  for (let t = 0; timerTicks - t > 0; t += Math.max(1, Math.round(bombBlinkInterval((timerTicks - t) / 60) * 60))) out.push(t);
  return out;
})();
export function bombBeepTicks(): readonly number[] { return BEEP_SCHEDULE; }

/** LED lit for 0.08 s (5 ticks) from each scheduled beep; `remaining` = SnapBomb.remaining (seconds). */
export function bombLedOn(remaining: number): boolean {
  if (remaining <= 0) return false;
  const elapsed = Math.round((35 - remaining) * 60);
  if (elapsed < 0) return false;
  let lo = 0, hi = BEEP_SCHEDULE.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (BEEP_SCHEDULE[mid] <= elapsed) lo = mid; else hi = mid - 1; }
  return elapsed - BEEP_SCHEDULE[lo] < 5;
}
