/**
 * In-game HUD (§8.1). DOM over the canvas inside #ui; the container and every element are pointer-events: none
 * except the score tap area, the timer (5 taps → debug) and the spectator buttons. update() runs at 20 Hz and
 * writes the DOM only through change-detecting cells; events (kill feed, notices, hit marker, toasts) are applied
 * as they are drained. Positions keep the §7.2 control discs free: vitals/money live in the inert top-left band.
 */
import type { EventBus } from '../core/events';
import { WEAPON_INDEX, ROUND_PHASE_INDEX, type RenderSnapshot, type SnapLocal, type WeaponId } from '../sim/state';
import type { SimEnvelope, SimEvents } from '../sim/events';
import type { TouchLayout, ControlSettings } from '../settings/types';
import { WEAPONS } from '../weapons/defs';
import { onLocaleChange } from '../i18n/i18n';
import type { UiEvents } from './dom';
import { el, tx, tr, refillI18n, fmtMoney, fmtDelta, fmtClock, TextCell, StyleCell, FlagCell, AttrCell, type I18nParams } from './dom';
import { iconUrl, iconImg, type IconId } from './icons';
import { shared, syncRoster, playerNameKey, type UiShared } from './context';
import { crosshairGap, crosshairOffset, crosshairState, type View } from './crosshair';

const BOMB_SECONDS = 35;
const RING_C = 2 * Math.PI * 44;
const SVG_NS = 'http://www.w3.org/2000/svg';
const PH = ROUND_PHASE_INDEX;

interface PerfLike { fps?: number; frameMs?: { avg: number; p95: number }; simMs?: { avg: number; p95: number }; botMs?: { avg: number; p95: number }; renderMs?: { avg: number; p95: number }; drawCalls?: number; triangles?: number; heapMB?: number; quality?: string }

type Cell = TextCell | StyleCell | FlagCell | AttrCell;

function q(v: number, step: number): number { return Math.round(v / step) * step; }
function clamp(v: number, lo: number, hi: number): number { return v < lo ? lo : v > hi ? hi : v; }
function weaponOf(i: number): WeaponId | null { return i >= 0 && i < WEAPON_INDEX.length ? WEAPON_INDEX[i] : null; }

export class Hud {
  private readonly root: HTMLElement;
  private readonly sh: UiShared;
  private readonly cells: Cell[] = [];
  private view: View = { fovDeg: 75, width: 851, height: 393 };
  private controls: ControlSettings;
  private layout: TouchLayout;
  private scoreboardFn: ((show: boolean) => void) | null = null;
  private sbShown = false; private sbWasOpen = false; private sbDownAt = 0;
  private blindTotal = 3; private lastBlind = 0;
  private debugOn = false; private debugTimer: ReturnType<typeof setInterval> | null = null;
  private readonly botStates = new Map<number, string>();
  private timerTaps: number[] = [];
  private hitTimer: ReturnType<typeof setTimeout> | null = null;
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  private stripTimer: ReturnType<typeof setTimeout> | null = null;
  private last: SnapLocal | null = null;
  /** Screens currently visible (from bus `screen` events): the round-end banner replaces the spectator bar. */
  private readonly overlays = new Set<string>();

  // nodes
  private readonly feed: HTMLElement; private readonly deltas: HTMLElement; private readonly notice: HTMLElement; private readonly toastEl: HTMLElement;
  private readonly hit: HTMLElement; private readonly strip: HTMLElement; private readonly debug: HTMLElement;
  private readonly pipsT: HTMLElement[] = []; private readonly pipsCT: HTMLElement[] = [];
  private readonly arcs: HTMLElement[] = [];
  // cells
  private readonly c: {
    hpNum: TextCell; hpFill: StyleCell; hpColor: StyleCell; hpLow: FlagCell; arNum: TextCell; arFill: StyleCell; helmetOff: FlagCell;
    money: TextCell; bombOff: FlagCell; kitOff: FlagCell;
    digits: TextCell; amber: FlagCell; planted: FlagCell; bombFill: StyleCell; timerOff: FlagCell;
    buyOff: FlagCell; buy: TextCell; scoreT: TextCell; scoreCT: TextCell; scoreOff: FlagCell;
    cross: StyleCell; crossGap: StyleCell; crossState: AttrCell; crossOff: FlagCell;
    ammoOff: FlagCell; ammoIcon: AttrCell; mag: TextCell; reserve: TextCell; ammoState: AttrCell; ammoHint: TextCell; heOff: FlagCell; flOff: FlagCell; he: TextCell; fl: TextCell; heSel: FlagCell; flSel: FlagCell;
    ringOff: FlagCell; ring: AttrCell; ringLabel: TextCell;
    vignette: StyleCell; flash: StyleCell; scopeOff: FlagCell;
    specOff: FlagCell; specName: TextCell; specKiller: TextCell; skipOff: FlagCell;
    debugOff: FlagCell; debugText: TextCell; lefty: FlagCell;
    arc: StyleCell[]; pipOn: FlagCell[]; pipOff: FlagCell[];
  };

  constructor(parent: HTMLElement, private readonly bus: EventBus<UiEvents>, opts: { search?: string } = {}) {
    this.sh = shared(bus);
    this.sh.hud = this;
    this.controls = { ...this.sh.settings.controls };
    this.layout = this.sh.layout;
    bus.on('settingsChanged', (s) => { this.controls = { ...s.controls }; });
    bus.on('layoutChanged', (l) => this.setLayout(l));
    bus.on('screen', (s) => {
      if (s.name === 'scoreboard' && !s.visible) this.sbShown = false;
      if (s.visible) this.overlays.add(s.name); else this.overlays.delete(s.name);
      if (this.last) this.paint(this.last);
    });

    const root = (this.root = el('div', { id: 'hud', class: 'hud', 'data-testid': 'hud' }));
    const cell = <T extends Cell>(x: T): T => { this.cells.push(x); return x; };
    const txt = (n: HTMLElement) => cell(new TextCell(n));
    const sty = (n: HTMLElement, p: string) => cell(new StyleCell(n, p));
    const flag = (n: Element, c: string) => cell(new FlagCell(n, c));
    const attr = (n: Element, a: string) => cell(new AttrCell(n, a));

    // full-screen layers (under the text)
    const flash = el('div', { class: 'hud-flash', 'data-testid': 'hud-flash' });
    const vignette = el('div', { class: 'hud-vignette', 'data-testid': 'hud-vignette' });
    const scope = el('div', { class: 'hud-scope', 'data-testid': 'hud-scope' }, [el('div', { class: 'hud-scope-h' }), el('div', { class: 'hud-scope-v' })]);
    const damage = el('div', { class: 'hud-damage', 'data-testid': 'hud-damage' });
    for (let i = 0; i < 4; i++) { const a = el('div', { class: `hud-dmg hud-dmg-${i}` }); this.arcs.push(a); damage.append(a); }

    // vitals (top-left inert band)
    const hpNum = el('span', { class: 'hud-num' }), hpFill = el('div', { class: 'hud-fill' });
    const arNum = el('span', { class: 'hud-num' }), arFill = el('div', { class: 'hud-fill hud-fill-armor' });
    const helmet = iconImg('helmet', 'hud-helmet');
    const hpRow = el('div', { class: 'hud-row hud-hp', 'data-testid': 'hud-hp' }, [el('span', { class: 'hud-glyph', text: '✚' }), hpNum, el('div', { class: 'hud-track' }, [hpFill])]);
    const arRow = el('div', { class: 'hud-row hud-armor', 'data-testid': 'hud-armor' }, [el('span', { class: 'hud-glyph hud-glyph-armor', text: '⛉' }), arNum, el('div', { class: 'hud-track' }, [arFill]), helmet]);
    const money = el('span', { class: 'hud-money-amount' });
    const bombIcon = iconImg('bomb', 'hud-carry-icon hud-carry-bomb', '#E04545'), kitIcon = iconImg('kit', 'hud-carry-icon', '#4F8FD6');
    bombIcon.dataset.testid = 'hud-bomb'; kitIcon.dataset.testid = 'hud-kit';
    this.deltas = el('div', { class: 'hud-deltas', 'data-testid': 'hud-money-deltas' });
    const moneyRow = el('div', { class: 'hud-money', 'data-testid': 'hud-money' }, [money, bombIcon, kitIcon, this.deltas]);
    const vitals = el('div', { class: 'hud-vitals' }, [hpRow, arRow, moneyRow]);

    // top centre: timer / score + pips / buy window
    const digits = el('span', { class: 'hud-digits' });
    const bombFill = el('div', { class: 'hud-fill hud-fill-bomb' });
    const bombBox = el('span', { class: 'hud-bombtimer', 'data-testid': 'hud-bombtimer' }, [iconImg('bomb', 'hud-bombtimer-icon', '#E04545'), el('span', { class: 'hud-track hud-track-bomb' }, [bombFill])]);
    const timer = el('div', { class: 'hud-timer interactive', 'data-testid': 'hud-timer' }, [digits, bombBox]);
    timer.addEventListener('pointerdown', () => this.timerTap());
    const pipsT = el('span', { class: 'hud-pips hud-pips-t' }), pipsCT = el('span', { class: 'hud-pips hud-pips-ct' });
    for (let i = 0; i < 5; i++) { const a = el('i', { class: 'pip' }), b = el('i', { class: 'pip' }); this.pipsT.push(a); this.pipsCT.push(b); pipsT.prepend(a); pipsCT.append(b); }
    const scoreT = el('b', { class: 'hud-score-t' }), scoreCT = el('b', { class: 'hud-score-ct' });
    const score = el('div', { class: 'hud-score interactive', 'data-testid': 'hud-score', role: 'button' }, [pipsT, el('span', { class: 'hud-team-t', text: 'T' }), scoreT, el('span', { class: 'hud-colon', text: ':' }), scoreCT, el('span', { class: 'hud-team-ct', text: 'CT' }), pipsCT]);
    score.addEventListener('pointerdown', (e) => this.scoreDown(e));
    const buy = el('div', { class: 'hud-buywin', 'data-testid': 'hud-buywindow' });
    const top = el('div', { class: 'hud-top' }, [timer, score, buy]);

    this.feed = el('div', { class: 'hud-feed', 'data-testid': 'hud-feed' });

    // crosshair + hit marker + plant/defuse ring
    const lines = ['t', 'b', 'l', 'r'].map((s) => el('i', { class: `ch-line ch-${s}` }));
    this.hit = el('div', { class: 'hud-hitmarker', 'data-testid': 'hud-hitmarker' }, [el('i', { class: 'hm hm-a' }), el('i', { class: 'hm hm-b' })]);
    const cross = el('div', { class: 'hud-crosshair', 'data-testid': 'crosshair' }, [...lines, el('i', { class: 'ch-dot' })]);
    const ring = document.createElementNS(SVG_NS, 'svg');
    ring.setAttribute('viewBox', '0 0 100 100'); ring.setAttribute('class', 'hud-ring-svg');
    const ringBg = document.createElementNS(SVG_NS, 'circle'), ringFg = document.createElementNS(SVG_NS, 'circle');
    for (const cc of [ringBg, ringFg]) { cc.setAttribute('cx', '50'); cc.setAttribute('cy', '50'); cc.setAttribute('r', '44'); }
    ringBg.setAttribute('class', 'ring-bg'); ringFg.setAttribute('class', 'ring-fg');
    ringFg.setAttribute('stroke-dasharray', RING_C.toFixed(2)); ringFg.setAttribute('transform', 'rotate(-90 50 50)');
    ring.append(ringBg, ringFg);
    const ringLabel = el('div', { class: 'hud-ring-label' });
    const useRing = el('div', { class: 'hud-ring', 'data-testid': 'hud-usering' }, [ring as unknown as HTMLElement, ringLabel]);
    const center = el('div', { class: 'hud-center' }, [cross, this.hit, useRing]);

    // ammo (90 %, 52 %): bottom edge kept above Fire-R's hit disc (y ≥ 60 %)
    const ammoIcon = el('img', { class: 'hud-ammo-icon', alt: '' });
    const mag = el('b', { class: 'hud-mag', 'data-testid': 'hud-mag' }), reserve = el('span', { class: 'hud-reserve' });
    const hint = el('div', { class: 'hud-ammo-hint', 'data-testid': 'hud-reload-hint' });
    const he = el('span', { class: 'hud-gcount' }), fl = el('span', { class: 'hud-gcount' });
    const heBox = el('span', { class: 'hud-gren' }, [iconImg('he', 'hud-gren-icon'), he]), flBox = el('span', { class: 'hud-gren' }, [iconImg('flash', 'hud-gren-icon'), fl]);
    const ammo = el('div', { class: 'hud-ammo', 'data-testid': 'hud-ammo' }, [el('div', { class: 'hud-grens' }, [heBox, flBox]), el('div', { class: 'hud-ammo-main' }, [ammoIcon, mag, el('span', { class: 'hud-slash', text: '/' }), reserve]), hint]);
    this.strip = el('div', { class: 'hud-strip is-hidden', 'data-testid': 'hud-strip' });

    this.notice = el('div', { class: 'hud-notice is-hidden', 'data-testid': 'hud-notice' });
    this.toastEl = el('div', { class: 'hud-toast is-hidden', 'data-testid': 'hud-toast', role: 'status' });

    // spectator bar (interactive)
    const specName = el('span', { class: 'spec-name', 'data-testid': 'hud-spectating' });
    const specKiller = el('div', { class: 'spec-killer' });
    const prev = this.hudButton('◁', 'btn-spectatePrev', () => this.bus.emit('action', { id: 'spectatePrev' }), 'spec-arrow');
    const next = this.hudButton('▷', 'btn-spectateNext', () => this.bus.emit('action', { id: 'spectateNext' }), 'spec-arrow');
    const skip = this.hudButton('', 'btn-skipRound', () => this.bus.emit('action', { id: 'skipRound' }), 'spec-skip');
    tx(skip, 'ui.hud.skip');
    const spectator = el('div', { class: 'hud-spectator interactive', 'data-testid': 'hud-spectator' }, [specKiller, el('div', { class: 'spec-row' }, [prev, specName, next]), skip]);

    this.debug = el('pre', { class: 'hud-debug', 'data-testid': 'hud-debug' });

    root.append(flash, vignette, scope, damage, vitals, top, this.feed, center, ammo, this.strip, this.notice, spectator, this.debug, this.toastEl);
    parent.append(root);

    this.c = {
      hpNum: txt(hpNum), hpFill: sty(hpFill, 'width'), hpColor: sty(hpFill, 'background-color'), hpLow: flag(hpRow, 'is-low'), arNum: txt(arNum), arFill: sty(arFill, 'width'), helmetOff: flag(helmet, 'is-off'),
      money: txt(money), bombOff: flag(bombIcon, 'is-hidden'), kitOff: flag(kitIcon, 'is-hidden'),
      digits: txt(digits), amber: flag(timer, 'is-amber'), planted: flag(timer, 'is-planted'), bombFill: sty(bombFill, 'width'), timerOff: flag(timer, 'is-hidden'),
      buyOff: flag(buy, 'is-hidden'), buy: txt(buy), scoreT: txt(scoreT), scoreCT: txt(scoreCT), scoreOff: flag(score, 'is-hidden'),
      cross: sty(center, 'transform'), crossGap: sty(cross, '--gap'), crossState: attr(cross, 'data-state'), crossOff: flag(cross, 'is-hidden'),
      ammoOff: flag(ammo, 'is-hidden'), ammoIcon: attr(ammoIcon, 'src'), mag: txt(mag), reserve: txt(reserve), ammoState: attr(ammo, 'data-state'), ammoHint: txt(hint),
      heOff: flag(heBox, 'is-hidden'), flOff: flag(flBox, 'is-hidden'), he: txt(he), fl: txt(fl), heSel: flag(heBox, 'is-sel'), flSel: flag(flBox, 'is-sel'),
      ringOff: flag(useRing, 'is-hidden'), ring: attr(ringFg, 'stroke-dashoffset'), ringLabel: txt(ringLabel),
      vignette: sty(vignette, 'opacity'), flash: sty(flash, 'opacity'), scopeOff: flag(scope, 'is-hidden'),
      specOff: flag(spectator, 'is-hidden'), specName: txt(specName), specKiller: txt(specKiller), skipOff: flag(skip, 'is-hidden'),
      debugOff: flag(this.debug, 'is-hidden'), debugText: txt(this.debug), lefty: flag(root, 'hud--lefty'),
      arc: this.arcs.map((a) => sty(a, 'opacity')),
      pipOn: [...this.pipsT, ...this.pipsCT].map((p) => flag(p, 'on')),
      pipOff: [...this.pipsT, ...this.pipsCT].map((p) => flag(p, 'is-hidden')),
    };
    this.c.debugOff.set(true); this.c.specOff.set(true); this.c.scopeOff.set(true); this.c.ringOff.set(true);
    this.setLayout(this.layout);

    const search = opts.search ?? (typeof location !== 'undefined' ? location.search : '');
    if (/[?&]debug=1/.test(search)) this.setDebug(true);
    onLocaleChange(() => { refillI18n(this.root); for (const x of this.cells) x.reset(); if (this.last) this.paint(this.last); });
    if (typeof window !== 'undefined') {
      window.addEventListener('keydown', (e) => this.onKey(e, true));
      window.addEventListener('keyup', (e) => this.onKey(e, false));
    }
  }

  private hudButton(text: string, testid: string, fn: () => void, cls: string): HTMLButtonElement {
    const b = el('button', { class: `hud-btn ${cls}`, 'data-testid': testid, type: 'button', text });
    b.addEventListener('pointerdown', (e) => e.stopPropagation());
    b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
    return b;
  }

  // ───────── 20 Hz state ─────────
  update(next: RenderSnapshot): void {
    syncRoster(this.sh, next);
    this.paint(next.local, next);
    this.sh.buyMenu?.update(next.local, this.sh.localTeam ?? undefined);
    this.sh.screens?.feedSnapshot(next);
  }

  private paint(l: SnapLocal, next: RenderSnapshot | null = this.sh.snapshot): void {
    this.last = l;
    const c = this.c;
    const inMatch = !!next && next.playerCount > 0;
    const alive = l.alive === 1;
    const hp = clamp(Math.round(l.hp), 0, 100), ar = clamp(Math.round(l.armor), 0, 100);
    c.hpNum.set(String(hp)); c.hpFill.set(hp + '%'); c.hpColor.set(`hsl(${Math.round(hp * 1.2)}, 72%, 46%)`); c.hpLow.set(alive && hp < 30);
    c.arNum.set(String(ar)); c.arFill.set(ar + '%'); c.helmetOff.set(l.helmet !== 1);
    c.money.set(fmtMoney(l.money)); c.bombOff.set(l.hasBomb !== 1); c.kitOff.set(l.hasKit !== 1);
    const free = l.buyWindowRemaining < 0;

    if (next) {
      const r = next.round;
      const planted = r.phase === PH.PLANTED;
      c.planted.set(planted);
      if (planted) c.bombFill.set(`${clamp(q((next.bomb.remaining / BOMB_SECONDS) * 100, 0.5), 0, 100)}%`);
      const showClock = r.remaining >= 0 && r.remaining < 3600;
      c.timerOff.set(!inMatch || (!planted && !showClock));
      c.digits.set(showClock && !planted ? fmtClock(r.remaining) : '');
      c.amber.set(!planted && (r.phase === PH.LIVE || r.phase === PH.SUDDEN_DEATH) && r.remaining < 15);
      c.scoreOff.set(!inMatch || next.playerCount <= 1); // training: solo, no score
      c.scoreT.set(String(r.scoreT)); c.scoreCT.set(String(r.scoreCT));
      let nT = 0, nCT = 0; for (let i = 0; i < next.playerCount; i++) if (next.players[i].team === 0) nT++; else nCT++;
      for (let i = 0; i < 5; i++) {
        c.pipOff[i].set(i >= nT); c.pipOn[i].set(i < r.aliveT);
        c.pipOff[5 + i].set(i >= nCT); c.pipOn[5 + i].set(i < r.aliveCT);
      }
    }
    const buyWin = inMatch && alive && l.canBuy === 1 && l.buyWindowRemaining > 0;
    c.buyOff.set(!buyWin);
    if (buyWin) c.buy.set(tr('ui.hud.buyWindow', { time: fmtClock(l.buyWindowRemaining) }));

    // crosshair (§4.3 recoil crosshair; fixed centre when the setting is off)
    const scoped = l.scoped > 0;
    c.crossOff.set(!alive || scoped);
    c.crossGap.set(`${q(crosshairGap(l.spreadDeg), 0.5)}px`);
    const o = this.controls.recoilCrosshair ? crosshairOffset(l.aimOffsetYaw, l.aimOffsetPitch, this.view) : { dx: 0, dy: 0 };
    c.cross.set(`translate(${q(o.dx, 0.5)}px, ${q(o.dy, 0.5)}px)`);
    c.crossState.set(crosshairState(l.crosshairTarget, this.controls.aimAssist > 0 || this.controls.autoFire));
    c.scopeOff.set(!alive || !scoped);

    // ammo + grenades
    const wid = weaponOf(l.weapon);
    c.ammoOff.set(!inMatch || !alive || wid === null);
    if (wid) {
      const def = WEAPONS[wid];
      c.ammoIcon.set(iconUrl(wid));
      if (def.slot === 3) { c.mag.set(''); c.reserve.set(''); c.ammoState.set('melee'); c.ammoHint.set(''); }
      else if (def.slot === 4) { c.mag.set(String(l.mag)); c.reserve.set(''); c.ammoState.set('grenade'); c.ammoHint.set(''); }
      else {
        c.mag.set(String(l.mag)); c.reserve.set(String(l.reserve));
        const state = l.mag <= 0 ? 'empty' : l.mag <= Math.ceil(def.mag * 0.25) ? 'low' : 'ok';
        c.ammoState.set(state);
        c.ammoHint.set(state === 'empty' ? tr(l.reserve > 0 ? 'ui.hud.reload' : 'ui.hud.noAmmo') : '');
      }
    }
    c.heOff.set(l.he <= 0); c.flOff.set(l.flash <= 0); c.he.set(String(l.he)); c.fl.set(String(l.flash));
    c.heSel.set(l.selectedGrenade === 0 && l.he > 0 && l.flash > 0); c.flSel.set(l.selectedGrenade === 1 && l.he > 0 && l.flash > 0);

    // plant / defuse ring
    const ringOn = alive && (l.useAction === 1 || l.useAction === 2);
    c.ringOff.set(!ringOn);
    if (ringOn) { c.ring.set((RING_C * (1 - clamp(l.useProgress, 0, 1))).toFixed(1)); c.ringLabel.set(tr(l.useAction === 1 ? 'ui.hud.planting' : 'ui.hud.defusing')); }

    // damage direction arcs (0.5 s), low-HP vignette, flash
    const dmgK = alive && l.damageT >= 0 && l.damageT < 0.5 ? 1 - l.damageT / 0.5 : 0;
    const arcYaw = [0, -Math.PI / 2, Math.PI, Math.PI / 2]; // top, right, bottom, left (yaw +90° = left, §0)
    for (let i = 0; i < 4; i++) c.arc[i].set(String(q(dmgK * Math.max(0, Math.cos(l.damageDirYaw - arcYaw[i])), 0.05)));
    c.vignette.set(String(alive && hp < 30 ? q((30 - hp) / 30, 0.05) : 0));
    if (l.blindT > this.lastBlind + 0.05) this.blindTotal = Math.max(l.blindT, 0.1);
    this.lastBlind = l.blindT;
    c.flash.set(String(l.blindT > 0 ? q(clamp(l.blindT / this.blindTotal, 0, 1), 0.02) : 0));

    // spectator bar
    const spect = inMatch && !alive && !this.overlays.has('roundEnd') && !this.overlays.has('matchEnd');
    c.specOff.set(!spect);
    if (spect) {
      c.specName.set(l.spectating > 0 ? tr('ui.hud.spectating', { name: this.nameParam(l.spectating) }) : tr('ui.hud.spectatingNone'));
      c.specKiller.set(l.killerId > 0 && l.killerId !== l.id ? tr('ui.hud.killedBy', { name: this.nameParam(l.killerId) }) : '');
      c.skipOff.set(free);
    }
  }

  private nameParam(id: number): string { const n = playerNameKey(this.sh, id); return n.raw ?? '@' + n.key; }

  // ───────── events ─────────
  handleEvent(e: SimEnvelope): void {
    const local = this.sh.localId;
    switch (e.type) {
      case 'death': {
        const d = e.data as SimEvents['death'];
        this.addFeed(d);
        if (d.killer === local && d.victim !== local) this.hitMarker(true);
        break;
      }
      case 'hit': { const d = e.data as SimEvents['hit']; if (d.attacker === local) this.hitMarker(false); break; }
      case 'money': {
        const d = e.data as SimEvents['money'];
        if (d.player !== local || d.delta === 0) break;
        this.moneyDelta(d.delta);
        if (d.reason === 'plant' || d.reason === 'defuse') this.showNotice('ui.hud.bonus', { amount: fmtDelta(d.delta) }, 2000, 'good');
        break;
      }
      case 'buy': {
        const d = e.data as SimEvents['buy'];
        if (d.player === local && !d.ok) this.toast('ui.buy.err.' + (d.error ?? 'money'));
        this.sh.screens?.feedEvent(e);
        break;
      }
      case 'weaponSwitch': { const d = e.data as SimEvents['weaponSwitch']; if (d.player === local) this.showStrip(d.weapon); break; }
      case 'bombPlanted': this.showNotice('ui.hud.bombPlanted', undefined, 3000, 'danger'); break;
      case 'bombDefused': this.showNotice('ui.hud.bombDefused', undefined, 3000, 'good'); break;
      case 'bombPickup': { const d = e.data as SimEvents['bombPickup']; if (d.player === local) this.toast('ui.hud.gotBomb'); break; }
      case 'blinded': { const d = e.data as SimEvents['blinded']; if (d.player === local) this.blindTotal = Math.max(0.1, d.seconds); break; }
      case 'roundPhase': {
        const d = e.data as SimEvents['roundPhase'];
        if (d.phase === 'FREEZE') this.showNotice('ui.hud.roundStart', { n: d.round }, 2000);
        else if (d.phase === 'LIVE') this.showNotice('ui.hud.go', undefined, 1200);
        else if (d.phase === 'SUDDEN_DEATH') this.showNotice('ui.hud.suddenDeath', undefined, 2500, 'danger');
        this.sh.screens?.feedEvent(e);
        break;
      }
      case 'roundEnd': {
        const d = e.data as SimEvents['roundEnd'];
        this.sh.lastMvp = d.mvp;
        if (d.winner) this.showNotice('ui.round.banner', { team: d.winner, reason: '@reason.' + d.reason }, 3000, d.winner === 'T' ? 'team-t' : 'team-ct');
        else this.showNotice('ui.round.draw', { reason: '@reason.' + d.reason }, 3000);
        break;
      }
      case 'targetHit': case 'itemPickup': this.sh.screens?.feedEvent(e); break;
      case 'botState': { const d = e.data as SimEvents['botState']; if (this.debugOn) this.botStates.set(d.bot, d.state); break; }
    }
  }

  private addFeed(d: SimEvents['death']): void {
    const row = el('div', { class: 'feed-row', 'data-testid': 'hud-feed-row' });
    const local = this.sh.localId;
    if (d.killer && d.killer !== d.victim) row.append(this.nameSpan(d.killer));
    const icon: IconId = d.weapon === 'fall' ? 'skull' : d.weapon === 'bomb' ? 'bomb' : d.weapon;
    row.append(iconImg(icon, 'feed-icon'));
    if (d.headshot) row.append(iconImg('headshot', 'feed-hs', '#FFD54F'));
    row.append(this.nameSpan(d.victim));
    if (d.killer === local || d.victim === local) row.classList.add('is-local');
    this.feed.prepend(row);
    while (this.feed.children.length > 4) this.feed.lastElementChild?.remove();
    setTimeout(() => row.remove(), 5000);
  }

  private nameSpan(id: number): HTMLElement {
    const team = this.sh.roster.get(id)?.team ?? null;
    const own = team !== null && team === this.sh.localTeam;
    const s = el('span', { class: `feed-name ${own ? 'own' : 'enemy'}` });
    const n = playerNameKey(this.sh, id);
    if (n.raw !== undefined) s.textContent = n.raw; else tx(s, n.key);
    return s;
  }

  private moneyDelta(delta: number): void {
    const d = el('div', { class: `hud-delta ${delta < 0 ? 'neg' : 'pos'}`, text: fmtDelta(delta) });
    this.deltas.append(d);
    while (this.deltas.children.length > 3) this.deltas.firstElementChild?.remove();
    setTimeout(() => d.remove(), 1500);
  }

  private hitMarker(kill: boolean): void {
    if (this.hitTimer) clearTimeout(this.hitTimer);
    this.hit.classList.add('show');
    this.hit.classList.toggle('kill', kill || this.hit.classList.contains('kill'));
    this.hitTimer = setTimeout(() => { this.hit.classList.remove('show', 'kill'); this.hitTimer = null; }, kill ? 250 : 80);
  }

  private showNotice(key: string, params: I18nParams | undefined, ms: number, tone = ''): void {
    tx(this.notice, key, params);
    this.notice.className = `hud-notice ${tone ? 'tone-' + tone : ''}`;
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => this.clearNotice(), ms);
  }

  /** Hides the centre notice (Screens calls it when the round-end banner screen takes over). */
  clearNotice(): void { this.notice.classList.add('is-hidden'); if (this.noticeTimer) { clearTimeout(this.noticeTimer); this.noticeTimer = null; } }

  /** Short toast above the crosshair (stays above the buy menu, §8.4 「钱不够」). */
  toast(key: string, params?: I18nParams, ms = 1600): void {
    tx(this.toastEl, key, params);
    this.toastEl.classList.remove('is-hidden');
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => { this.toastEl.classList.add('is-hidden'); this.toastTimer = null; }, ms);
  }

  private showStrip(active: WeaponId): void {
    const l = this.last; if (!l) return;
    const slots: Array<WeaponId | null> = [weaponOf(l.primary), weaponOf(l.pistol), 'knife'];
    const items: HTMLElement[] = [];
    for (const w of slots) if (w) { const img = iconImg(w, 'strip-icon'); const box = el('span', { class: `strip-slot ${w === active ? 'is-active' : ''}` }, [img]); items.push(box); }
    if (l.he > 0 || l.flash > 0) {
      const g = el('span', { class: `strip-slot ${active === 'he' || active === 'flash' ? 'is-active' : ''}` });
      if (l.he > 0) g.append(iconImg('he', 'strip-icon strip-gren'), el('b', { text: String(l.he) }));
      if (l.flash > 0) g.append(iconImg('flash', 'strip-icon strip-gren'), el('b', { text: String(l.flash) }));
      items.push(g);
    }
    this.strip.replaceChildren(...items);
    this.strip.classList.remove('is-hidden');
    if (this.stripTimer) clearTimeout(this.stripTimer);
    this.stripTimer = setTimeout(() => { this.strip.classList.add('is-hidden'); this.stripTimer = null; }, 1500);
  }

  // ───────── scoreboard tap / hold (§7.2: tap the score at (50, 8), hold to show) ─────────
  /** Lets the app own the scoreboard (game.ts: screens.show('scoreboard', …) / hide). Without it the Hud shows it itself. */
  onScoreboard(fn: (show: boolean) => void): void { this.scoreboardFn = fn; }

  private scoreDown(e: Event): void {
    e.stopPropagation(); e.preventDefault();
    this.sbWasOpen = this.isScoreboardOpen();
    this.sbDownAt = Date.now();
    if (!this.sbWasOpen) this.setScoreboard(true);
    const up = () => { window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); if (this.sbWasOpen || Date.now() - this.sbDownAt >= 300) this.setScoreboard(false); };
    window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
  }

  private isScoreboardOpen(): boolean { return this.scoreboardFn ? this.sbShown : (this.sh.screens?.visible().includes('scoreboard') ?? false); }

  setScoreboard(show: boolean): void {
    this.sbShown = show;
    if (this.scoreboardFn) { this.scoreboardFn(show); return; }
    const s = this.sh.screens, snap = this.sh.snapshot;
    if (!s) return;
    if (show && snap) s.show('scoreboard', { snapshot: snap, humanTeam: this.sh.localTeam ?? 'CT', mvp: this.sh.lastMvp });
    else s.hide('scoreboard');
  }

  // ───────── debug overlay (?debug=1, F1, 5 taps on the timer) ─────────
  private timerTap(): void {
    const now = Date.now();
    this.timerTaps = this.timerTaps.filter((t) => now - t < 2000);
    this.timerTaps.push(now);
    if (this.timerTaps.length >= 5) { this.timerTaps = []; this.setDebug(!this.debugOn); }
  }

  setDebug(on: boolean): void {
    this.debugOn = on;
    this.c.debugOff.set(!on);
    if (this.debugTimer) { clearInterval(this.debugTimer); this.debugTimer = null; }
    if (on) { this.refreshDebug(); this.debugTimer = setInterval(() => this.refreshDebug(), 500); } else this.botStates.clear();
  }

  private refreshDebug(): void {
    const cs = (globalThis as { __cs?: { perf?: () => PerfLike } }).__cs;
    let p: PerfLike = {};
    try { p = cs?.perf?.() ?? {}; } catch { p = {}; }
    const f = (v: { avg: number; p95: number } | undefined) => (v ? `${v.avg.toFixed(1)}/${v.p95.toFixed(1)}` : '-');
    const states = new Map<string, number>();
    for (const s of this.botStates.values()) states.set(s, (states.get(s) ?? 0) + 1);
    const lines = [
      `fps ${p.fps !== undefined ? Math.round(p.fps) : '-'}  frame ${f(p.frameMs)} ms`,
      `sim ${f(p.simMs)}  bot ${f(p.botMs)}  render ${f(p.renderMs)}`,
      `draw ${p.drawCalls ?? '-'}  tris ${p.triangles !== undefined ? (p.triangles / 1000).toFixed(1) + 'k' : '-'}  heap ${p.heapMB !== undefined ? p.heapMB.toFixed(0) + 'MB' : '-'}  q ${p.quality ?? '-'}`,
    ];
    if (states.size) lines.push([...states].map(([k, v]) => `${k} ${v}`).join(' · '));
    this.c.debugText.set(lines.join('\n'));
  }

  private onKey(e: KeyboardEvent, down: boolean): void {
    if (this.root.style.display === 'none') return;
    if (e.code === 'F1' && down) { e.preventDefault(); this.setDebug(!this.debugOn); }
    else if (e.code === 'Tab') { e.preventDefault(); if (down && !e.repeat) this.setScoreboard(true); else if (!down) this.setScoreboard(false); }
  }

  // ───────── binding API ─────────
  setView(v: { fovDeg: number; width: number; height: number }): void { this.view = { fovDeg: v.fovDeg, width: v.width, height: v.height }; }
  /** Optional (INTEGRATION NOTE): game.ts may push ControlSettings at start and on settingsChanged; the Hud also follows the bus. */
  setSettings(controls: ControlSettings): void { this.controls = { ...controls }; }
  setLayout(l: TouchLayout): void { this.layout = l; this.c.lefty.set(!!l.leftHanded); }
  show(b: boolean): void {
    this.root.style.display = b ? '' : 'none';
    for (const x of this.cells) x.reset();
    if (b) { this.feed.replaceChildren(); this.deltas.replaceChildren(); this.clearNotice(); this.toastEl.classList.add('is-hidden'); this.c.debugOff.set(!this.debugOn); }
  }
  get element(): HTMLElement { return this.root; }
  get bus_(): EventBus<UiEvents> { return this.bus; }
}
