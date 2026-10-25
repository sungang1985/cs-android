/** A SnapLocal for the human (id 1) for audio tests (Node). */
import { createSnapshot, type SnapLocal } from '@/sim/state';

export function makeLocalPure(over: Partial<SnapLocal> = {}): SnapLocal {
  const l = createSnapshot().local;
  return Object.assign(l, { id: 1, alive: 1, hp: 100 }, over);
}
