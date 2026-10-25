/**
 * First-person viewmodel (§10.4): own Scene + camera (FOV 60, near 0.01) rendered after the world pass with
 * autoClear = false + clearDepth(), so the gun never clips into walls. Motion comes from viewmodelMath.ts;
 * this module only owns the meshes (weapon groups per WeaponId with 'mag' / 'slide' / 'bolt' / 'muzzle',
 * team-coloured arms), the human's muzzle flash and the bomb's white screen flash.
 */
import { Scene, PerspectiveCamera, Group, Mesh, BoxGeometry, PlaneGeometry, Object3D, Vector3, Quaternion, Color, AmbientLight, HemisphereLight, DirectionalLight, MeshBasicMaterial, DoubleSide, Float32BufferAttribute, type Material, type WebGLRenderer, type Camera } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { WEAPON_INDEX, type WeaponId } from '../sim/state';
import { WEAPONS } from '../weapons/defs';
import { buildWeaponGroup, type PartMat } from './models/weapons';
import { flashGeometry } from './effects/muzzle';
import { ViewmodelMotion, kickFromPattern, type VmPose, type VmInput } from './viewmodelMath';
import type { MaterialLib } from './materials';
import type { Rng } from '../core/rng';

export const LIGHT = { ambient: 0.55, hemi: 0.5, dir: 0.8, scale: Math.PI * 0.85 } as const;
export const SUN_DIR = new Vector3(-1, 2, -0.5).normalize();

export class Viewmodel {
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(60, 1, 0.01, 20);
  readonly motion = new ViewmodelMotion();
  private readonly root = new Group();
  private readonly holder = new Group();
  private readonly groups = new Map<WeaponId, Group>();
  private readonly armR: Mesh;
  private readonly armL: Mesh;
  private readonly sun: DirectionalLight;
  private readonly flash: Mesh;
  private readonly screen: Mesh;
  private readonly owned: { dispose(): void }[] = [];
  private current: WeaponId | null = null;
  private target: WeaponId | null = null;
  private flashUntil = -1;
  private screenT = -1;
  private readonly pose: VmPose = { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, magY: 0, slideZ: 0, swapNow: false };

  constructor(private readonly lib: MaterialLib, team: 0 | 1) {
    this.scene.name = 'viewmodel';
    const k = LIGHT.scale;
    this.scene.add(new AmbientLight('#ffffff', LIGHT.ambient * k), new HemisphereLight('#cfd6e6', '#3a3326', LIGHT.hemi * k));
    this.sun = new DirectionalLight('#ffffff', LIGHT.dir * k); this.scene.add(this.sun, this.sun.target);
    this.scene.add(this.root); this.root.add(this.holder);
    this.root.rotation.order = 'YXZ';
    this.armR = this.buildArm(team, false); this.armL = this.buildArm(team, true); this.root.add(this.armR, this.armL);
    const fm = lib.additive(lib.sprite('muzzle')); fm.side = DoubleSide;
    this.flash = new Mesh(flashGeometry(), fm); this.flash.visible = false; this.flash.renderOrder = 10;
    const sm = new MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0, depthTest: false, depthWrite: false, fog: false }); this.owned.push(sm);
    this.screen = new Mesh(new PlaneGeometry(1, 1), sm); this.screen.position.set(0, 0, -0.05); this.screen.scale.set(0.5, 0.5, 1); this.screen.visible = false; this.screen.renderOrder = 20;
    this.camera.add(this.screen); this.scene.add(this.camera);
  }

  private mats = (m: PartMat): Material => {
    const L = this.lib;
    if (m === 'metal') return L.shared('vm:metal', () => L.lit({ map: L.texture('gun_metal') }));
    if (m === 'wood') return L.shared('vm:wood', () => L.lit({ map: L.texture('wood_stock') }));
    if (m === 'lcd') return L.shared('vm:lcd', () => L.basic({ color: '#39ff88' }));
    const col: Record<string, string> = { green: '#4f5a3d', silver: '#aeb3ba', olive: '#4a5233', dark: '#1e2023', blade: '#c9ccd1', red: '#c03030', yellow: '#d8b400', lens: '#203850' };
    return L.shared('vm:' + m, () => L.lit({ color: col[m] ?? '#888888' }));
  };

  /** One forearm + hand (merged, vertex coloured): hand at the origin, forearm along +y toward the elbow. */
  private buildArm(team: 0 | 1, left: boolean): Mesh {
    const sleeve = new Color(team === 0 ? '#b8943f' : '#3d6fb5'), glove = new Color('#2a2a2a'), skin = new Color('#c99d78');
    const parts: [number, number, number, number, Color][] = [[0.085, 0.42, 0.085, 0.24, sleeve], [0.065, 0.1, 0.06, 0.0, left && team === 0 ? skin : glove], [0.09, 0.04, 0.09, 0.05, sleeve]];
    const geos = parts.map(([w, h, d, y, c]) => {
      const g = new BoxGeometry(w, h, d).toNonIndexed(); g.translate(0, y, 0); g.deleteAttribute('uv');
      const n = g.getAttribute('position').count, col = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
      g.setAttribute('color', new Float32BufferAttribute(col, 3)); return g;
    });
    const merged = mergeGeometries(geos, false)!; geos.forEach((g) => g.dispose());
    const m = new Mesh(merged, this.lib.vertexLit()); m.name = left ? 'armL' : 'armR'; this.owned.push(merged);
    return m;
  }

  /** Hand / elbow targets per weapon class (grip-origin frame): right hand on the grip, left on the fore-grip. */
  private poseArms(id: WeaponId | null): void {
    const t = id ? WEAPONS[id].type : 'melee';
    const place = (arm: Mesh, hand: [number, number, number], elbow: [number, number, number]) => {
      arm.position.set(...hand);
      _v.set(elbow[0] - hand[0], elbow[1] - hand[1], elbow[2] - hand[2]).normalize();
      arm.quaternion.setFromUnitVectors(_up, _v);
    };
    place(this.armR, [0, -0.04, 0.03], [0.14, -0.3, 0.34]);
    this.armL.visible = t === 'pistol' || t === 'smg' || t === 'rifle' || t === 'sniper';
    if (t === 'pistol') place(this.armL, [-0.035, -0.05, 0.0], [-0.24, -0.32, 0.22]);
    else { const z = id === 'mp5' ? -0.2 : id === 'awp' ? -0.32 : -0.27; place(this.armL, [-0.005, -0.01, z], [-0.26, -0.34, 0.02]); }
  }

  private group(id: WeaponId): Group {
    let g = this.groups.get(id);
    if (!g) { g = buildWeaponGroup(id, this.mats); g.visible = false; this.holder.add(g); this.groups.set(id, g); }
    return g;
  }

  /** Builds every weapon group up front (avoids a shader compile / geometry upload hitch on first switch). */
  prewarm(): void { for (const id of WEAPON_INDEX) this.group(id); }

  setAspect(a: number): void { this.camera.aspect = a; this.camera.updateProjectionMatrix(); }

  /** Weapon shown when no switch animation is running; a change starts the lower/raise animation. */
  setWeapon(index: number): void {
    const id = index >= 0 ? WEAPON_INDEX[index] : null;
    if (id === this.target) return;
    this.target = id;
    if (this.current === null) { this.showNow(id); return; }
    this.motion.startSwitch();
  }
  private showNow(id: WeaponId | null): void {
    if (this.current) this.group(this.current).visible = false;
    this.current = id;
    if (id) this.group(id).visible = true;
    this.armR.visible = id !== null; this.poseArms(id);
  }
  get weapon(): WeaponId | null { return this.current; }

  onShot(weapon: WeaponId, clock: number, rng: Rng): void {
    const def = WEAPONS[weapon];
    if (def.slot === 4 || weapon === 'knife') return;
    this.motion.onShot(kickFromPattern(def.pattern[0][0]));
    const muzzle = this.muzzleNode(); if (!muzzle) return;
    muzzle.add(this.flash); this.flash.visible = true; this.flash.rotation.set(0, 0, rng.range(0, Math.PI * 2));
    this.flash.scale.setScalar(rng.range(0.12, 0.25) * (weapon === 'usp' || weapon === 'mp5' ? 0.5 : 1));
    this.flashUntil = clock + 0.035;
  }
  screenFlash(): void { this.screenT = 0; }
  private muzzleNode(): Object3D | undefined { return this.current ? this.group(this.current).getObjectByName('muzzle') : undefined; }

  update(inp: VmInput, clock: number, camQuat: Quaternion): void {
    const p = this.motion.update(inp, this.pose);
    if (p.swapNow) this.showNow(this.target);
    this.root.position.set(p.x, p.y, p.z); this.root.rotation.set(p.rx, p.ry, p.rz);
    if (this.current) {
      const g = this.group(this.current);
      const mag = g.getObjectByName('mag'); if (mag) mag.position.y = p.magY;
      const slide = g.getObjectByName('slide') ?? g.getObjectByName('bolt'); if (slide) slide.position.z = p.slideZ;
    }
    if (this.flash.visible && clock >= this.flashUntil) this.flash.visible = false;
    // keep the viewmodel lit like the world: sun direction expressed in camera space
    _q.copy(camQuat).invert(); this.sun.position.copy(SUN_DIR).applyQuaternion(_q).multiplyScalar(5); this.sun.target.position.set(0, 0, 0);
    if (this.screenT >= 0) {
      this.screenT += inp.dt;
      const mat = this.screen.material as MeshBasicMaterial;
      mat.opacity = Math.max(0, 1 - this.screenT / 0.15); this.screen.visible = mat.opacity > 0;
      if (this.screenT > 0.15) { this.screenT = -1; this.screen.visible = false; }
    }
  }

  /** Re-projects the viewmodel muzzle into the world camera (tracer start for the human, §10.5). */
  muzzleWorld(worldCam: Camera, out: Vector3): Vector3 | null {
    const m = this.muzzleNode(); if (!m) return null;
    this.root.updateMatrixWorld(true);
    m.getWorldPosition(_v); const depth = -_v.z;
    _v.project(this.camera);
    _dir.set(_v.x, _v.y, 0.5).unproject(worldCam).sub(worldCam.position).normalize();
    return out.copy(worldCam.position).addScaledVector(_dir, Math.max(0.3, depth * 1.2));
  }

  get screenFlashing(): boolean { return this.screenT >= 0; }

  render(r: WebGLRenderer, showGun: boolean): void {
    this.root.visible = showGun;
    if (!showGun && !this.screenFlashing) return;
    r.clearDepth();
    r.render(this.scene, this.camera);
  }

  dispose(): void {
    this.scene.traverse((o) => { if (o instanceof Mesh) o.geometry.dispose(); });
    for (const o of this.owned) o.dispose();
    this.groups.clear();
  }
}

const _q = new Quaternion(), _v = new Vector3(), _dir = new Vector3(), _up = new Vector3(0, 1, 0);
