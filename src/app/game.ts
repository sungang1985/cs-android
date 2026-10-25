/**
 * App shell (§11.6): owns the loop, the sim, every adapter and the UI bus. The only place that touches the
 * sim, the loop and the input from UI actions.
 */
import { FixedLoop } from '../core/loop';
import { EventBus } from '../core/events';
import { Rng } from '../core/rng';
import { compileMap, buildStaticWorld } from '../world/compile';
import { buildNavGraph } from '../nav/navgraph';
import { DEPOT } from '../maps/depot';
import { Simulation } from '../sim/sim';
import { createSnapshot, Btn, cloneCommand, type MatchConfig, type RenderSnapshot, type InputCommand, type Spotted, type Team } from '../sim/state';
import type { SimEnvelope, SimEvents } from '../sim/events';
import { createBotBrain } from '../ai/brain';
import { makeProfiles } from '../ai/profiles';
import { GameRenderer } from '../render/renderer';
import { Radar } from '../render/radar';
import { InputSystem } from '../input/inputSystem';
import { AudioEngine } from '../audio/engine';
import { Hud } from '../ui/hud';
import { Screens } from '../ui/screens';
import { BuyMenu } from '../ui/buyMenu';
import type { UiEvents, UiAction, LifetimeStats } from '../ui/dom';
import { persist } from '../platform/persist';
import { bridge } from '../platform/android';
import { haptics } from '../platform/haptics';
import { pwa } from '../platform/pwa';
import { cloneSettings, cloneLayout, type Settings, type TouchLayout, type QualityPreset } from '../settings/types';
import { buildMatchConfig, pickSeed } from './matchSettings';
import { MatchStats, EMPTY_STATS } from './stats';
import { Perf } from './perf';
import { t, setLocale, getLocale } from '../i18n/i18n';
import { canPlant, canDefuse } from '../rules/bomb';

export interface GameOptions { canvas: HTMLCanvasElement; uiRoot: HTMLElement; radarCanvas: HTMLCanvasElement; settings: Settings; layout: TouchLayout; search: string; now: () => number }

export class Game {
  readonly bus = new EventBus<UiEvents>();
  readonly renderer: GameRenderer;
  readonly radar: Radar;
  readonly input: InputSystem;
  readonly audio = new AudioEngine();
  readonly hud: Hud;
  readonly screens: Screens;
  readonly buyMenu: BuyMenu;
  readonly loop: FixedLoop;
  readonly perf = new Perf();
  sim: Simulation | null = null;
  cfg: MatchConfig | null = null;
  prev: RenderSnapshot = createSnapshot();
  next: RenderSnapshot = createSnapshot();
  settings: Settings;
  layout: TouchLayout;
  private spotted: Spotted[] = [];
  private stats: MatchStats | null = null;
  private frame = 0;
  private inMatch = false;
  private paused = false;
  private override: { partial: Partial<InputCommand>; ticks: number } | null = null;
  private eventListeners = new Set<(e: SimEnvelope) => void>();
  private roundEndTimer = 0;
  private menuMapLoaded = false;
  private readonly seedRng: Rng;
  private readonly now: () => number;
  private readonly search: string;

  constructor(opts: GameOptions) {
    this.settings = cloneSettings(opts.settings); this.layout = cloneLayout(opts.layout);
    this.now = opts.now; this.search = opts.search;
    this.seedRng = new Rng(pickSeed(opts.search, opts.now()));
    this.renderer = new GameRenderer(opts.canvas, { quality: this.settings.quality === 'auto' ? 'medium' : this.settings.quality, fov: this.settings.controls.fovDeg });
    this.radar = new Radar(opts.radarCanvas);
    this.input = new InputSystem(opts.canvas, this.settings.controls, this.layout);
    this.input.onUiAction((id, down) => {
      switch (id) {
        case 'pause': if (this.inMatch) { this.input.releasePointer(); this.pause(true); } break;
        case 'openBuy': this.input.releasePointer(); this.onAction('openBuy'); break;
        case 'scoreboard':
          if (this.sim && this.cfg) { if (down === false) this.screens.hide('scoreboard'); else this.screens.show('scoreboard', { snapshot: this.next, humanTeam: this.humanTeamNow(), mvp: this.sim.state.round.mvp }); }
          break;
        default: this.onAction(id);
      }
    });
    this.hud = new Hud(opts.uiRoot, this.bus);
    this.hud.setSettings(this.settings.controls);
    this.hud.onScoreboard((show) => { if (show && this.sim) this.screens.show('scoreboard', { snapshot: this.next, humanTeam: this.humanTeamNow(), mvp: this.sim.state.round.mvp }); else this.screens.hide('scoreboard'); });
    this.screens = new Screens(opts.uiRoot, this.bus);
    this.buyMenu = new BuyMenu(opts.uiRoot, this.bus);
    this.buyMenu.onBuy((item) => this.input.setBuy(item));
    this.loop = new FixedLoop((dt) => this.tick(dt), (alpha, frameDt) => this.render(alpha, frameDt), { maxSteps: 8 });
    this.perf.auto = this.settings.quality === 'auto';
    this.perf.onQualityStep = (q) => { this.renderer.setQuality(q); this.onResize(); };
    this.applyFpsCap();
    this.bus.on('action', (a) => this.onAction(a.id, a.payload));
    this.bus.on('screen', () => this.syncTouchVisibility());
    this.bus.on('settingsChanged', (s) => this.applySettings(s));
    this.bus.on('layoutChanged', (l) => { this.layout = cloneLayout(l); this.input.setLayout(this.layout); this.hud.setLayout(this.layout); persist.set('layout', this.layout); });
    bridge.onBack(() => { const r = this.onBack(); if (r === 'handled') this.audio.ui('back'); return r; });
    opts.uiRoot.addEventListener('click', (e) => this.uiClick(e.target), true); // capture: buttons stop propagation
    this.audio.arm(); // first launch boots straight into onboarding: unlock on the first gesture (§9.3)
    bridge.onLifecycle((s) => { if (s === 'pause') { if (this.inMatch) this.pause(true); this.audio.suspend(); } else this.audio.resume(); });
    window.addEventListener('resize', () => this.onResize());
    this.onResize();
    this.hud.show(false);
    pwa.onUpdateAvailable(() => { if (!this.inMatch) this.showMain(); });
  }

  /** The human's CURRENT side (sides swap at the half). */
  humanTeamNow(): Team { const s = this.sim; const p = s?.state.players.find((q) => q.id === s.state.humanId); return p?.team ?? this.cfg?.humanTeam ?? 'CT'; }

  // ───────── match lifecycle ─────────
  startMatchFromPartial(partial: Partial<MatchConfig> & { humanTeam?: Team | 'random' }): void {
    const cfg = buildMatchConfig(partial, this.settings, this.seedRng.nextU32() % 1_000_000, () => this.seedRng.next());
    this.startMatch(cfg);
  }

  startMatch(cfg: MatchConfig, restoreJson?: string): void {
    this.stopMatch();
    const map = compileMap(DEPOT, cfg.mode === 'training' ? 'training' : 'match');
    if (map.training) this.screens.setOnboardingTarget(map.training.onboardingPos);
    const world = buildStaticWorld(map);
    const nav = buildNavGraph(map, world);
    const deps = { map, world, nav, brains: createBotBrain() };
    this.sim = restoreJson ? Simulation.restore(restoreJson, deps) : new Simulation(deps, cfg, makeProfiles(cfg));
    // alias the sim's own cfg (a restore parses a separate copy): the half-time swap writes state.cfg.humanTeam
    this.cfg = this.sim.state.cfg;
    this.renderer.loadMap(map); this.radar.loadMap(map); this.audio.setWorld(world);
    const human = this.sim.state.players.find((p) => p.id === this.sim!.state.humanId);
    this.input.setLook(human ? human.yaw : 0, 0);
    this.audio.setLocalTeam(human ? human.team : cfg.humanTeam);
    this.prev = createSnapshot(); this.next = createSnapshot();
    this.sim.writeSnapshot(this.next); this.sim.writeSnapshot(this.prev);
    this.stats = new MatchStats(this.sim.state.humanId);
    this.spotted = []; this.inMatch = true; this.paused = false;
    for (const s of this.screens.visible()) this.screens.hide(s);
    this.hud.show(true); this.input.attach(); this.input.setSettings(this.settings.controls); this.syncTouchVisibility();
    this.renderer.menuScene(false); this.audio.startAmbient();
    this.loop.timeScale = 1; this.loop.pause(false); this.loop.start();
  }

  stopMatch(): void {
    if (!this.inMatch) return;
    this.inMatch = false; this.loop.stop(); this.input.detach(); this.hud.show(false); this.buyMenu.close(); this.audio.stopAmbient();
    if (this.roundEndTimer) { clearTimeout(this.roundEndTimer); this.roundEndTimer = 0; }
    this.sim = null; this.cfg = null;
  }

  showMain(): void {
    this.stopMatch();
    for (const s of this.screens.visible()) this.screens.hide(s);
    if (!this.menuMapLoaded) { this.renderer.loadMap(compileMap(DEPOT, 'match')); this.menuMapLoaded = true; }
    this.renderer.menuScene(true);
    this.screens.show('main', { canContinue: persist.get<unknown>('match', null) !== null, updateAvailable: pwa.hasUpdate() });
  }

  pause(p: boolean): void {
    if (!this.inMatch || this.paused === p) return;
    this.paused = p; this.loop.pause(p); this.input.setPaused(p);
    if (p) { this.input.releasePointer(); this.screens.show('pause', { canBuy: this.next.local.canBuy === 1 }); } else this.screens.hide('pause');
  }
  get isPaused(): boolean { return this.paused; }
  get isInMatch(): boolean { return this.inMatch; }

  // ───────── frame sequence (§11.6) ─────────
  private tick(dt: number): void { void dt; this.tickOnce(); }

  /** One sim tick + drain (also used synchronously by the test hooks). */
  tickOnce(): void {
    const sim = this.sim; if (!sim) return;
    const t0 = performance.now();
    let cmd = this.input.sample(sim.state.tick + 1, sim.aimCandidates(), this.next.local);
    if (this.override) { cmd = { ...cmd, ...this.override.partial, tick: cmd.tick }; if (--this.override.ticks <= 0) this.override = null; }
    sim.step(cmd);
    const tmp = this.prev; this.prev = this.next; this.next = tmp;
    sim.writeSnapshot(this.next);
    const local = this.next.local;
    for (const e of sim.events.drain()) {
      this.audio.handle(e, local); this.renderer.handleEvent(e); this.hud.handleEvent(e); haptics.handle(e, local); this.stats?.handle(e); this.handleEvent(e);
      for (const fn of this.eventListeners) fn(e);
    }
    this.perf.sample(0, performance.now() - t0, 0);
  }

  private render(alpha: number, frameDt: number): void {
    const sim = this.sim; if (!sim) return;
    const t0 = performance.now();
    const preview = this.input.previewLook(sim.aimCandidates(), this.next.local);
    this.renderer.render(this.prev, this.next, alpha, preview, frameDt);
    if (this.frame++ % 3 === 0) { this.hud.update(this.next); this.radar.draw(this.next, this.spotted, this.renderer.getViewYaw()); this.updateUseHint(); if (this.buyMenu.isOpen) this.buyMenu.update(this.next.local, this.humanTeamNow()); }
    this.audio.syncTick(sim.state.tick);
    this.audio.setListener(this.renderer.cameraPose());
    const rs = this.renderer.stats; this.perf.drawCalls = rs.drawCalls; this.perf.triangles = rs.triangles;
    this.perf.sample(frameDt * 1000, this.loop.stats.simMs, performance.now() - t0);
  }

  private handleEvent(e: SimEnvelope): void {
    const sim = this.sim!;
    switch (e.type) {
      case 'spotted': { const d = e.data as SimEvents['spotted']; if (d.team === this.humanTeamNow()) { const i = this.spotted.findIndex((s) => s.enemy === d.enemy); const entry = { enemy: d.enemy, x: d.pos.x, z: d.pos.z, yaw: 0, tick: sim.state.tick }; if (i >= 0) this.spotted[i] = entry; else this.spotted.push(entry); } break; }
      case 'roundEnd': {
        const d = e.data as SimEvents['roundEnd'];
        this.loop.timeScale = 0.5;
        this.roundEndTimer = window.setTimeout(() => { this.loop.timeScale = 1; this.roundEndTimer = 0; }, 1500);
        if (this.cfg) this.screens.show('roundEnd', { winner: d.winner, reason: d.reason, mvp: d.mvp, deltas: d.deltas, scoreT: sim.state.round.scoreT, scoreCT: sim.state.round.scoreCT, humanTeam: this.humanTeamNow(), names: {} });
        break;
      }
      case 'roundPhase': {
        const d = e.data as SimEvents['roundPhase'];
        if (d.phase === 'FREEZE') {
          this.screens.hide('roundEnd'); this.loop.timeScale = 1; this.spotted = [];
          const me = sim.state.players.find((p) => p.id === sim.state.humanId); if (me) { this.input.setLook(me.yaw, 0); this.audio.setLocalTeam(me.team); } // spawn facing, half swap
          if (this.cfg && this.cfg.mode === 'defusal') persist.set('match', { cfg: this.cfg, state: sim.serialize(), savedAt: this.now() });
        }
        if (d.phase === 'LIVE') this.screens.hide('roundEnd');
        break;
      }
      case 'respawn': { const d = e.data as SimEvents['respawn']; if (d.player === sim.state.humanId) { const me = sim.state.players.find((p) => p.id === d.player); if (me) this.input.setLook(me.yaw, 0); } break; }
      case 'matchEnd': {
        const d = e.data as SimEvents['matchEnd'];
        persist.remove('match');
        const human = sim.state.players.find((p) => p.id === sim.state.humanId)!;
        const result = d.result === 'draw' ? 'draw' : d.result === human.team ? 'win' : 'lose';
        this.stats?.commit(result, this.settings.controls.aimAssist);
        this.loop.pause(true); this.paused = true; this.input.setPaused(true);
        this.screens.hide('roundEnd');
        if (this.cfg) this.screens.show('matchEnd', { result: d.result, humanTeam: human.team, scoreT: d.scoreT, scoreCT: d.scoreCT, mvp: sim.state.round.mvp, personal: { ...human.stats, accuracy: human.stats.shots ? human.stats.hits / human.stats.shots : 0, hsPercent: human.stats.kills ? human.stats.headshots / human.stats.kills : 0 }, assistLevel: this.settings.controls.aimAssist, cfg: this.cfg });
        break;
      }
    }
  }

  // ───────── UI actions ─────────
  private onAction(id: UiAction, payload?: unknown): void {
    switch (id) {
      case 'play': void this.audio.unlock(); void bridge.requestImmersive(); this.screens.hide('main'); this.screens.show('mode', { last: persist.get<MatchConfig | null>('lastSettings', null) }); break;
      case 'training': void this.audio.unlock(); void bridge.requestImmersive(); this.startMatchFromPartial({ mode: 'training' }); break;
      case 'startMatch': void this.audio.unlock(); void bridge.requestImmersive(); this.startMatchFromPartial((payload ?? {}) as Partial<MatchConfig>); break;
      case 'continue': { const saved = persist.get<{ cfg: MatchConfig; state: string } | null>('match', null); if (saved) { void this.audio.unlock(); this.startMatch(saved.cfg, saved.state); } break; }
      case 'resume': this.pause(false); break;
      case 'quit': this.showMain(); break;
      case 'menu': this.showMain(); break;
      case 'rematch': if (this.cfg) { const last = persist.get<Partial<MatchConfig> | null>('lastSettings', null); const team = (last?.humanTeam as Team | 'random' | undefined) ?? this.cfg.humanTeam; this.startMatch({ ...this.cfg, humanTeam: team === 'random' ? this.cfg.humanTeam : team, seed: this.cfg.seed + 1 }); } break;
      case 'changeMode': { const last = this.cfg; this.stopMatch(); for (const s of this.screens.visible()) this.screens.hide(s); this.screens.show('mode', { last }); break; }
      case 'drop': this.input.press(Btn.DROP); this.pause(false); break;
      case 'openBuy': if (this.sim && this.cfg) { this.input.releasePointer(); this.buyMenu.open(this.next.local, this.humanTeamNow()); this.syncTouchVisibility(); } break;
      case 'closeBuy': this.buyMenu.close(); this.syncTouchVisibility(); break;
      case 'skipRound': this.loop.timeScale = 4; break;
      case 'spectatePrev': this.input.spectate(-1); break;
      case 'spectateNext': this.input.spectate(1); break;
      case 'resetData': for (const k of ['settings', 'layout', 'stats', 'onboarding', 'match', 'loadout', 'lastSettings'] as const) persist.remove(k); break;
      case 'applyUpdate': pwa.applyUpdate(); break;
      case 'marker': this.renderer.setMarker((payload as { x: number; y: number; z: number } | null) ?? null); break;
      case 'onboardingDone': persist.update('onboarding', { done: true }, { done: false, assistChosen: false }); break;
    }
  }

  /** UI click feedback (§9.3): back buttons → ui_back, other buttons → ui_tap; buy tiles sound via the sim's buy event. */
  private uiClick(target: EventTarget | null): void {
    const b = (target as Element | null)?.closest?.('button');
    if (!b || b.closest('.buy-tile, .buy-preset')) return;
    this.audio.ui(b.classList.contains('btn-back') ? 'back' : 'tap');
  }

  private onBack(): 'handled' | 'exit' | 'none' {
    if (this.buyMenu.isOpen) { this.buyMenu.close(); return 'handled'; }
    if (this.screens.back()) return 'handled';
    if (this.inMatch) { if (!this.paused) { this.pause(true); return 'handled'; } return 'handled'; }
    if (this.screens.visible().includes('main')) return 'exit';
    return 'none';
  }

  private applySettings(s: Settings): void {
    this.settings = cloneSettings(s);
    this.input.setSettings(this.settings.controls);
    this.hud.setSettings(this.settings.controls);
    this.renderer.setFov(this.settings.controls.fovDeg);
    if (this.settings.quality !== 'auto') { this.perf.auto = false; this.renderer.setQuality(this.settings.quality); } else { this.perf.auto = true; this.renderer.setQuality(this.perf.effective); }
    this.onResize();
    this.audio.setVolumes(this.settings.volume);
    bridge.hapticsEnabled = this.settings.haptics;
    this.applyFpsCap();
    this.sim?.setOptions({ autoPickup: this.settings.autoPickup, scopeHold: this.settings.scopeHold });
    if (this.settings.locale !== 'auto' && this.settings.locale !== getLocale()) setLocale(this.settings.locale);
    persist.set('settings', this.settings);
  }

  private applyFpsCap(): void { this.loop.fpsCap = this.settings.batterySaver ? 30 : this.settings.fpsCap; }

  private onResize(): void {
    const w = window.innerWidth, h = window.innerHeight;
    const cap = this.renderer.getQuality() === 'low' ? 1 : this.renderer.getQuality() === 'high' ? 2 : 1.5;
    const dpr = Math.min(window.devicePixelRatio || 1, cap);
    this.renderer.resize(w, h, dpr);
    this.hud.setView({ fovDeg: this.renderer.getFov(), width: w, height: h });
    const portrait = h > w && bridge.isTouch();
    if (portrait) { if (!this.screens.visible().includes('rotate')) this.screens.show('rotate'); } else this.screens.hide('rotate');
  }

  /** Touch controls are hidden under any screen or the buy menu (they would bleed through the overlays). */
  private syncTouchVisibility(): void {
    const covered = this.screens.visible().some((s) => s !== 'rotate') || this.buyMenu.isOpen;
    this.input.setTouchVisible(this.inMatch && !covered);
  }

  /** Use-pill hint (§7.2): 1 plant, 2 defuse, 3 pick up, 0 none — the snapshot only carries an ACTIVE use action. */
  private updateUseHint(): void {
    const sim = this.sim; if (!sim) return;
    const me = sim.state.players.find((p) => p.id === sim.state.humanId);
    if (!me || !me.alive) { this.input.setUseHint(0); return; }
    if (me.use.action !== 'none') { this.input.setUseHint(me.use.action === 'plant' ? 1 : me.use.action === 'defuse' ? 2 : 3); return; }
    if (canPlant(me, sim.state, sim.deps.map)) { this.input.setUseHint(1); return; }
    if (canDefuse(me, sim.state)) { this.input.setUseHint(2); return; }
    const near = sim.state.items.some((it) => Math.abs(it.pos.x - me.pos.x) <= 1 && Math.abs(it.pos.z - me.pos.z) <= 1 && (it.kind === 'weapon' || (it.kind === 'bomb' && me.team === 'T') || (it.kind === 'kit' && me.team === 'CT')));
    this.input.setUseHint(near ? 3 : 0);
  }

  /** First launch (§7.6): training range with the guided onboarding; otherwise the main menu. */
  boot(skipOnboarding: boolean): void {
    const ob = persist.get<{ done: boolean }>('onboarding', { done: false });
    if (!skipOnboarding && !ob.done) { this.startMatchFromPartial({ mode: 'training' }); this.screens.onboardingStep(0); }
    else this.showMain();
  }

  // ───────── hooks for tests / debug ─────────
  onEvent(fn: (e: SimEnvelope) => void): () => void { this.eventListeners.add(fn); return () => { this.eventListeners.delete(fn); }; }
  overrideInput(partial: Partial<InputCommand>, ticks: number): void { this.override = { partial, ticks }; }
  lifetimeStats(): LifetimeStats { return persist.get<LifetimeStats>('stats', EMPTY_STATS); }
  setQualityPreset(q: QualityPreset): void { this.bus.emit('settingsChanged', { ...this.settings, quality: q }); }
  idleCommand(): InputCommand { return cloneCommand(); }
  title(): string { return t('app.title'); }
}
