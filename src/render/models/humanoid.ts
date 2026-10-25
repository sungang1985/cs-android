/**
 * Characters (§10.2): hierarchical humanoid from boxes with the hitbox dimensions of §4.4 (head centre
 * feet + 1.60 r 0.16, torso 0.5 × 0.6 × 0.3 at 0.9–1.5, legs 0–0.9; crouched torso 0.6–1.1, head 1.10).
 * The hierarchy is a set of invisible Object3D proxies per view; every part is written into shared instanced
 * batches (team-textured torsos, plain coloured boxes, helmets, blob shadows, weapons), so 10 players cost a
 * handful of draw calls. Views are keyed by entity id and reconciled every frame.
 */
import { BoxGeometry, SphereGeometry, Group, Object3D, Color, Matrix4, Vector3, Quaternion, type BufferGeometry } from 'three';
import { WEAPON_INDEX, type RenderSnapshot, type SnapPlayer } from '../../sim/state';
import { wrapAngle, clamp, DEG, type Vec3 } from '../../core/math';
import { InstBatch } from './batch';
import { muzzleOffset, type WeaponModelId } from './weapons';
import type { SharedBatches } from './props';
import type { MaterialLib } from '../materials';

const TEAM = [
  { sleeve: new Color('#b8943f'), pants: new Color('#6e5f3e'), vest: new Color('#55583a'), skin: new Color('#c99d78'), pack: new Color('#3a3a30') },
  { sleeve: new Color('#3d6fb5'), pants: new Color('#2b3d5e'), vest: new Color('#22334c'), skin: new Color('#d5ae88'), pack: new Color('#2a2e36') },
] as const;
const HELMET = new Color('#2b2b2b');
const FLASH = new Color(1, 0.3, 0.3);
const WHITE = new Color(1, 1, 1);
const UP = new Vector3(0, 1, 0), YAXIS = new Vector3(0, 1, 0);

/** Torso box whose back face (+z, the model faces −z) samples the right half of the skin texture. */
function torsoGeometry(): BufferGeometry {
  const g = new BoxGeometry(1, 1, 1);
  const uv = g.getAttribute('uv');
  for (let face = 0; face < 6; face++) for (let v = 0; v < 4; v++) {
    const i = face * 4 + v;
    uv.setX(i, face === 4 ? 0.5 + uv.getX(i) * 0.5 : uv.getX(i) * 0.5);
  }
  uv.needsUpdate = true;
  return g;
}

interface Part { node: Object3D; size: Vector3; kind: 'torso' | 'plain' | 'helmet'; color: Color }

export interface CharView {
  id: number; team: 0 | 1; seen: number;
  root: Object3D; tilt: Object3D; body: Object3D; hips: Object3D; spine: Object3D; neck: Object3D; aim: Object3D; mount: Object3D;
  thighL: Object3D; thighR: Object3D; kneeL: Object3D; kneeR: Object3D;
  parts: { torso: Part; vest: Part; pack: Part; hips: Part; head: Part; helmet: Part; uaL: Part; uaR: Part; faL: Part; faR: Part; thL: Part; thR: Part; shL: Part; shR: Part };
  led: Object3D;
  crouchF: number; moveAmp: number; lastLeg: number;
  deathDir: Vector3 | null; hitDir: Vector3; flashUntil: number; wasAlive: boolean;
  /** world-space results of the last pose */
  muzzle: Vector3; eye: Vector3; pos: Vector3; yaw: number; pitch: number; alive: boolean; weapon: number;
}

export interface CharFrameOpts { hidden: (id: number) => boolean; clock: number; dt: number; showAll: boolean }

const _m = new Matrix4(), _v = new Vector3(), _a = new Vector3(), _b = new Vector3(), _c = new Vector3(), _q = new Quaternion();

export class CharacterSystem {
  readonly group = new Group();
  readonly views = new Map<number, CharView>();
  private readonly torso: [InstBatch, InstBatch];
  private readonly helmet: InstBatch;
  private frame = 0;

  constructor(lib: MaterialLib, private readonly shared: SharedBatches) {
    this.group.name = 'characters';
    const tg = torsoGeometry();
    this.torso = [
      new InstBatch(tg, lib.lit({ map: lib.texture('skin_t') }), 12, true, 'torso:T'),
      new InstBatch(tg.clone(), lib.lit({ map: lib.texture('skin_ct') }), 12, true, 'torso:CT'),
    ];
    this.helmet = new InstBatch(new SphereGeometry(1, 10, 5, 0, Math.PI * 2, 0, Math.PI / 2), lib.plain(), 12, true, 'helmet');
    for (const b of [...this.torso, this.helmet]) this.group.add(b.mesh);
  }

  private create(sp: SnapPlayer): CharView {
    const o = () => new Object3D();
    const part = (parent: Object3D, kind: Part['kind'], sx: number, sy: number, sz: number, color: Color, x = 0, y = 0, z = 0): Part => {
      const node = o(); node.position.set(x, y, z); parent.add(node);
      return { node, size: new Vector3(sx, sy, sz), kind, color };
    };
    const tc = TEAM[sp.team];
    const root = o(), tilt = o(), body = o(), hips = o(), spine = o(), neck = o(), aim = o(), mount = o();
    root.rotation.order = 'YXZ';
    root.add(tilt); tilt.add(body); body.add(hips); hips.add(spine); spine.add(neck); spine.add(aim); aim.add(mount);
    tilt.position.y = 0.15; body.position.y = -0.15;
    const thighL = o(), thighR = o(), kneeL = o(), kneeR = o();
    thighL.position.set(-0.1, 0, 0); thighR.position.set(0.1, 0, 0); hips.add(thighL); hips.add(thighR);
    kneeL.position.set(0, -0.45, 0); kneeR.position.set(0, -0.45, 0); thighL.add(kneeL); thighR.add(kneeR);
    const led = o(); spine.add(led);
    const parts = {
      torso: part(spine, 'torso', 0.5, 0.6, 0.3, WHITE),
      vest: part(spine, 'plain', 0.53, 0.38, 0.34, tc.vest),
      pack: part(spine, 'plain', 0.25, 0.3, 0.1, tc.pack),
      hips: part(hips, 'plain', 0.36, 0.22, 0.22, tc.pants, 0, 0.03, 0),
      head: part(neck, 'plain', 0.24, 0.26, 0.24, tc.skin, 0, 0.11, 0),
      helmet: part(neck, 'helmet', 0.15, 0.15, 0.15, HELMET, 0, 0.17, 0),
      uaL: part(aim, 'plain', 0.12, 0.32, 0.12, tc.sleeve), uaR: part(aim, 'plain', 0.12, 0.32, 0.12, tc.sleeve),
      faL: part(aim, 'plain', 0.1, 0.3, 0.1, tc.sleeve), faR: part(aim, 'plain', 0.1, 0.3, 0.1, tc.sleeve),
      thL: part(thighL, 'plain', 0.18, 0.45, 0.18, tc.pants, 0, -0.225, 0), thR: part(thighR, 'plain', 0.18, 0.45, 0.18, tc.pants, 0, -0.225, 0),
      shL: part(kneeL, 'plain', 0.15, 0.45, 0.15, tc.pants, 0, -0.225, 0), shR: part(kneeR, 'plain', 0.15, 0.45, 0.15, tc.pants, 0, -0.225, 0),
    };
    return {
      id: sp.id, team: sp.team, seen: 0, root, tilt, body, hips, spine, neck, aim, mount, thighL, thighR, kneeL, kneeR, parts, led,
      crouchF: sp.crouch, moveAmp: 0, lastLeg: sp.legPhase, deathDir: null, hitDir: new Vector3(0, 0, 1), flashUntil: -1, wasAlive: sp.alive === 1,
      muzzle: new Vector3(sp.x, sp.y + 1.4, sp.z), eye: new Vector3(sp.x, sp.y + 1.65, sp.z), pos: new Vector3(sp.x, sp.y, sp.z), yaw: sp.yaw, pitch: sp.pitch, alive: sp.alive === 1, weapon: sp.weapon,
    };
  }

  /** `death` event: tip over away from the shot (dir = attacker → victim). */
  onDeath(id: number, dir: Vec3): void { const v = this.views.get(id); if (v) v.deathDir = new Vector3(dir.x, 0, dir.z); else this.pendingDeath.set(id, new Vector3(dir.x, 0, dir.z)); }
  /** hit flinch + 60 ms red flash; `from` = attacker position (or shot origin). */
  onHit(id: number, from: Vec3, clock: number): void {
    const v = this.views.get(id); if (!v) return;
    v.hitDir.set(v.pos.x - from.x, 0, v.pos.z - from.z); if (v.hitDir.lengthSq() < 1e-6) v.hitDir.set(0, 0, 1); v.hitDir.normalize();
    v.flashUntil = clock + 0.06;
  }
  private readonly pendingDeath = new Map<number, Vector3>();
  /** Corpse tip-over directions (carried across a setQuality rebuild): dead views plus deaths not yet seen. */
  deathDirs(): Map<number, Vector3> {
    const m = new Map<number, Vector3>(this.pendingDeath);
    for (const [id, v] of this.views) if (!v.alive && v.deathDir) m.set(id, v.deathDir.clone());
    return m;
  }
  restoreDeathDirs(m: ReadonlyMap<number, Vector3>): void { for (const [id, d] of m) this.pendingDeath.set(id, d.clone()); }

  update(prev: RenderSnapshot, next: RenderSnapshot, alpha: number, o: CharFrameOpts): void {
    this.frame++;
    for (const b of this.torso) b.begin(); this.helmet.begin();
    for (let i = 0; i < next.playerCount; i++) {
      const sp = next.players[i];
      let pp: SnapPlayer = sp;
      for (let j = 0; j < prev.playerCount; j++) if (prev.players[j].id === sp.id) { pp = prev.players[j]; break; }
      let v = this.views.get(sp.id);
      if (!v || v.team !== sp.team) { v = this.create(sp); this.views.set(sp.id, v); }
      v.seen = this.frame;
      const pd = this.pendingDeath.get(sp.id); if (pd) { v.deathDir = pd; this.pendingDeath.delete(sp.id); }
      if (sp.alive && !v.wasAlive) { v.deathDir = null; v.crouchF = sp.crouch; }
      v.wasAlive = sp.alive === 1;
      // interpolation (positions lerp, angles shortest arc); teleports snap
      const far = Math.abs(sp.x - pp.x) + Math.abs(sp.z - pp.z) > 3;
      const t = far ? 1 : alpha;
      v.pos.set(pp.x + (sp.x - pp.x) * t, pp.y + (sp.y - pp.y) * t, pp.z + (sp.z - pp.z) * t);
      v.yaw = pp.yaw + wrapAngle(sp.yaw - pp.yaw) * t; v.pitch = pp.pitch + wrapAngle(sp.pitch - pp.pitch) * t;
      const leg = pp.legPhase + wrapAngle(sp.legPhase - pp.legPhase) * t;
      v.alive = sp.alive === 1; v.weapon = sp.weapon;
      this.pose(v, sp, leg, o);
      if (!o.hidden(sp.id)) this.emit(v, sp, o);
    }
    for (const [id, v] of this.views) if (v.seen !== this.frame) this.views.delete(id);
    for (const b of this.torso) b.end(); this.helmet.end();
  }

  private pose(v: CharView, sp: SnapPlayer, leg: number, o: CharFrameOpts): void {
    const dt = o.dt;
    v.crouchF += clamp(sp.crouch - v.crouchF, -dt / 0.15, dt / 0.15);
    const moved = Math.abs(wrapAngle(leg - v.lastLeg)) > 1e-4; v.lastLeg = leg;
    v.moveAmp += clamp((moved ? 1 : 0) - v.moveAmp, -dt / 0.15, dt / 0.15);
    const c = v.crouchF, alive = sp.alive === 1;
    v.root.position.copy(v.pos); v.root.rotation.set(0, v.yaw, 0);
    // death: tip over ±90° about a pivot near the floor over 0.35 s away from the shot, sink 0.1 m
    const dying = !alive && sp.deathT >= 0;
    const f = !alive ? (dying ? clamp(sp.deathT / 0.35, 0, 1) : 1) : 0;
    if (f > 0) {
      const d = v.deathDir ?? _a.set(Math.sin(v.yaw), 0, Math.cos(v.yaw)); // default: fall backward
      _b.set(d.x, 0, d.z).applyAxisAngle(UP, -v.yaw); if (_b.lengthSq() < 1e-6) _b.set(0, 0, 1); _b.normalize();
      _c.crossVectors(UP, _b).normalize();
      const ease = f * f * (3 - 2 * f);
      v.tilt.quaternion.setFromAxisAngle(_c, (Math.PI / 2) * ease);
      v.root.position.y -= 0.1 * ease;
    } else v.tilt.quaternion.identity();
    const hipY = 0.92 + (0.6 - 0.92) * c;
    v.hips.position.set(0, hipY, 0);
    // torso pitch = aim pitch × 0.5 (+ hit flinch 8° away from the shot over 0.15 s)
    const torsoPitch = alive ? clamp(v.pitch, -1.2, 1.2) * 0.5 : 0;
    v.spine.rotation.set(torsoPitch, 0, 0);
    if (alive && sp.flinchT >= 0) {
      _b.copy(v.hitDir).applyAxisAngle(UP, -v.yaw); _c.crossVectors(UP, _b).normalize();
      _q.setFromAxisAngle(_c, 8 * DEG * (1 - sp.flinchT)); v.spine.quaternion.premultiply(_q);
    }
    const torsoH = 0.6 + (0.5 - 0.6) * c, torsoC = 0.28 + (0.25 - 0.28) * c;
    const P = v.parts;
    P.torso.node.position.set(0, torsoC, 0); P.torso.size.y = torsoH;
    P.vest.node.position.set(0, torsoC + 0.05, 0); P.vest.size.y = 0.38 * torsoH / 0.6;
    P.pack.node.position.set(0, torsoC + 0.02, 0.2);
    v.led.position.set(0.06, torsoC + 0.12, 0.252);
    const neckY = 0.58 + (0.4 - 0.58) * c;
    v.neck.position.set(0, neckY, 0); v.neck.rotation.set(torsoPitch, 0, 0);
    v.aim.position.set(0, neckY - 0.07, 0); v.aim.rotation.set(torsoPitch, 0, 0);
    // weapon in the right hand; arms by two-bone IK toward the grip / fore-grip
    const wid = sp.weapon >= 0 ? WEAPON_INDEX[sp.weapon] : null;
    const pistol = wid === 'glock' || wid === 'usp' || wid === 'deagle';
    const oneHand = wid === 'knife' || wid === 'he' || wid === 'flash' || wid === null;
    if (!alive) v.mount.position.set(0.15, -0.35, -0.1);
    else if (pistol) v.mount.position.set(0.04, -0.06, -0.5);
    else if (oneHand) v.mount.position.set(0.24, -0.28, -0.3);
    else v.mount.position.set(0.08, -0.12, -0.32);
    v.mount.rotation.set(0, 0, 0);
    const handR = _a.copy(v.mount.position);
    const handL = pistol ? _b.set(handR.x - 0.04, handR.y - 0.02, handR.z + 0.02) : oneHand || !alive ? _b.set(-0.26, -0.52, -0.06) : _b.set(handR.x - 0.03, handR.y - 0.02, handR.z - 0.18);
    arm(P.uaR.node, P.faR.node, _c.set(0.31, 0, 0), handR, 1);
    arm(P.uaL.node, P.faL.node, _v.set(-0.31, 0, 0), handL, -1);
    // legs: swing ±35°·sin(phase), crouch thighs 70°, shins keep the feet on the ground
    const swing = 35 * DEG * Math.sin(leg) * v.moveAmp * (1 - c * 0.7) * (alive ? 1 : 0);
    const base = 70 * DEG * c;
    for (const [th, kn, s] of [[v.thighL, v.kneeL, 1], [v.thighR, v.kneeR, -1]] as const) {
      const a = base + swing * s;
      const kneeH = hipY - 0.45 * Math.cos(a);
      const beta = Math.acos(clamp(kneeH / 0.45, 0, 1));
      const walkBend = 25 * DEG * v.moveAmp * Math.max(0, -Math.sin(leg) * s) * (alive ? 1 : 0);
      th.rotation.set(a, 0, 0); kn.rotation.set(-(a + beta) - walkBend, 0, 0);
    }
    v.root.updateMatrixWorld(true);
    // world-space muzzle and eye (camera follow / effects)
    if (wid) muzzleOffset(wid as WeaponModelId, v.muzzle).applyMatrix4(v.mount.matrixWorld);
    else v.muzzle.set(0, 0, 0).applyMatrix4(v.mount.matrixWorld);
    v.eye.set(0, 0.04, -0.02).applyMatrix4(P.head.node.matrixWorld);
  }

  private emit(v: CharView, sp: SnapPlayer, o: CharFrameOpts): void {
    const P = v.parts, alive = sp.alive === 1;
    const flash = o.clock < v.flashUntil;
    const torso = this.torso[sp.team];
    const tint = (c: Color) => (flash ? _col.copy(c).lerp(FLASH, 0.7) : c);
    torso.push(_m.copy(P.torso.node.matrixWorld).scale(P.torso.size), flash ? FLASH : WHITE);
    const plain = this.shared.plain;
    for (const k of ['hips', 'head', 'uaL', 'uaR', 'faL', 'faR', 'thL', 'thR', 'shL', 'shR'] as const) plain.push(_m.copy(P[k].node.matrixWorld).scale(P[k].size), tint(P[k].color));
    if (sp.armor > 0) plain.push(_m.copy(P.vest.node.matrixWorld).scale(P.vest.size), tint(P.vest.color));
    if (sp.hasBomb) {
      plain.push(_m.copy(P.pack.node.matrixWorld).scale(P.pack.size), tint(P.pack.color));
      if (alive && (o.clock % 1) < 0.12) this.shared.led.push(_m.copy(v.led.matrixWorld).scale(_v.set(0.03, 0.03, 0.01)));
    }
    if (sp.helmet) this.helmet.push(_m.copy(P.helmet.node.matrixWorld).scale(P.helmet.size), tint(P.helmet.color));
    if (alive && sp.weapon >= 0) this.shared.weapon(WEAPON_INDEX[sp.weapon], v.mount.matrixWorld);
    // blob shadow: fades (shrinks) during the tip-over, gone on corpses
    const fade = alive ? 1 : sp.deathT >= 0 ? 1 - clamp(sp.deathT / 0.35, 0, 1) : 0;
    if (fade > 0.05) this.shared.shadow.push(_m.makeScale(0.9 * fade, 1, 0.9 * fade).setPosition(v.pos.x, v.pos.y + 0.02, v.pos.z));
  }

  dispose(): void { for (const b of this.torso) b.dispose(); this.helmet.dispose(); this.views.clear(); }
}

const _col = new Color();
const _s = new Vector3(), _e = new Vector3(), _d = new Vector3(), _pole = new Vector3();
/** Two-bone IK in the aim frame: upper arm 0.32, forearm 0.30, elbow pushed out/down by the pole. */
function arm(upper: Object3D, fore: Object3D, shoulder: Vector3, hand: Vector3, side: 1 | -1): void {
  const a = 0.32, b = 0.3;
  _d.subVectors(hand, shoulder); let d = _d.length();
  if (d < 1e-4) { _d.set(0, -1, 0); d = 1e-4; }
  _d.divideScalar(d);
  d = clamp(d, 0.05, a + b - 1e-3);
  const cosA = clamp((a * a + d * d - b * b) / (2 * a * d), -1, 1), sinA = Math.sqrt(1 - cosA * cosA);
  _pole.set(0.6 * side, -1, 0.4); _pole.addScaledVector(_d, -_pole.dot(_d)).normalize();
  _e.copy(shoulder).addScaledVector(_d, cosA * a).addScaledVector(_pole, sinA * a);
  _s.copy(shoulder).addScaledVector(_d, d);
  segment(upper, shoulder, _e); segment(fore, _e, _s);
}
function segment(node: Object3D, from: Vector3, to: Vector3): void {
  node.position.addVectors(from, to).multiplyScalar(0.5);
  _v2.subVectors(to, from); if (_v2.lengthSq() < 1e-9) _v2.set(0, -1, 0); _v2.normalize();
  node.quaternion.setFromUnitVectors(YAXIS, _v2);
}
const _v2 = new Vector3();
