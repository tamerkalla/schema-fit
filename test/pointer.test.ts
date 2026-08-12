import { describe, expect, it } from 'vitest';
import { escapeToken, join, resolve, unescapeToken } from '../src/pointer.js';

describe('json pointers', () => {
  it('escapes the two characters that need it', () => {
    expect(escapeToken('a/b')).toBe('a~1b');
    expect(escapeToken('a~b')).toBe('a~0b');
    expect(escapeToken('a~/b')).toBe('a~0~1b');
    expect(escapeToken('plain')).toBe('plain');
  });

  it('unescapes back to the original', () => {
    for (const token of ['a/b', 'a~b', 'a~/b', '~01', 'plain', '']) {
      expect(unescapeToken(escapeToken(token))).toBe(token);
    }
  });

  it('joins tokens onto a base', () => {
    expect(join('')).toBe('');
    expect(join('', 'properties', 'a')).toBe('/properties/a');
    expect(join('/properties/a', 'items', 0)).toBe('/properties/a/items/0');
    expect(join('', 'a/b')).toBe('/a~1b');
  });

  it('resolves into objects and arrays', () => {
    const document = { $defs: { a: { type: 'string' } }, list: [{ x: 1 }, { y: 2 }], 'a/b': true, 'c~d': 1 };
    expect(resolve(document, '')).toBe(document);
    expect(resolve(document, '/$defs/a')).toEqual({ type: 'string' });
    expect(resolve(document, '/list/1')).toEqual({ y: 2 });
    expect(resolve(document, '/a~1b')).toBe(true);
    expect(resolve(document, '/c~0d')).toBe(1);
  });

  it('returns undefined for anything it cannot reach', () => {
    const document = { a: { b: 1 }, list: [1] };
    expect(resolve(document, '/missing')).toBeUndefined();
    expect(resolve(document, '/a/b/c')).toBeUndefined();
    expect(resolve(document, '/list/2')).toBeUndefined();
    expect(resolve(document, '/list/01')).toBeUndefined();
    expect(resolve(document, '/list/x')).toBeUndefined();
    expect(resolve(document, 'no-leading-slash')).toBeUndefined();
    expect(resolve(null, '/a')).toBeUndefined();
  });
});
