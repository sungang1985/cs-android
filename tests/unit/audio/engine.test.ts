import { describe, it, expect, beforeAll } from 'vitest';
import { SoundBank, bankPlan } from '@/audio/bank';
import { AudioEngine } from '@/audio/engine';
import { RECIPE_SPEC, type BankId } from '@/audio/recipes';
import { VOICE_LIMIT } from '@/audio/mixer';
import { v3, type Vec3 } from '@/core/math';
import type { SimEnvelope, SimEvents } from '@/sim/events';
import type { StaticWorld } from '@/world/collision';
import { makeLocalPure } from './localFixture';
import { FakeAudioContext, FakeBuffer, FakePanner, FakeBiquad, FakeSource } from './fakeAudio';

let bank: SoundBank;
let factory: FakeAudioContext;
const idOf = new Map<FakeBuffer, BankId>();
beforeAll(() => {
  factory = new FakeAudioContext();
  const progress: number[] = [];
  bank = SoundBank.buildSync(factory as unknown as BaseAudioContext, (d) => progress.push(d));
  bankPlan().forEach((e, i) => idOf.set(factory.buffers[i], e.id));
  expect(progress.at(-1)).toBe(bankPlan().length);
});

describe('SoundBank', () => {
  it('renders ≈ 70 buffers (2 variants for shots, footsteps, impacts, hits) ≈ 2–3 MB', () => {
    expect(bank.count).toBe(72);
    expect(bank.totalBytes).toBeGreaterThan(1.8e6); expect(bank.totalBytes).toBeLessThan(3.2e6);
    expect(bank.variants('fire_ak')).toBe(2); expect(bank.variants('bomb_beep')).toBe(1);
    expect(bank.get('fire_ak', 3)).toBe(bank.get('fire_ak', 1));
    expect((bank.get('ambient_hum') as unknown as FakeBuffer).sampleRate).toBe(22050);
  });
  it('build() yields and reports progress', async () => {
    const f = new FakeAudioContext(); let last = 0;
    const b = await SoundBank.build(f as unknown as BaseAudioContext, (d, t) => { last = d; expect(t).toBe(72); }, 24);
    expect(b.count).toBe(72); expect(last).toBe(72);
  });
});

type Rig = { eng: AudioEngine; ctx: FakeAudioContext; played: () => { id: BankId; src: FakeSource }[] };
async function rig(world?: Partial<StaticWorld>): Promise<Rig> {
  let ctx!: FakeAudioContext;
  const eng = new AudioEngine({ createContext: () => { ctx = new FakeAudioContext({ latencyHint: 'interactive' }); return ctx as unknown as AudioContext; }, bank });
  await eng.unlock();
  eng.setWorld({ lineOfSight: () => true, ...world } as StaticWorld);
  eng.setListener({ pos: v3(0, 1.65, 0), fwd: v3(0, 0, -1), up: v3(0, 1, 0) });
  return { eng, ctx, played: () => ctx.started.map((src) => ({ id: idOf.get(src.buffer!)!, src })) };
}
const env = <K extends keyof SimEvents>(type: K, data: SimEvents[K], tick = 100): SimEnvelope => ({ type, data, tick }) as SimEnvelope;
const local = makeLocalPure();
const sound = (id: SimEvents['sound']['id'], pos: Vec3, loudness: number, player: number, tick = 100) => env('sound', { id, pos, loudness, player }, tick);
const hasNode = (src: FakeSource, kind: string) => src.chain().some((n) => n.kind === kind);

describe('AudioEngine (§9.3)', () => {
  it('unlock() creates an interactive context, is idempotent and builds the bus graph', async () => {
    const r = await rig();
    expect(r.ctx.opts).toEqual({ latencyHint: 'interactive' });
    await r.eng.unlock();
    expect(r.eng.unlocked).toBe(true); expect(r.eng.ready).toBe(true);
    expect(r.ctx.destination).toBeDefined();
  });
  it('world sounds come only from `sound` events; shot/footstep/impact events are ignored', async () => {
    const r = await rig();
    r.eng.handle(env('shot', { shooter: 5, weapon: 'ak47', origin: v3(), dir: v3(0, 0, -1), end: v3(), hitPlayer: 0 }), local);
    r.eng.handle(env('footstep', { player: 5, pos: v3(1, 0, 0), surface: 'concrete', walking: false }), local);
    r.eng.handle(env('impact', { point: v3(), normal: v3(), surface: 'wood' }), local);
    expect(r.played()).toEqual([]);
    r.eng.handle(sound('fire_ak', v3(10, 1.5, 0), 40, 5), local);
    const p = r.played();
    expect(p.map((x) => x.id)).toEqual(['fire_ak']);
    expect(hasNode(p[0].src, 'panner')).toBe(true);
    const pan = p[0].src.chain().find((n) => n.kind === 'panner') as FakePanner;
    expect(pan).toMatchObject({ panningModel: 'equalpower', distanceModel: 'inverse', refDistance: 1.5, maxDistance: 40, rolloffFactor: 1.2 });
    expect(pan.positionX.value).toBe(10);
  });
  it('variant = (tick + player) % variants', async () => {
    const r = await rig();
    r.eng.handle(sound('fire_m4', v3(5, 1, 0), 40, 3, 100), local);
    r.ctx.currentTime += 0.03;
    r.eng.handle(sound('fire_m4', v3(5, 1, 0), 40, 4, 200), local);
    const [a, b] = r.played();
    expect(a.src.buffer).toBe(bank.get('fire_m4', 1)); expect(b.src.buffer).toBe(bank.get('fire_m4', 0));
  });
  it('own weapon sounds bypass the panner; the same id within 25 ms is skipped', async () => {
    const r = await rig();
    r.eng.handle(sound('fire_ak', v3(0, 1.5, 0), 40, local.id), local);
    r.eng.handle(sound('fire_ak', v3(0, 1.5, 0), 40, local.id), local);
    expect(r.played().length).toBe(1);
    expect(hasNode(r.played()[0].src, 'panner')).toBe(false);
    r.ctx.currentTime += 0.03;
    r.eng.handle(sound('fire_ak', v3(0, 1.5, 0), 40, local.id), local);
    expect(r.played().length).toBe(2);
  });
  it('occlusion → lowpass 700 Hz at −6 dB; distant gunfire → lowpass 600 Hz', async () => {
    const r = await rig({ lineOfSight: () => false });
    r.eng.handle(sound('impact_metal', v3(5, 0, 0), 10, 5), local);
    const src = r.played()[0].src;
    const lp = src.chain().find((n) => n.kind === 'biquad') as FakeBiquad;
    expect(lp.frequency.value).toBe(700);
    expect((src.outputs[0] as unknown as { gain: { value: number } }).gain.value).toBeCloseTo(RECIPE_SPEC.impact_metal.gain * 0.5);
    const r2 = await rig();
    r2.eng.handle(sound('fire_awp', v3(60, 1.5, 0), 60, 5), local);
    expect((r2.played()[0].src.chain().find((n) => n.kind === 'biquad') as FakeBiquad).frequency.value).toBe(600);
  });
  it('bot footsteps beyond 14 m are not played', async () => {
    const r = await rig();
    r.eng.handle(sound('footstep_concrete', v3(20, 0, 0), 30, 5), local);
    r.eng.handle(sound('footstep_concrete', v3(8, 0, 0), 10, 5), local);
    expect(r.played().length).toBe(1);
  });
  it('polyphony is capped at 24 voices with priority stealing', async () => {
    const r = await rig();
    const ids: SimEvents['sound']['id'][] = ['impact_concrete', 'impact_wood', 'impact_metal', 'impact_sand', 'footstep_metal', 'footstep_wood'];
    for (let i = 0; i < 30; i++) { r.ctx.currentTime += 0.03; r.eng.handle(sound(ids[i % ids.length], v3(9, 0, 0), 10, 5), local); }
    expect(r.eng.stats().voices).toBe(VOICE_LIMIT);
    r.ctx.currentTime += 0.03;
    r.eng.handle(sound('fire_ak', v3(0, 1.5, 0), 40, local.id), local); // own, loud → steals
    const own = r.played().at(-1)!;
    expect(own.id).toBe('fire_ak');
    expect(r.played().filter((p) => p.src.stoppedAt !== null).length).toBeGreaterThanOrEqual(1);
    expect(r.eng.stats().voices).toBe(VOICE_LIMIT);
  });
  it('listener-relative cues: hitmarker / headshot ding / hit taken, flash ring, buy, round stingers', async () => {
    const r = await rig();
    const hit = (o: Partial<SimEvents['hit']>) => env('hit', { attacker: 5, victim: 6, weapon: 'ak47', zone: 'chest', damage: 30, armored: false, point: v3(), ...o });
    r.eng.handle(hit({ attacker: local.id }), local); r.ctx.currentTime += 0.03;
    r.eng.handle(hit({ attacker: local.id, zone: 'head' }), local); r.ctx.currentTime += 0.03;
    r.eng.handle(hit({ victim: local.id, armored: true }), local); r.ctx.currentTime += 0.03;
    r.eng.handle(env('blinded', { player: local.id, seconds: 2 }), local);
    r.eng.handle(env('blinded', { player: 7, seconds: 2 }), local);
    r.eng.handle(env('buy', { player: local.id, item: 'ak47', ok: false, error: 'money' }), local);
    r.eng.handle(env('buy', { player: 9, item: 'ak47', ok: true }), local);
    r.eng.handle(env('roundPhase', { phase: 'LIVE', round: 1, endsTick: 0 }), local);
    r.eng.setLocalTeam('CT');
    r.eng.handle(env('roundEnd', { winner: 'T', reason: 'bomb', mvp: 0, deltas: [] }), local);
    expect(r.played().map((p) => p.id)).toEqual(['hitmarker', 'headshot_ding', 'hit_armor', 'flash_ring', 'buy_denied', 'round_start', 'round_lose']);
    const ring = r.played()[3].src;
    expect(ring.loop).toBe(true); expect(ring.stoppedAt).toBeCloseTo(r.ctx.currentTime + 2.05);
    expect(hasNode(r.played()[0].src, 'panner')).toBe(false);
  });
  it('infers the local team from the human\'s spotted events when setLocalTeam was not called', async () => {
    const r = await rig();
    r.eng.handle(env('spotted', { team: 'T', enemy: 7, pos: v3(), by: local.id }), local);
    r.eng.handle(env('roundEnd', { winner: 'T', reason: 'elimination', mvp: 0, deltas: [] }), local);
    expect(r.played().map((p) => p.id)).toEqual(['round_win']);
  });
  it('bomb beeps follow 1.0·(remaining/35)^1.6 + 0.05 in sim time and stop on defuse', async () => {
    const r = await rig();
    r.eng.handle(env('bombPlanted', { player: 3, pos: v3(4, 0, 4), site: 'a' }, 1000), local);
    expect(r.played().map((p) => p.id)).toEqual(['bomb_beep', 'radio_bomb']);
    expect(hasNode(r.played()[0].src, 'panner')).toBe(true);
    const beeps = () => r.played().filter((p) => p.id === 'bomb_beep').length;
    const step = (t: number) => { r.eng.syncTick(t); for (const p of r.played()) p.src.end(); }; // beeps finish playing
    for (let t = 1001; t <= 1000 + 60 * 10; t++) step(t);
    const first10s = beeps();
    let expected = 0; for (let tick = 1000; tick <= 1600;) { expected++; tick += Math.max(1, Math.round((Math.pow((35 - (tick - 1000) / 60) / 35, 1.6) + 0.05) * 60)); }
    expect(first10s).toBe(expected);
    for (let t = 1601; t <= 1000 + 60 * 34; t++) step(t);
    const total = beeps();
    expect(total).toBeGreaterThan(first10s * 2);
    r.eng.handle(env('bombDefused', { player: 4 }, 1000 + 60 * 34), local);
    for (let t = 1000 + 60 * 34; t < 1000 + 60 * 36; t++) step(t);
    expect(beeps()).toBe(total);
  });
  it('radio stand-ins: a teammate spotting a fresh enemy plays radio_spotted (rate-limited); the human\'s own spots do not', async () => {
    const r = await rig();
    r.eng.setLocalTeam('CT');
    const spot = (enemy: number, by: number, tick: number, team: 'T' | 'CT' = 'CT') => { r.ctx.currentTime += 0.05; r.eng.handle(env('spotted', { team, enemy, pos: v3(), by }, tick), local); };
    spot(7, local.id, 10); spot(7, 3, 20, 'T'); spot(7, 3, 30); spot(7, 4, 40); spot(8, 4, 60);
    spot(8, 4, 60 + 5 * 60); spot(7, 3, 60 + 20 * 60);
    expect(r.played().map((p) => p.id)).toEqual(['radio_spotted', 'radio_spotted']);
  });
  it('bomb explosion is global and deafens the master for 2 s', async () => {
    const r = await rig({ lineOfSight: () => false });
    r.eng.handle(sound('bomb_explode', v3(300, 0, 0), 1000, 0), local);
    r.eng.handle(env('bombExploded', { pos: v3(300, 0, 0) }), local);
    const src = r.played()[0].src;
    expect(hasNode(src, 'panner')).toBe(false); expect(hasNode(src, 'biquad')).toBe(true); // only the master "deafened" filter downstream
    const deaf = src.chain().filter((n) => n.kind === 'biquad') as FakeBiquad[];
    expect(deaf.some((f) => f.frequency.events.some(([k, v]) => k === 'exp' && v === 20000))).toBe(true);
  });
  it('ambient loop cross-fades in and out; ui() clicks; volumes map to (v/100)²', async () => {
    const r = await rig();
    r.eng.startAmbient();
    const amb = r.played().find((p) => p.id === 'ambient_hum')!.src;
    expect(amb.loop).toBe(true);
    r.eng.stopAmbient();
    expect(amb.stoppedAt).toBeCloseTo(r.ctx.currentTime + 0.55);
    r.eng.ui('tap'); r.eng.ui('tap');
    expect(r.played().filter((p) => p.id === 'ui_tap').length).toBe(2);
    r.eng.setVolumes({ master: 50, sfx: 100, ui: 0 });
    expect(r.eng.getVolumes()).toEqual({ master: 50, sfx: 100, ui: 0 });
  });
  it('nothing plays (and nothing throws) before unlock()', () => {
    const eng = new AudioEngine({ createContext: () => new FakeAudioContext() as unknown as AudioContext, bank });
    eng.handle(sound('fire_ak', v3(1, 1, 1), 40, 5), local);
    eng.ui('tap'); eng.startAmbient(); eng.stopAmbient(); eng.setListener({ pos: v3(), fwd: v3(0, 0, -1), up: v3(0, 1, 0) }); eng.suspend(); eng.resume();
    expect(eng.stats()).toMatchObject({ ready: false, voices: 0 });
  });
});
