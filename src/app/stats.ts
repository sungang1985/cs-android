/** Lifetime stats (cs.v1.stats): accumulated per match from drained events, committed on matchEnd. */
import type { SimEnvelope } from '../sim/events';
import type { LifetimeStats } from '../ui/dom';
import { persist } from '../platform/persist';
import { WEAPON_INDEX } from '../sim/state';

export const EMPTY_STATS: LifetimeStats = { matches: 0, wins: 0, draws: 0, kills: 0, deaths: 0, headshots: 0, shots: 0, hits: 0, damage: 0, bestStreak: 0, byWeapon: {}, byAssist: { 0: 0, 1: 0, 2: 0, 3: 0 } };

export class MatchStats {
  kills = 0; deaths = 0; headshots = 0; shots = 0; hits = 0; damage = 0; streak = 0; bestStreak = 0;
  byWeapon: Record<string, { kills: number; shots: number; hits: number }> = {};
  constructor(private readonly localId: number) {}
  private w(id: string) { return (this.byWeapon[id] ??= { kills: 0, shots: 0, hits: 0 }); }
  handle(e: SimEnvelope): void {
    switch (e.type) {
      case 'shot': { const d = e.data as { shooter: number; weapon: string }; if (d.shooter === this.localId) { this.shots++; this.w(d.weapon).shots++; } break; }
      case 'hit': { const d = e.data as { attacker: number; weapon: string; damage: number }; if (d.attacker === this.localId) { this.hits++; this.damage += d.damage; this.w(d.weapon).hits++; } break; }
      case 'death': {
        const d = e.data as { victim: number; killer: number; weapon: string; headshot: boolean };
        if (d.killer === this.localId && d.victim !== this.localId) { this.kills++; if (d.headshot) this.headshots++; this.w(d.weapon).kills++; this.streak++; this.bestStreak = Math.max(this.bestStreak, this.streak); }
        if (d.victim === this.localId) { this.deaths++; this.streak = 0; }
        break;
      }
    }
  }
  commit(result: 'win' | 'lose' | 'draw', assistLevel: 0 | 1 | 2 | 3): LifetimeStats {
    const s = persist.get<LifetimeStats>('stats', EMPTY_STATS);
    const out: LifetimeStats = { ...EMPTY_STATS, ...s, byWeapon: { ...s.byWeapon }, byAssist: { ...EMPTY_STATS.byAssist, ...s.byAssist } };
    out.matches++; if (result === 'win') out.wins++; if (result === 'draw') out.draws++;
    out.kills += this.kills; out.deaths += this.deaths; out.headshots += this.headshots; out.shots += this.shots; out.hits += this.hits; out.damage += this.damage;
    out.bestStreak = Math.max(out.bestStreak, this.bestStreak);
    for (const [k, v] of Object.entries(this.byWeapon)) { const t = (out.byWeapon[k] ??= { kills: 0, shots: 0, hits: 0 }); t.kills += v.kills; t.shots += v.shots; t.hits += v.hits; }
    out.byAssist[assistLevel] = (out.byAssist[assistLevel] ?? 0) + 1;
    persist.set('stats', out);
    return out;
  }
  favouriteWeapon(): string | null { let best: string | null = null, k = 0; for (const [id, v] of Object.entries(this.byWeapon)) if (v.kills > k) { k = v.kills; best = id; } return best ?? (WEAPON_INDEX[0] ? null : null); }
}
