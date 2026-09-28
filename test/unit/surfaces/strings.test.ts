// WP7a: every UI string exists in English and Russian with the same placeholders (01 §3, 04 §9 WP7a).
import { describe, expect, it } from 'vitest';
import { STRING_KEYS, uiLang, type StringKey } from '../../../src/contracts/index.ts';
import { CATALOG, SURF, createStrings, fill, st } from '../../../src/surfaces/strings.ts';

const vars = (t: string) => [...new Set([...t.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((m) => m[1]))].sort();

describe('strings', () => {
  it('CATALOG covers every STRING_KEYS entry in en + ru with the contract placeholders', () => {
    for (const key of Object.keys(STRING_KEYS) as StringKey[]) {
      const pair = CATALOG[key];
      expect(pair, key).toBeDefined();
      expect(pair.en.trim().length, `${key}.en`).toBeGreaterThan(0);
      expect(pair.ru.trim().length, `${key}.ru`).toBeGreaterThan(0);
      const want = [...STRING_KEYS[key].vars].sort();
      expect(vars(pair.en), `${key}.en vars`).toEqual(want);
      expect(vars(pair.ru), `${key}.ru vars`).toEqual(want);
    }
    expect(Object.keys(CATALOG).sort()).toEqual(Object.keys(STRING_KEYS).sort());
  });

  it('every surfaces-only string has en + ru with identical placeholders', () => {
    for (const [key, pair] of Object.entries(SURF)) {
      expect(pair.en.trim().length, `${key}.en`).toBeGreaterThan(0);
      expect(pair.ru.trim().length, `${key}.ru`).toBeGreaterThan(0);
      expect(vars(pair.ru), key).toEqual(vars(pair.en));
    }
  });

  it('language selection: ru/uk/kk/be → Russian, everything else → English', () => {
    const s = createStrings();
    expect(s.t('stopped', 'ru')).toBe(CATALOG.stopped.ru);
    expect(s.t('stopped', 'uk')).toBe(CATALOG.stopped.ru);
    expect(s.t('stopped', 'kk-KZ')).toBe(CATALOG.stopped.ru);
    expect(s.t('stopped', 'be')).toBe(CATALOG.stopped.ru);
    expect(s.t('stopped', 'de')).toBe(CATALOG.stopped.en);
    expect(s.t('stopped', null)).toBe(CATALOG.stopped.en);
    expect(uiLang(undefined)).toBe('en');
  });

  it('fills placeholders and never throws on missing ones', () => {
    const s = createStrings();
    expect(s.t('busy_retrying', 'en', { seconds: 12 })).toBe('⏳ Busy — retrying in 12s');
    expect(s.t('busy_retrying', 'en')).toContain('{seconds}');
    expect(fill('a {x} {y}', { x: 1 })).toBe('a 1 {y}');
    expect(st('tz_hint_line', 'ru', { tz: 'Europe/Moscow' })).toContain('Europe/Moscow');
  });
});
