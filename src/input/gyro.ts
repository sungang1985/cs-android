/**
 * Gyro look (§7.4): Generic Sensor `Gyroscope` (60 Hz, screen reference frame) with a `deviceorientation`
 * fallback (delta rotation between samples, remapped to the screen by `screen.orientation.angle`).
 * yaw += rate.y · dt, pitch += rate.x · dt (the InputSystem applies gyroSens and the off/drag/always gate).
 * No-op when neither API exists; `available` lets the UI hide the setting.
 */
type Mat3 = [number, number, number, number, number, number, number, number, number];

interface GyroSensor extends EventTarget { x: number | null; y: number | null; timestamp: number | null; start(): void; stop(): void }
type GyroCtor = new (opts: { frequency: number; referenceFrame?: 'device' | 'screen' }) => GyroSensor;

const MAX_DT = 0.1;

/** Rotation matrix of a deviceorientation sample (R = Rz(α)·Rx(β)·Ry(γ), degrees), row-major. */
export function orientationMatrix(alphaDeg: number, betaDeg: number, gammaDeg: number): Mat3 {
  const d = Math.PI / 180;
  const cA = Math.cos(alphaDeg * d), sA = Math.sin(alphaDeg * d), cB = Math.cos(betaDeg * d), sB = Math.sin(betaDeg * d), cG = Math.cos(gammaDeg * d), sG = Math.sin(gammaDeg * d);
  return [
    cA * cG - sA * sB * sG, -sA * cB, cA * sG + sA * sB * cG,
    sA * cG + cA * sB * sG, cA * cB, sA * sG - cA * sB * cG,
    -cB * sG, sB, cB * cG,
  ];
}

/** Small rotation between two orientation samples, in the device frame (radians about x, y, z). */
export function deltaRotation(prev: Mat3, cur: Mat3): { x: number; y: number; z: number } {
  // D = prevᵀ · cur ≈ I + [ω]×
  const D = (i: number, j: number) => prev[i] * cur[j] + prev[3 + i] * cur[3 + j] + prev[6 + i] * cur[6 + j];
  return { x: (D(2, 1) - D(1, 2)) / 2, y: (D(0, 2) - D(2, 0)) / 2, z: (D(1, 0) - D(0, 1)) / 2 };
}

/** Device-frame rotation → screen frame for a screen rotated by `angleDeg` (screen.orientation.angle). */
export function deviceToScreen(w: { x: number; y: number }, angleDeg: number): { x: number; y: number } {
  const a = (angleDeg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return { x: c * w.x - s * w.y, y: s * w.x + c * w.y };
}

function screenAngle(): number {
  const o = (typeof screen !== 'undefined' ? screen.orientation : undefined) as ScreenOrientation | undefined;
  if (o && typeof o.angle === 'number') return o.angle;
  const legacy = (window as unknown as { orientation?: number }).orientation;
  return typeof legacy === 'number' ? legacy : 0;
}

export class GyroInput {
  /** Accumulated, not yet consumed rotation (radians, before gyroSens). */
  private yaw = 0; private pitch = 0;
  private sensor: GyroSensor | null = null;
  private lastSensorT = -1;
  private prevMat: Mat3 | null = null;
  private running = false;
  private permissionAsked = false;
  /** Gate: in 'drag' mode only while a look pointer is down. */
  active = false;
  /** True once a real reading arrived. */
  hasReadings = false;

  private readonly onReading = () => {
    const s = this.sensor; if (!s || s.timestamp == null) return;
    const t = s.timestamp / 1000;
    const dt = this.lastSensorT < 0 ? 0 : Math.min(MAX_DT, Math.max(0, t - this.lastSensorT));
    this.lastSensorT = t;
    if (s.x == null || s.y == null) return;
    this.hasReadings = true;
    if (this.active) { this.yaw += s.y * dt; this.pitch += s.x * dt; }
  };
  private readonly onSensorError = () => { this.stopSensor(); this.startOrientation(); };
  private readonly onOrientation = (e: DeviceOrientationEvent) => {
    if (e.alpha == null || e.beta == null || e.gamma == null) return;
    this.hasReadings = true;
    const m = orientationMatrix(e.alpha, e.beta, e.gamma);
    if (this.prevMat && this.active) {
      const w = deltaRotation(this.prevMat, m);
      const sw = deviceToScreen(w, screenAngle());
      if (Number.isFinite(sw.x) && Number.isFinite(sw.y) && Math.abs(sw.x) < 0.5 && Math.abs(sw.y) < 0.5) { this.yaw += sw.y; this.pitch += sw.x; }
    }
    this.prevMat = this.active ? m : null;
  };

  /** Some API exists (the setting can be shown). */
  static available(): boolean {
    if (typeof window === 'undefined') return false;
    return 'Gyroscope' in window || 'DeviceOrientationEvent' in window;
  }

  start(): void {
    if (this.running || !GyroInput.available()) return;
    this.running = true;
    const Ctor = (window as unknown as { Gyroscope?: GyroCtor }).Gyroscope;
    if (Ctor) {
      try {
        this.sensor = new Ctor({ frequency: 60, referenceFrame: 'screen' });
        this.sensor.addEventListener('reading', this.onReading);
        this.sensor.addEventListener('error', this.onSensorError);
        this.sensor.start();
        return;
      } catch { this.stopSensor(); }
    }
    this.startOrientation();
  }

  stop(): void {
    this.running = false;
    this.stopSensor();
    window.removeEventListener('deviceorientation', this.onOrientation);
    this.recentre();
  }

  /** iOS-style permission prompt; must run inside a user gesture (the first touch). */
  requestPermission(): void {
    if (this.permissionAsked) return;
    this.permissionAsked = true;
    const DOE = (window as unknown as { DeviceOrientationEvent?: { requestPermission?: () => Promise<string> } }).DeviceOrientationEvent;
    if (DOE && typeof DOE.requestPermission === 'function') DOE.requestPermission().catch(() => undefined);
  }

  /** Recentre on release of the look pointer: drop the reference sample and any pending rotation. */
  recentre(): void { this.prevMat = null; this.yaw = 0; this.pitch = 0; }

  consume(): { yaw: number; pitch: number } { const r = { yaw: this.yaw, pitch: this.pitch }; this.yaw = 0; this.pitch = 0; return r; }

  /** Tests: feed a rate sample directly (rad/s about the screen axes). */
  injectRate(rateX: number, rateY: number, dt: number): void { if (this.active) { this.yaw += rateY * dt; this.pitch += rateX * dt; } }

  private stopSensor(): void {
    if (!this.sensor) return;
    try { this.sensor.stop(); } catch { /* ignore */ }
    this.sensor.removeEventListener('reading', this.onReading);
    this.sensor.removeEventListener('error', this.onSensorError);
    this.sensor = null; this.lastSensorT = -1;
  }

  private startOrientation(): void {
    if (!this.running || !('DeviceOrientationEvent' in window)) return;
    window.addEventListener('deviceorientation', this.onOrientation);
  }
}
