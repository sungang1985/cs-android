import { describe, it, expect } from 'vitest';
import { registerDictionary, setLocale, t, detectLocale, missingKeys, onLocaleChange, getLocale } from '@/i18n/i18n';

describe('i18n', () => {
  it('translates with params and falls back', () => {
    registerDictionary('zh', { hello: '你好 {name}', only_zh: '仅中文' });
    registerDictionary('en', { hello: 'Hello {name}' });
    setLocale('zh');
    expect(t('hello', { name: 'A' })).toBe('你好 A');
    setLocale('en');
    expect(t('hello', { name: 'B' })).toBe('Hello B');
    expect(t('only_zh')).toBe('仅中文');
    expect(t('nope')).toBe('nope');
    expect(missingKeys('en')).toEqual(['only_zh']);
  });
  it('detects locale and notifies listeners', () => {
    expect(detectLocale('zh-CN')).toBe('zh'); expect(detectLocale('en-US')).toBe('en'); expect(detectLocale(undefined)).toBe('en');
    const seen: string[] = []; const off = onLocaleChange((l) => seen.push(l));
    setLocale('zh'); setLocale('zh'); off(); setLocale('en');
    expect(seen).toEqual(['zh']); expect(getLocale()).toBe('en');
  });
});
