/** Haptics (§9.3): maps drained sim events to bridge.haptic. Only owner of vibration. */
import type { SimEnvelope } from '../sim/events';
import type { SnapLocal } from '../sim/state';
import { bridge } from './android';

export const haptics = {
  handle(e: SimEnvelope, local: SnapLocal): void {
    switch (e.type) {
      case 'shot': if ((e.data as { shooter: number }).shooter === local.id) bridge.haptic('fire'); break;
      case 'hit': { const d = e.data as { attacker: number; victim: number }; if (d.victim === local.id) bridge.haptic('damage'); else if (d.attacker === local.id) bridge.haptic('hit'); break; }
      case 'death': { const d = e.data as { victim: number; killer: number }; if (d.victim === local.id) bridge.haptic('heavy'); else if (d.killer === local.id) bridge.haptic('kill'); break; }
      case 'grenadeExplode': case 'bombExploded': bridge.haptic('heavy'); break;
    }
  },
};
