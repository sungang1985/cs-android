/**
 * Shared instanced batches + world props (§10.2, §10.5): weapon batches (one per WeaponId + C4, vertex
 * coloured), plain boxes (per-instance colour: limbs, heads, vests, targets, kits), LEDs, blob shadows;
 * items on the ground (SnapItem), grenades in flight (SnapGrenade), training targets (SnapTarget) and the
 * planted bomb with its blinking LED.
 */
import { BoxGeometry, PlaneGeometry, Group, Color, Matrix4, Quaternion, Vector3, Euler, type Material } from 'three';
import { WEAPON_INDEX, type RenderSnapshot } from '../../sim/state';
import { clamp } from '../../core/math';
import { InstBatch } from './batch';
import { buildMergedWeapon, ledOffset, type WeaponModelId } from './weapons';
import { bombBlinkInterval } from '../viewmodelMath';
import type { MaterialLib } from '../materials';

const MODEL_IDS: readonly WeaponModelId[] = [...WEAPON_INDEX, 'c4'];

export class SharedBatches {
  readonly group = new Group();
  readonly weapons = new Map<WeaponModelId, InstBatch>();
  readonly plain: InstBatch;
  readonly led: InstBatch;
  readonly shadow: InstBatch;
  constructor(lib: MaterialLib) {
    this.group.name = 'shared-batches';
    const vlit = lib.vertexLit();
    for (const id of MODEL_IDS) { const b = new InstBatch(buildMergedWeapon(id), vlit, 48, false, 'weapon:' + id); this.weapons.set(id, b); this.group.add(b.mesh); }
    this.plain = new InstBatch(new BoxGeometry(1, 1, 1), lib.plain(), 320, true, 'plain'); this.group.add(this.plain.mesh);
    this.led = new InstBatch(new BoxGeometry(1, 1, 1), lib.basic({ color: '#ff2020' }), 16, false, 'led'); this.group.add(this.led.mesh);
    const sh = new PlaneGeometry(1, 1); sh.rotateX(-Math.PI / 2);
    this.shadow = new InstBatch(sh, lib.basic({ map: lib.sprite('blob_shadow'), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }) as Material, 16, false, 'shadow');
    this.group.add(this.shadow.mesh);
  }
  begin(): void { for (const b of this.weapons.values()) b.begin(); this.plain.begin(); this.led.begin(); this.shadow.begin(); }
  end(): void { for (const b of this.weapons.values()) b.end(); this.plain.end(); this.led.end(); this.shadow.end(); }
  weapon(id: WeaponModelId, m: Matrix4): void { this.weapons.get(id)?.push(m); }
  dispose(): void { for (const b of this.weapons.values()) b.dispose(); this.plain.dispose(); this.led.dispose(); this.shadow.dispose(); }
}

const _m = new Matrix4(), _m2 = new Matrix4(), _m3 = new Matrix4(), _q = new Quaternion(), _e = new Euler(0, 0, 0, 'YXZ'), _p = new Vector3(), _s = new Vector3(), _v = new Vector3();
const KIT_COLOR = new Color('#3a3d42'), KIT_STRIPE = new Color('#d8b400');
const TARGET = { body: new Color('#e8e4da'), head: new Color('#e04545'), base: new Color('#2b2d31'), ring: new Color('#e07030') };

function trs(x: number, y: number, z: number, yaw: number, pitch: number, roll: number, sx = 1, sy = 1, sz = 1): Matrix4 {
  _q.setFromEuler(_e.set(pitch, yaw, roll, 'YXZ'));
  return _m.compose(_p.set(x, y, z), _q, _s.set(sx, sy, sz));
}

/** parent × local TRS (separate scratch so `trs` can be reused for the local part). */
function child(parent: Matrix4, x: number, y: number, z: number, sx: number, sy: number, sz: number): Matrix4 { return _m3.multiplyMatrices(parent, trs(x, y, z, 0, 0, 0, sx, sy, sz)); }

export class PropSystem {
  private readonly targetAngle = new Map<number, { a: number; seen: number }>();
  private frame = 0;
  private blinkAcc = 0; private ledOnUntil = 0;
  constructor(private readonly b: SharedBatches) {}

  /** Items, grenades, targets and the planted bomb (LED blink driven by the renderer clock). */
  update(prev: RenderSnapshot, next: RenderSnapshot, alpha: number, clock: number, dt: number): void {
    const b = this.b;
    // items on the ground
    for (let i = 0; i < next.itemCount; i++) {
      const it = next.items[i];
      if (it.kind === 0 && it.weapon >= 0) b.weapon(WEAPON_INDEX[it.weapon], trs(it.x, it.y + 0.04, it.z, it.yaw, 0, Math.PI / 2));
      else if (it.kind === 1) b.weapon('c4', trs(it.x, it.y, it.z, it.yaw, 0, 0));
      else if (it.kind === 2) { b.plain.push(trs(it.x, it.y + 0.04, it.z, it.yaw, 0, 0, 0.26, 0.08, 0.18), KIT_COLOR); b.plain.push(trs(it.x, it.y + 0.085, it.z, it.yaw, 0, 0, 0.2, 0.012, 0.04), KIT_STRIPE); }
    }
    // grenades in flight (interpolated by id, spinning)
    for (let i = 0; i < next.grenadeCount; i++) {
      const g = next.grenades[i];
      let x = g.x, y = g.y, z = g.z;
      for (let j = 0; j < prev.grenadeCount; j++) { const pg = prev.grenades[j]; if (pg.id === g.id) { x = pg.x + (g.x - pg.x) * alpha; y = pg.y + (g.y - pg.y) * alpha; z = pg.z + (g.z - pg.z) * alpha; break; } }
      b.weapon(g.kind === 0 ? 'he' : 'flash', trs(x, y - 0.03, z, clock * 7 + g.id, clock * 11, 0));
    }
    // training targets: box men that lie down (rotate back about their base) while up == 0
    const frame = ++this.frame;
    for (let i = 0; i < next.targetCount; i++) {
      const t = next.targets[i];
      const goal = t.up ? 0 : Math.PI / 2;
      let st = this.targetAngle.get(t.id);
      if (!st) { st = { a: goal, seen: frame }; this.targetAngle.set(t.id, st); }
      st.seen = frame; st.a += clamp(goal - st.a, -dt * 9, dt * 9);
      const a = st.a;
      const yaw = Math.PI / 2; // face west, toward T spawn / the training entrance
      _m2.copy(trs(t.x, t.y, t.z, yaw, a, 0));
      b.plain.push(child(_m2, 0, 0.025, 0, 0.7, 0.05, 0.5), TARGET.base);
      b.plain.push(child(_m2, 0, 0.75, 0, 0.5, 1.4, 0.3), TARGET.body);
      b.plain.push(child(_m2, 0, 1.1, -0.155, 0.3, 0.3, 0.02), TARGET.ring);
      b.plain.push(child(_m2, 0, 1.62, 0, 0.28, 0.32, 0.28), TARGET.head);
    }
    for (const [id, st] of this.targetAngle) if (st.seen !== frame) this.targetAngle.delete(id);
    // planted bomb + LED (interval 1.0·(remaining/35)^1.6 + 0.05 s)
    if (next.bomb.state === 3) {
      const bm = next.bomb;
      _m2.copy(trs(bm.x, bm.y, bm.z, 0.3, 0, 0));
      b.weapon('c4', _m2);
      this.blinkAcc += dt;
      if (this.blinkAcc >= bombBlinkInterval(bm.remaining)) { this.blinkAcc = 0; this.ledOnUntil = clock + 0.08; }
      if (clock < this.ledOnUntil) { ledOffset(_v).applyMatrix4(_m2); b.led.push(trs(_v.x, _v.y, _v.z, 0, 0, 0, 0.025, 0.012, 0.025)); }
    } else this.blinkAcc = 0;
  }
}
