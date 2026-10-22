/** Difficulty table (§6.7). Data only. */
import type { Difficulty } from '../sim/state';

export interface DifficultyCfg {
  recognitionSec: number; reactionSec: number; sigmaErrDeg: number; tauErrSec: number; tauTrackSec: number; turnRateDeg: number; fireConeDeg: number; pHead: number;
  burst: [number, number]; burstPauseSec: number; recoilControl: number; strafe: 'none' | 'peek' | 'counter'; visionM: number; hearingMult: number; retreatHp: number;
  courage: 'abort' | 'abort10m' | 'covered'; grenades: 'none' | 'he' | 'he+flash'; rotates: boolean; fakeDefuseP: number;
}

export const DIFFICULTY: Record<Difficulty, DifficultyCfg> = {
  easy: { recognitionSec: 0.5, reactionSec: 0.45, sigmaErrDeg: 3.5, tauErrSec: 0.6, tauTrackSec: 0.35, turnRateDeg: 180, fireConeDeg: 5, pHead: 0.05, burst: [3, 5], burstPauseSec: 0.5, recoilControl: 0.3, strafe: 'none', visionM: 35, hearingMult: 0.6, retreatHp: 50, courage: 'abort', grenades: 'none', rotates: false, fakeDefuseP: 0 },
  normal: { recognitionSec: 0.3, reactionSec: 0.25, sigmaErrDeg: 1.8, tauErrSec: 0.5, tauTrackSec: 0.2, turnRateDeg: 360, fireConeDeg: 3, pHead: 0.2, burst: [5, 8], burstPauseSec: 0.3, recoilControl: 0.6, strafe: 'peek', visionM: 50, hearingMult: 1.0, retreatHp: 35, courage: 'abort10m', grenades: 'he', rotates: true, fakeDefuseP: 0 },
  hard: { recognitionSec: 0.18, reactionSec: 0.12, sigmaErrDeg: 0.8, tauErrSec: 0.4, tauTrackSec: 0.1, turnRateDeg: 720, fireConeDeg: 1.8, pHead: 0.45, burst: [8, 14], burstPauseSec: 0.2, recoilControl: 0.9, strafe: 'counter', visionM: 60, hearingMult: 1.2, retreatHp: 25, courage: 'covered', grenades: 'he+flash', rotates: true, fakeDefuseP: 0.25 },
};
