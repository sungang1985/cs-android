/**
 * Minimal i18n: flat dictionaries with `{param}` placeholders. zh-CN is the source of truth; every key must
 * exist in English too (a unit test enforces this). No DOM here; the UI re-renders on `onLocaleChange`.
 */
export type Locale = 'zh' | 'en';
export type Dictionary = Record<string, string>;

const dictionaries: Record<Locale, Dictionary> = { zh: {}, en: {} };
let current: Locale = 'zh';
const listeners = new Set<(l: Locale) => void>();

export function registerDictionary(locale: Locale, dict: Dictionary): void {
  Object.assign(dictionaries[locale], dict);
}

export function getLocale(): Locale { return current; }

export function setLocale(locale: Locale): void {
  if (locale === current) return;
  current = locale;
  for (const fn of listeners) fn(locale);
}

export function onLocaleChange(fn: (l: Locale) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Detects the preferred locale from a BCP-47 language string (navigator.language). */
export function detectLocale(language: string | undefined): Locale {
  return language && language.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

/** Translate `key` with optional params; falls back zh → en → key. */
export function t(key: string, params?: Record<string, string | number>): string {
  let s = dictionaries[current][key] ?? dictionaries.en[key] ?? dictionaries.zh[key] ?? key;
  if (params) for (const [k, v] of Object.entries(params)) s = s.split(`{${k}}`).join(String(v));
  return s;
}

/** Keys missing from `locale` compared with the zh source (for tests). */
export function missingKeys(locale: Locale): string[] {
  return Object.keys(dictionaries.zh).filter((k) => !(k in dictionaries[locale]));
}

export function allKeys(): string[] { return Object.keys(dictionaries.zh); }
