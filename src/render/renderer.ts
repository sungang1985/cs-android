/**
 * GameRenderer (§11.8, §10): Three.js WebGL2 renderer behind the binding interface. Mirrors the
 * RenderSnapshot (views keyed by entity id, interpolated by alpha), draws event-driven effects, a separate
 * viewmodel pass, and a main-menu cinematic with its own rAF loop (the app's FixedLoop is stopped there).
 */
import { WebGLRenderer, Scene, Group, Color, FogExp2, AmbientLight, HemisphereLight, DirectionalLight, PointLight, Vector3, DoubleSide, type Mesh } from 'three';
import type { Vec3, Aabb } from '../core/math';
import { v3, clamp, wrapAngle, rayAabb, aabbFaceNormal, DEG, smoothstep } from '../core/math';
import { Rng } from '../core/rng';
import type { CompiledMap } from '../world/types';
import { WEAPON_INDEX, createSnapshot, BODY, type RenderSnapshot, type LookPreview, type SnapPlayer } from '../sim/state';
import type { SimEnvelope, SimEvents } from '../sim/events';
import type { QualityPreset } from '../settings/types';
import { WEAPONS } from '../weapons/defs';
import { QUALITY, resolveQuality, type QualitySpec } from './quality';
import { MaterialLib } from './materials';
import { MapMesh } from './mapMesh';
import { isDrawn } from './mapGeometry';
import { buildPointLights, Marker, menuDiorama } from './dressing';
import { CameraRig } from './cameraRig';
import { Viewmodel, LIGHT, SUN_DIR } from './viewmodel';
import { SharedBatches, PropSystem } from './models/props';
import { CharacterSystem } from './models/humanoid';
import { ParticlePool, emitImpact, emitBlood } from './effects/particles';
import { Tracers } from './effects/tracers';
import { DecalRing } from './effects/decals';
import { MuzzleFlashes } from './effects/muzzle';
import { Explosions } from './effects/explosions';
import { ThrowPreview } from './effects/trajectory';
import { explosionShake } from './viewmodelMath';

export interface RendererStats { drawCalls: number; triangles: number; frameMs: number }
export const FOG = { color: '#1c1e22', density: 0.018 } as const;

type MapLike = Pick<CompiledMap, 'solids' | 'renderHints' | 'floorY' | 'sites' | 'spawns' | 'bounds'>;

/** Everything that depends on the quality preset (rebuilt by setQuality). */
interface World {
  lib: MaterialLib; spec: QualitySpec; root: Group;
  shared: SharedBatches; chars: CharacterSystem; props: PropSystem; vm: Viewmodel; vmTeam: 0 | 1;
  tracers: Tracers; holes: DecalRing; blood: DecalRing; dust: ParticlePool; sparks: ParticlePool; smoke: ParticlePool;
  flashes: MuzzleFlashes; booms: Explosions; preview: ThrowPreview; marker: Marker;
  mapMesh: MapMesh | null; lights: Group | null; menuMesh: MapMesh | null;
  /** High only: 1-frame muzzle PointLight (always present so toggling never recompiles shaders). */
  muzzleLight: PointLight | null; muzzleLightFrames: number;
}

export class GameRenderer {
  readonly stats: RendererStats = { drawCalls: 0, triangles: 0, frameMs: 0 };
  private readonly gl: WebGLRenderer | null;
  private quality: QualityPreset;
  private fov: number;
  private readonly scene = new Scene();
  private readonly rig: CameraRig;
  private w: World | null = null;
  private map: MapLike | null = null;
  private solidBoxes: Aabb[] = [];
  private readonly pose = { pos: v3(0, 1.65, 0), fwd: v3(0, 0, -1), up: v3(0, 1, 0) };
  private clock = 0;
  private readonly fx = new Rng(4242);
  private localId = 1;
  private specId = -1;
  private markerPos: Vec3 | null = null;
  private readonly shotCount = new Map<number, number>();
  private readonly lastShotDir = new Map<number, Vec3>();
  private lastYaw = NaN; private lastPitch = 0;
  private aliveYaw = 0; private alivePitch = 0; private viewYaw = 0;
  private menu = false; private menuRaf = 0; private menuLast = 0; private menuFrame = 0;
  /** Tests: when false, nothing is drawn (DOM screenshots under software WebGL would otherwise stall). */
  private drawingEnabled = true;
  setDrawingEnabled(b: boolean): void { this.drawingEnabled = b; }
  private menuSnap: RenderSnapshot | null = null;
  private dio: MapLike | null = null;
  private readonly eye = new Vector3(); private readonly tgt = new Vector3();
  private width = 1; private height = 1;

  constructor(private readonly canvas: HTMLCanvasElement, opts: { quality: QualityPreset; fov: number }) {
    this.quality = opts.quality; this.fov = opts.fov;
    this.rig = new CameraRig(opts.fov);
    let gl: WebGLRenderer | null = null;
    try {
      gl = new WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
      gl.autoClear = false; gl.info.autoReset = false; gl.setClearColor(new Color(FOG.color), 1);
    } catch { gl = null; }
    this.gl = gl;
    this.scene.fog = new FogExp2(new Color(FOG.color).getHex(), FOG.density);
    const k = LIGHT.scale;
    const sun = new DirectionalLight('#ffffff', LIGHT.dir * k); sun.position.copy(SUN_DIR).multiplyScalar(30);
    this.scene.add(new AmbientLight('#ffffff', LIGHT.ambient * k), new HemisphereLight('#cfd6e6', '#3a3326', LIGHT.hemi * k), sun, sun.target);
    this.scene.add(this.rig.camera);
    if (gl) this.buildWorld();
  }

  get webgl2(): boolean { return this.gl !== null; }
  getQuality(): QualityPreset { return this.quality; }
  getFov(): number { return this.fov; }
  /** Current vertical FOV incl. the AWP zoom (20° / 10°) — for the HUD crosshair projection while scoped. */
  getEffectiveFov(): number { return this.rig.fov; }
  /** Yaw of the camera actually shown (spectated player / kill-cam included) — for the radar while dead. */
  getViewYaw(): number { return this.viewYaw; }

  // ───────── quality-dependent world ─────────
  private buildWorld(): void {
    const gl = this.gl!;
    const spec = QUALITY[resolveQuality(this.quality)];
    const lib = new MaterialLib(spec, gl.capabilities.getMaxAnisotropy());
    const root = new Group(); root.name = 'world';
    const shared = new SharedBatches(lib);
    const chars = new CharacterSystem(lib, shared);
    const tracers = new Tracers(spec.tracers, lib.additive(null, '#fff2c0', 0.6));
    const holes = new DecalRing(spec.decals, lib.basic({ map: lib.sprite('bullet_hole'), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }), 'holes');
    const blood = new DecalRing(Math.min(64, spec.decals), lib.basic({ map: lib.sprite('blood_decal'), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }), 'blood');
    const dust = new ParticlePool(spec.particles, 0.05, lib.sprite('spark'), false, 'particles');
    const sparks = new ParticlePool(Math.max(24, spec.particles >> 2), 0.04, lib.sprite('spark'), true, 'sparks');
    const smoke = new ParticlePool(spec.particles >= 150 ? 80 : 40, 1.1, lib.sprite('smoke'), false, 'smoke');
    const fm = lib.additive(lib.sprite('muzzle')); fm.side = DoubleSide;
    const flashes = new MuzzleFlashes(fm);
    const booms = new Explosions();
    const preview = new ThrowPreview(lib.sprite('spark'));
    const marker = new Marker(lib.additive(lib.sprite('ring'), '#ffd54f', 0.9), lib.additive(null, '#ffd54f', 0.25));
    const props = new PropSystem(shared);
    const vm = new Viewmodel(lib, 0); vm.prewarm();
    root.add(shared.group, chars.group, tracers.batch.mesh, holes.batch.mesh, blood.batch.mesh, dust.points, sparks.points, smoke.points, flashes.batch.mesh, booms.group, preview.points, marker.mesh);
    this.scene.add(root);
    const muzzleLight = spec.pointLights > 0 ? new PointLight('#ffc070', 0, 6, 1.5) : null;
    if (muzzleLight) root.add(muzzleLight);
    this.w = { lib, spec, root, shared, chars, props, vm, vmTeam: 0, tracers, holes, blood, dust, sparks, smoke, flashes, booms, preview, marker, mapMesh: null, lights: null, menuMesh: null, muzzleLight, muzzleLightFrames: 0 };
    vm.setAspect(this.width / this.height);
    if (this.markerPos) marker.set(this.markerPos);
    if (this.map) this.buildMap(this.map);
    if (this.menu) this.applyMenuVisibility();
  }

  private teardownWorld(): void {
    const w = this.w; if (!w) return;
    this.scene.remove(w.root);
    w.mapMesh?.dispose(); w.menuMesh?.dispose();
    if (w.mapMesh) w.root.remove(w.mapMesh.group);
    if (w.lights) this.scene.remove(w.lights);
    w.shared.dispose(); w.chars.dispose(); w.tracers.dispose(); w.holes.dispose(); w.blood.dispose(); w.dust.dispose(); w.sparks.dispose(); w.smoke.dispose(); w.flashes.dispose(); w.booms.dispose(); w.preview.dispose(); w.marker.dispose(); w.vm.dispose();
    w.lib.dispose();
    this.w = null;
  }

  private buildMap(map: MapLike): void {
    const w = this.w; if (!w) return;
    if (w.mapMesh) { w.root.remove(w.mapMesh.group); w.mapMesh.dispose(); }
    if (w.lights) { this.scene.remove(w.lights); w.lights = null; }
    w.mapMesh = new MapMesh(map, w.lib); w.root.add(w.mapMesh.group);
    w.lights = buildPointLights(map, w.spec.pointLights, 6 * LIGHT.scale); this.scene.add(w.lights);
    w.preview.setSolids(map.solids.map((s) => s.box));
    if (w.menuMesh) w.menuMesh.group.visible = false;
    this.gl?.compile(this.scene, this.rig.camera);
    this.gl?.compile(w.vm.scene, w.vm.camera);
  }

  loadMap(map: CompiledMap): void {
    this.map = map;
    this.solidBoxes = map.solids.filter(isDrawn).map((s) => s.box);
    this.clearEffects();
    if (this.w) this.buildMap(map);
  }

  setQuality(q: QualityPreset): void {
    const changed = resolveQuality(q) !== resolveQuality(this.quality);
    this.quality = q;
    if (!changed || !this.gl) return;
    this.teardownWorld(); this.buildWorld();
  }
  setFov(deg: number): void { this.fov = deg; this.rig.setFov(deg); }

  resize(w: number, h: number, dpr: number): void {
    this.width = Math.max(1, w); this.height = Math.max(1, h);
    if (this.gl) { this.gl.setPixelRatio(dpr); this.gl.setSize(this.width, this.height, false); }
    else { this.canvas.width = Math.round(w * dpr); this.canvas.height = Math.round(h * dpr); }
    this.rig.setAspect(this.width / this.height); this.w?.vm.setAspect(this.width / this.height);
  }

  dispose(): void {
    this.stopMenuLoop();
    this.teardownWorld();
    this.gl?.dispose();
    this.map = null;
  }

  cameraPose(): { pos: Vec3; fwd: Vec3; up: Vec3 } { return this.pose; }

  setMarker(pos: Vec3 | null): void { this.markerPos = pos ? v3(pos.x, pos.y, pos.z) : null; this.w?.marker.set(this.markerPos); }

  // ───────── per frame ─────────
  render(prev: RenderSnapshot, next: RenderSnapshot, alpha: number, preview: LookPreview, frameDt: number): void {
    if (!this.drawingEnabled) return;
    const t0 = performance.now();
    const gl = this.gl, w = this.w;
    const l = next.local;
    this.localId = l.id || 1;
    if (!gl || !w || this.menu) {
      this.pose.pos.x = l.eyeX; this.pose.pos.y = l.eyeY; this.pose.pos.z = l.eyeZ;
      if (!gl || !w) { this.stats.drawCalls = 0; this.stats.triangles = 0; this.stats.frameMs = performance.now() - t0; }
      return;
    }
    const dt = clamp(frameDt, 0, 0.1);
    this.clock += dt;
    const me = findPlayer(next, l.id);
    if (me && me.team !== w.vmTeam) this.rebuildViewmodel(me.team);
    // camera mode (decided from ids first so the right model can be hidden)
    let mode: 'fp' | 'killcam' | 'spec' | 'deathcam' = 'fp';
    if (!l.alive) {
      const deathT = me ? me.deathT : -1;
      if (deathT >= 0 && deathT < 1.8 && l.killerId > 0 && findPlayer(next, l.killerId)) mode = 'killcam';
      else if (l.spectating > 0 && findPlayer(next, l.spectating)) mode = 'spec';
      else mode = 'deathcam';
    }
    const specId = mode === 'spec' ? l.spectating : -1, localId = l.id;
    this.specId = specId;
    const hidden = (id: number) => (id === localId && (mode === 'fp' || mode === 'killcam')) || id === specId;
    w.shared.begin();
    w.chars.update(prev, next, alpha, { hidden, clock: this.clock, dt, showAll: false });
    w.props.update(prev, next, alpha, this.clock, dt);
    w.shared.end();
    // camera
    let camYaw = preview.yaw, camPitch = preview.pitch;
    if (mode === 'fp') {
      const pl = prev.local, far = Math.abs(l.eyeX - pl.eyeX) + Math.abs(l.eyeZ - pl.eyeZ) > 3, t = far ? 1 : alpha;
      this.eye.set(pl.eyeX + (l.eyeX - pl.eyeX) * t, pl.eyeY + (l.eyeY - pl.eyeY) * t, pl.eyeZ + (l.eyeZ - pl.eyeZ) * t);
      camYaw = preview.yaw + 0.5 * l.aimOffsetYaw; camPitch = preview.pitch + 0.5 * l.aimOffsetPitch;
      this.rig.update(dt, this.eye, camYaw, camPitch, l.scoped);
      this.aliveYaw = camYaw; this.alivePitch = camPitch;
    } else if (mode === 'killcam' && me) {
      const mv = w.chars.views.get(localId), kv = w.chars.views.get(l.killerId)!;
      const f = smoothstep(0, 0.35, me.deathT);
      const base = mv ? mv.pos : this.eye.set(me.x, me.y, me.z);
      this.eye.set(base.x, base.y + BODY.standEye - 0.9 * f, base.z);
      this.tgt.copy(kv.eye).sub(this.eye);
      const ty = Math.atan2(-this.tgt.x, -this.tgt.z), tp = Math.atan2(this.tgt.y, Math.hypot(this.tgt.x, this.tgt.z));
      const u = smoothstep(0.1, 0.8, me.deathT);
      camYaw = this.aliveYaw + wrapAngle(ty - this.aliveYaw) * u; camPitch = this.alivePitch + (tp - this.alivePitch) * u;
      this.rig.update(dt, this.eye, camYaw, camPitch, 0);
    } else if (mode === 'spec') {
      const sv = w.chars.views.get(specId)!;
      this.eye.set(sv.pos.x, sv.pos.y + BODY.standEye - (BODY.standEye - BODY.crouchEye) * sv.crouchF, sv.pos.z);
      camYaw = sv.yaw; camPitch = sv.pitch;
      this.rig.update(dt, this.eye, camYaw, camPitch, 0);
    } else {
      const mv = w.chars.views.get(localId);
      const c = mv ? mv.pos : this.tgt.set(l.x, l.eyeY - BODY.standEye, l.z);
      this.tgt.set(c.x, c.y + 0.3, c.z);
      this.eye.set(c.x + Math.sin(this.aliveYaw) * 2, c.y + 2.4, c.z + Math.cos(this.aliveYaw) * 2);
      this.rig.lookAt(this.eye, this.tgt, dt);
      camYaw = this.aliveYaw;
    }
    this.viewYaw = camYaw;
    // effects
    if (w.muzzleLight && w.muzzleLightFrames-- <= 0) w.muzzleLight.intensity = 0;
    w.tracers.update(dt); w.flashes.update(); w.booms.update(dt);
    w.dust.update(dt); w.sparks.update(dt); w.smoke.update(dt); w.marker.update(this.clock);
    if (mode === 'fp') w.preview.update(this.eye, preview.yaw, preview.pitch, l.throwHoldT, this.floorAt); else w.preview.update(this.eye, 0, 0, -1, this.floorAt);
    // viewmodel
    const showGun = mode === 'fp' && l.weapon >= 0 && !this.rig.scopedIn && l.scoped === 0;
    if (!w.vm.motion.switching) w.vm.setWeapon(l.weapon);
    const dYaw = Number.isNaN(this.lastYaw) ? 0 : wrapAngle(preview.yaw - this.lastYaw), dPitch = preview.pitch - this.lastPitch;
    const big = Math.abs(dYaw) > 0.6 || Math.abs(dPitch) > 0.6;
    this.lastYaw = preview.yaw; this.lastPitch = preview.pitch;
    const wid = l.weapon >= 0 ? WEAPON_INDEX[l.weapon] : 'knife';
    const def = WEAPONS[wid];
    w.vm.update({ dt, speed: l.speed, maxSpeed: l.scoped && def.scopedSpeed ? def.scopedSpeed : def.speed, crouch: l.crouch === 1, grounded: l.grounded === 1, dYaw: big ? 0 : dYaw, dPitch: big ? 0 : dPitch, reloadT: me ? me.reloadT : -1 }, this.rig.camera.quaternion);
    // draw
    gl.info.reset();
    gl.clear(true, true, true);
    gl.render(this.scene, this.rig.camera);
    w.vm.render(gl, showGun);
    this.finishFrame(t0);
  }

  private finishFrame(t0: number): void {
    const gl = this.gl!;
    this.stats.drawCalls = gl.info.render.calls; this.stats.triangles = gl.info.render.triangles;
    this.stats.frameMs = performance.now() - t0;
    const p = this.pose, r = this.rig;
    p.pos.x = r.pos.x; p.pos.y = r.pos.y; p.pos.z = r.pos.z; p.fwd.x = r.fwd.x; p.fwd.y = r.fwd.y; p.fwd.z = r.fwd.z; p.up.x = r.up.x; p.up.y = r.up.y; p.up.z = r.up.z;
  }

  private readonly floorAt = (x: number, z: number): number => (this.map ? this.map.floorY(x, z) : 0);

  private rebuildViewmodel(team: 0 | 1): void {
    const w = this.w!; w.vm.dispose();
    w.vm = new Viewmodel(w.lib, team); w.vm.prewarm(); w.vm.setAspect(this.width / this.height); w.vmTeam = team;
  }

  // ───────── events (§10.5: all effects are event-driven) ─────────
  handleEvent(e: SimEnvelope): void {
    const w = this.w; if (!w) return;
    const me = this.localId;
    switch (e.type) {
      case 'shot': {
        const d = e.data as SimEvents['shot'];
        const def = WEAPONS[d.weapon];
        this.lastShotDir.set(d.shooter, v3(d.dir.x, d.dir.y, d.dir.z));
        if (def.slot === 4 || d.weapon === 'knife') break;
        const n = (this.shotCount.get(d.shooter) ?? 0) + 1; this.shotCount.set(d.shooter, n);
        let origin: Vec3 = d.origin;
        const firstPerson = d.shooter === me && w.vm.weapon !== null && !this.rig.scopedIn && !this.menu;
        if (firstPerson) {
          w.vm.onShot(d.weapon, this.fx);
          const p = w.vm.muzzleWorld(this.rig.camera, this.tgt); if (p) origin = v3(p.x, p.y, p.z);
        } else {
          const v = w.chars.views.get(d.shooter);
          // no world flash for a model the camera sits in (scoped human, spectated player)
          if (v && v.alive) { origin = v3(v.muzzle.x, v.muzzle.y, v.muzzle.z); if (d.weapon !== 'usp' && d.weapon !== 'mp5' && d.shooter !== me && d.shooter !== this.specId) w.flashes.add(origin, d.dir, this.fx); }
        }
        if (d.weapon === 'awp' || n % 2 === 0) w.tracers.add(origin, d.end);
        if (w.muzzleLight && d.weapon !== 'usp' && d.weapon !== 'mp5') { w.muzzleLight.position.set(origin.x, origin.y, origin.z); w.muzzleLight.intensity = 4 * LIGHT.scale; w.muzzleLightFrames = 1; }
        break;
      }
      case 'hit': {
        const d = e.data as SimEvents['hit'];
        const dir = this.lastShotDir.get(d.attacker) ?? this.dirBetween(d.attacker, d.victim);
        const av = w.chars.views.get(d.attacker);
        w.chars.onHit(d.victim, av ? av.pos : v3(d.point.x - dir.x, d.point.y, d.point.z - dir.z), this.clock);
        emitBlood(w.dust, this.fx, d.point, dir);
        this.bloodDecal(d.point, dir);
        break;
      }
      case 'impact': {
        const d = e.data as SimEvents['impact'];
        w.holes.add(d.point, d.normal, 0.08, this.fx.range(0, Math.PI * 2));
        emitImpact(w.dust, w.sparks, this.fx, d.point, d.normal, d.surface);
        break;
      }
      case 'damageTaken': { const d = e.data as SimEvents['damageTaken']; if (d.victim === me) this.rig.shake.add(0.4 * DEG, 0.1); break; }
      case 'death': { const d = e.data as SimEvents['death']; w.chars.onDeath(d.victim, d.dir); break; }
      case 'land': { const d = e.data as SimEvents['land']; if (d.player === me) w.vm.motion.onLand(d.impact); break; }
      case 'weaponSwitch': { const d = e.data as SimEvents['weaponSwitch']; if (d.player === me) w.vm.setWeapon(WEAPON_INDEX.indexOf(d.weapon)); break; }
      case 'knife': { const d = e.data as SimEvents['knife']; if (d.player === me) w.vm.motion.onKnife(d.stab); break; }
      case 'grenadeThrow': { const d = e.data as SimEvents['grenadeThrow']; if (d.owner === me) w.vm.motion.onThrow(); break; }
      case 'grenadeExplode': {
        const d = e.data as SimEvents['grenadeExplode'];
        w.booms.add(d.kind === 'he' ? 'he' : 'flash', d.pos, w.smoke, w.sparks, this.fx);
        if (d.kind === 'he') this.rig.shake.add(explosionShake(this.distToCam(d.pos)), 0.6);
        break;
      }
      case 'bombExploded': {
        const d = e.data as SimEvents['bombExploded'];
        w.booms.add('bomb', d.pos, w.smoke, w.sparks, this.fx);
        this.rig.shake.add(explosionShake(this.distToCam(d.pos)), 0.6);
        w.vm.screenFlash();
        break;
      }
      case 'roundPhase': { const d = e.data as SimEvents['roundPhase']; if (d.phase === 'FREEZE') { this.clearEffects(); this.shotCount.clear(); this.lastShotDir.clear(); } break; }
      default: break;
    }
  }

  private distToCam(p: Vec3): number { const c = this.rig.pos; return Math.hypot(p.x - c.x, p.y - c.y, p.z - c.z); }
  private dirBetween(a: number, b: number): Vec3 {
    const va = this.w?.chars.views.get(a), vb = this.w?.chars.views.get(b);
    if (!va || !vb) return v3(0, 0, -1);
    const dx = vb.pos.x - va.pos.x, dz = vb.pos.z - va.pos.z, l = Math.hypot(dx, dz) || 1;
    return v3(dx / l, 0, dz / l);
  }

  /** Blood splat on the nearest surface within 2 m behind the victim, else on the floor below. */
  private bloodDecal(p: Vec3, dir: Vec3): void {
    const w = this.w!;
    const l = Math.hypot(dir.x, dir.y, dir.z) || 1, d = v3(dir.x / l, dir.y / l, dir.z / l);
    let best = 2, box: Aabb | null = null;
    for (const b of this.solidBoxes) { const t = rayAabb(p, d, b, best); if (t !== null && t > 0 && t < best) { best = t; box = b; } }
    const size = this.fx.range(0.35, 0.6), roll = this.fx.range(0, Math.PI * 2);
    if (box) { const hp = v3(p.x + d.x * best, p.y + d.y * best, p.z + d.z * best); w.blood.add(hp, aabbFaceNormal(box, hp), size, roll); }
    else { const x = p.x + d.x * 0.6, z = p.z + d.z * 0.6; w.blood.add(v3(x, this.floorAt(x, z), z), v3(0, 1, 0), size * 1.2, roll); }
  }

  private clearEffects(): void {
    const w = this.w; if (!w) return;
    w.holes.clear(); w.blood.clear(); w.tracers.clear(); w.dust.clear(); w.sparks.clear(); w.smoke.clear(); w.flashes.clear(); w.booms.clear();
  }

  // ───────── main-menu cinematic ─────────
  menuScene(on: boolean): void {
    if (on === this.menu) return;
    this.menu = on;
    this.applyMenuVisibility();
    if (on) this.startMenuLoop(); else this.stopMenuLoop();
  }

  private applyMenuVisibility(): void {
    const w = this.w; if (!w) return;
    const on = this.menu;
    // hide players, items and transient effects; keep the static map
    w.chars.group.visible = true; w.shared.group.visible = true;
    if (on) for (const o of [w.tracers.batch.mesh, w.holes.batch.mesh, w.blood.batch.mesh, w.dust.points, w.sparks.points, w.smoke.points, w.flashes.batch.mesh, w.preview.points] as Mesh[]) o.visible = false;
    else this.clearEffects();
    w.booms.group.visible = !on;
    if (on && !this.map && !w.menuMesh) {
      w.menuMesh = new MapMesh(this.dio ??= menuDiorama(), w.lib); w.root.add(w.menuMesh.group);
    }
    if (w.menuMesh) w.menuMesh.group.visible = on && !this.map;
    w.marker.mesh.visible = !on && this.markerPos !== null;
  }

  private startMenuLoop(): void {
    if (typeof requestAnimationFrame === 'undefined' || this.menuRaf) return;
    this.menuLast = 0;
    const step = (now: number) => {
      this.menuRaf = requestAnimationFrame(step);
      if (this.menuFrame++ % 2) return; // 30 fps is plenty for a backdrop (battery)
      const dt = this.menuLast ? Math.min(0.1, (now - this.menuLast) / 1000) : 1 / 30;
      this.menuLast = now;
      if (this.drawingEnabled) this.renderMenu(dt);
    };
    this.menuRaf = requestAnimationFrame(step);
  }
  private stopMenuLoop(): void { if (this.menuRaf && typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(this.menuRaf); this.menuRaf = 0; }

  /** One cinematic frame: slow orbit just under the ceiling (walls 3 m, ceiling 4.5 m) around the map centre. */
  private renderMenu(dt: number): void {
    const gl = this.gl, w = this.w; if (!gl || !w) return;
    const t0 = performance.now();
    this.clock += dt;
    const src: MapLike = this.map ?? (this.dio ??= menuDiorama());
    const b = src.bounds;
    const cx = (b.min.x + b.max.x) / 2, cz = (b.min.z + b.max.z) / 2;
    const R = Math.min(b.max.x - b.min.x, b.max.z - b.min.z) * (this.map ? 0.36 : 0.32);
    const a = this.clock * 0.06;
    const h = Math.min(src.renderHints.ceilingY - 0.6, 3.9);
    this.eye.set(cx + Math.cos(a) * R, h, cz + Math.sin(a) * R);
    this.tgt.set(cx - Math.cos(a) * R * 0.2, this.map ? 0.6 : 1.0, cz - Math.sin(a) * R * 0.2);
    this.rig.lookAt(this.eye, this.tgt, dt);
    w.shared.begin();
    if (!this.map) {
      const snap = this.menuSnap ?? (this.menuSnap = dioramaSnapshot());
      w.chars.update(snap, snap, 1, { hidden: () => false, clock: this.clock, dt, showAll: true });
    } else w.chars.update(EMPTY, EMPTY, 1, { hidden: () => true, clock: this.clock, dt, showAll: false });
    w.shared.end();
    gl.info.reset();
    gl.clear(true, true, true);
    gl.render(this.scene, this.rig.camera);
    this.finishFrame(t0);
  }
}

const EMPTY = createSnapshot();

function findPlayer(s: RenderSnapshot, id: number): SnapPlayer | null {
  for (let i = 0; i < s.playerCount; i++) if (s.players[i].id === id) return s.players[i];
  return null;
}

/** Two posed team models for the diorama backdrop (T with an AK, CT with an M4, helmets and vests). */
function dioramaSnapshot(): RenderSnapshot {
  const s = createSnapshot();
  s.playerCount = 2;
  const set = (p: SnapPlayer, id: number, team: 0 | 1, x: number, z: number, yaw: number, weapon: number) => {
    p.id = id; p.team = team; p.alive = 1; p.x = x; p.y = 0; p.z = z; p.yaw = yaw; p.pitch = -0.05; p.weapon = weapon; p.armor = 100; p.helmet = 1; p.crouch = 0; p.legPhase = 0; p.flinchT = -1; p.deathT = -1; p.hasBomb = team === 0 ? 1 : 0;
  };
  set(s.players[0], 101, 0, 7.2, 11.5, 140 * DEG, WEAPON_INDEX.indexOf('ak47'));
  set(s.players[1], 102, 1, 9.4, 12.2, 205 * DEG, WEAPON_INDEX.indexOf('m4a4'));
  return s;
}
