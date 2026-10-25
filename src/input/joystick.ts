/**
 * Floating move joystick (§7.2): the ring appears where the thumb lands; the knob is clamped to the max travel;
 * magnitude is quantised (dead zone 12 % → 0, walk band 12–75 % → 0.6, beyond → 1); direction is a unit vector.
 * The joystick pointer never contributes look. Pure (no DOM).
 */
export const JOY_DEAD_ZONE = 0.12;
export const JOY_WALK_MAX = 0.75;
export const JOY_WALK_MAG = 0.6;

export interface JoystickOutput { moveX: number; moveZ: number; travel: number; knobX: number; knobY: number }

/** Screen offset (dx right, dy down, px) → body-local move (+X right, +Z forward) and the clamped knob offset. */
export function joystickVector(dx: number, dy: number, maxTravel: number): JoystickOutput {
  const len = Math.hypot(dx, dy);
  const travel = maxTravel > 0 ? Math.min(1, len / maxTravel) : 0;
  const k = len > maxTravel && len > 0 ? maxTravel / len : 1;
  const knobX = dx * k, knobY = dy * k;
  if (travel < JOY_DEAD_ZONE || len < 1e-6) return { moveX: 0, moveZ: 0, travel, knobX, knobY };
  const mag = travel <= JOY_WALK_MAX ? JOY_WALK_MAG : 1;
  return { moveX: (dx / len) * mag, moveZ: (-dy / len) * mag, travel, knobX, knobY };
}

export class FloatingJoystick {
  pointerId = -1;
  originX = 0; originY = 0; x = 0; y = 0;
  get active(): boolean { return this.pointerId >= 0; }
  start(id: number, x: number, y: number): void { this.pointerId = id; this.originX = x; this.originY = y; this.x = x; this.y = y; }
  move(x: number, y: number): void { this.x = x; this.y = y; }
  end(): void { this.pointerId = -1; }
  output(maxTravel: number): JoystickOutput {
    if (!this.active) return { moveX: 0, moveZ: 0, travel: 0, knobX: 0, knobY: 0 };
    return joystickVector(this.x - this.originX, this.y - this.originY, maxTravel);
  }
}
