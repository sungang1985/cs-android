/** §11.13 / §12.1: zh ↔ en key parity, every owned key family, placeholder consistency, t() resolution, detectLocale. */
import { describe, it, expect, beforeAll } from 'vitest';
import { registerDictionary, setLocale, t, detectLocale, missingKeys, allKeys } from '@/i18n/i18n';
import { zh } from '@/i18n/zh';
import { en } from '@/i18n/en';
import { WEAPON_INDEX, type MoneyReason, type WinReason, type ModeId } from '@/sim/state';
import { DEPOT } from '@/maps/depot';
import { BOT_NAME_KEYS } from '@/rules/match';
import { BOT_NAME_KEYS as AI_NAME_KEYS } from '@/ai/names';
import type { SimEvents } from '@/sim/events';

const placeholders = (s: string): string[] => [...new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort();

const AREA_IDS = ['t_spawn', 't_north', 't_south', 'long', 'mid', 'tunnel', 'ct_spawn', 'site_a', 'site_b', 'a_ramp', 'a_ramp_ct', 'mid_window', 'tunnel_window', 'a_connector', 'b_connector', 'b_door_ct'];
const MODES: ModeId[] = ['defusal', 'tdm', 'training'];
const REASONS: WinReason[] = ['elimination', 'bomb', 'defuse', 'time', 'draw'];
const MONEY: MoneyReason[] = ['kill', 'plant', 'defuse', 'win', 'loss', 'plantedLoss', 'buy', 'halfReset'];
const BUY_ERRORS: NonNullable<SimEvents['buy']['error']>[] = ['money', 'window', 'zone', 'owned', 'team', 'max'];

/** The documented params of the parameterised keys other lanes call (key → params). */
const DOCUMENTED: Record<string, string[]> = {
  'hud.roundWin': ['team'], 'hud.buyTime': ['time'], 'hud.spectating': ['name'], 'hud.killedBy': ['name'], 'hud.round': ['n'], 'hud.respawnIn': ['seconds'],
  'hud.tdmTarget': ['kills'], 'hud.bought': ['item'], 'hud.alive': ['n'], 'hud.money': ['amount'], 'hud.moneyGain': ['amount'], 'hud.moneyLoss': ['amount'],
  'buy.teamOnly': ['team'], 'buy.price': ['price'], 'buy.timeLeft': ['time'], 'buy.money': ['amount'],
  'match.roundMvp': ['name'], 'match.finalScore': ['ct', 't'], 'match.assist': ['level'], 'match.rounds': ['n'],
  'mode.tdm.desc': ['kills', 'minutes'], 'menu.vs': ['n'], 'menu.firstTo': ['n'], 'app.version': ['version'], 'scoreboard.round': ['n'],
  'onboarding.step': ['n', 'total'], 'onboarding.aim.hint': ['n'], 'onboarding.aim.progress': ['done', 'total'],
};

describe('i18n dictionaries', () => {
  beforeAll(() => { registerDictionary('zh', zh); registerDictionary('en', en); });

  it('every zh key exists in en and vice versa; no empty strings', () => {
    expect(Object.keys(zh).filter((k) => !(k in en))).toEqual([]);
    expect(Object.keys(en).filter((k) => !(k in zh))).toEqual([]);
    expect(missingKeys('en')).toEqual([]);
    expect(allKeys().length).toBe(Object.keys(zh).length);
    for (const [k, v] of [...Object.entries(zh), ...Object.entries(en)]) expect(v.trim().length, k).toBeGreaterThan(0);
  });

  it('owns every key family of §11.13', () => {
    const need = [
      ...WEAPON_INDEX.map((w) => 'weapon.' + w), 'item.kevlar', 'item.kevlar_helmet', 'item.defuse_kit', 'item.c4',
      ...AREA_IDS.map((a) => 'area.' + a), ...BOT_NAME_KEYS.map((b) => 'bot.' + b), 'bot.player', 'map.depot',
      ...MODES.map((m) => 'mode.' + m), ...REASONS.map((r) => 'reason.' + r), 'team.T', 'team.CT',
      ...MONEY.map((m) => 'money.' + m), ...BUY_ERRORS.map((e) => 'buy.error.' + e),
    ];
    expect(WEAPON_INDEX).toHaveLength(10);
    expect(AREA_IDS).toHaveLength(16);
    expect(BOT_NAME_KEYS).toHaveLength(12);
    expect(AI_NAME_KEYS).toEqual(BOT_NAME_KEYS);
    expect(need.filter((k) => !(k in zh))).toEqual([]);
    expect(DEPOT.areas.map((a) => 'area.' + a.id).filter((k) => !(k in zh))).toEqual([]);
    expect('map.' + DEPOT.id in zh).toBe(true);
  });

  it('the §3.2 area names are used verbatim', () => {
    expect([zh['area.site_a'], en['area.site_a'], zh['area.mid_window'], en['area.b_door_ct']]).toEqual(['A点', 'A Site', '天窗', 'B Back Door']);
  });

  it('zh and en use the same {param} placeholders; documented params match', () => {
    for (const k of Object.keys(zh)) expect(placeholders(en[k]), k).toEqual(placeholders(zh[k]));
    for (const [k, params] of Object.entries(DOCUMENTED)) expect(placeholders(zh[k]), k).toEqual([...params].sort());
  });

  it('no unresolved {param} after t() with the documented params, in both locales', () => {
    for (const locale of ['zh', 'en'] as const) {
      setLocale(locale);
      for (const k of Object.keys(zh)) {
        const params = Object.fromEntries(placeholders(zh[k]).map((p) => [p, 7]));
        const s = t(k, params);
        expect(s, `${locale}:${k}`).not.toMatch(/\{\w+\}/);
        expect(s).not.toBe(k);
      }
    }
    setLocale('en');
    expect(t('hud.roundWin', { team: t('team.CT') })).toBe('Counter-Terrorists win');
    expect(t('hud.moneyGain', { amount: 300 })).toBe('+$300');
    setLocale('zh');
    expect(t('hud.buyTime', { time: '0:12' })).toBe('购买 0:12');
    expect(t('menu.vs', { n: 5 })).toBe('5v5');
  });

  it('detectLocale: zh* → zh, anything else → en', () => {
    expect(detectLocale('zh-CN')).toBe('zh'); expect(detectLocale('zh-TW')).toBe('zh'); expect(detectLocale('ZH')).toBe('zh'); expect(detectLocale('zh')).toBe('zh');
    expect(detectLocale('en-US')).toBe('en'); expect(detectLocale('de-DE')).toBe('en'); expect(detectLocale('')).toBe('en'); expect(detectLocale(undefined)).toBe('en');
  });
});
