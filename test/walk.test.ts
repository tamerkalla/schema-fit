import { describe, expect, it } from 'vitest';
import type { JSONSchema, JSONSchemaObject } from '../src/types.js';
import { mapChildren, renameKeyword, withKeyword, without } from '../src/walk.js';

describe('mapChildren', () => {
  it('hands back the same object when nothing changed', () => {
    const schema = { type: 'object', properties: { a: { type: 'string' } }, allOf: [true] };
    expect(mapChildren(schema, '', (child) => child)).toBe(schema);
  });

  it('rebuilds when a child changed, and only then', () => {
    const schema = { type: 'object', properties: { a: { type: 'string' }, b: true } };
    const result = mapChildren(schema, '', (child) => (child === true ? false : child));
    expect(result).not.toBe(schema);
    expect(result).toEqual({ type: 'object', properties: { a: { type: 'string' }, b: false } });
  });

  it('keeps keyword order', () => {
    const schema = { title: 'x', properties: { a: true }, type: 'object' };
    const result = mapChildren(schema, '', () => false);
    expect(Object.keys(result)).toEqual(['title', 'properties', 'type']);
  });

  it('tells the visitor the path, whether it is deeper, and which keyword it came from', () => {
    const seen: Array<[string, boolean, string]> = [];
    mapChildren(
      { properties: { a: true }, anyOf: [true], not: true, items: [true], $defs: { d: true } },
      '/base',
      (child, path, nesting, keyword) => {
        seen.push([path, nesting, keyword]);
        return child;
      },
    );
    expect(seen).toEqual([
      ['/base/properties/a', true, 'properties'],
      ['/base/anyOf/0', false, 'anyOf'],
      ['/base/not', false, 'not'],
      ['/base/items/0', true, 'items'],
      ['/base/$defs/d', false, '$defs'],
    ]);
  });

  it('leaves alone what is not a subschema', () => {
    const schema = { required: ['a'], enum: [1, 2], properties: { a: 'nonsense' }, allOf: ['nonsense'] };
    expect(mapChildren(schema, '', () => false)).toBe(schema);
  });
});

describe('without', () => {
  it('drops the keywords named, keeping the order of the rest', () => {
    const schema = { a: 1, b: 2, c: 3 };
    expect(without(schema, 'b')).toEqual({ a: 1, c: 3 });
    expect(Object.keys(without(schema, 'b'))).toEqual(['a', 'c']);
    expect(without(schema, 'a', 'c')).toEqual({ b: 2 });
    expect(without(schema, 'missing')).toEqual(schema);
  });

  it('does not touch the original', () => {
    const schema: JSONSchemaObject = { a: 1, b: 2 };
    without(schema, 'a');
    expect(schema).toEqual({ a: 1, b: 2 });
  });
});

describe('withKeyword', () => {
  it('replaces in place when the keyword is already there', () => {
    const result = withKeyword({ a: 1, b: 2, c: 3 }, 'b', 9);
    expect(result).toEqual({ a: 1, b: 9, c: 3 });
    expect(Object.keys(result)).toEqual(['a', 'b', 'c']);
  });

  it('adds at the end by default', () => {
    expect(Object.keys(withKeyword({ a: 1 }, 'z', 2))).toEqual(['a', 'z']);
  });

  it('adds at the front when asked', () => {
    expect(Object.keys(withKeyword({ a: 1 }, 'z', 2, 'first'))).toEqual(['z', 'a']);
  });

  it('ignores the position when the keyword is already there', () => {
    expect(Object.keys(withKeyword({ a: 1, z: 0 }, 'z', 2, 'first'))).toEqual(['a', 'z']);
  });

  it('does not touch the original', () => {
    const schema: JSONSchemaObject = { a: 1 };
    withKeyword(schema, 'b', 2);
    expect(schema).toEqual({ a: 1 });
  });
});

describe('renameKeyword', () => {
  it('renames in place, keeping the position', () => {
    const result = renameKeyword({ a: 1, oneOf: [true], z: 2 }, 'oneOf', 'anyOf');
    expect(result).toEqual({ a: 1, anyOf: [true], z: 2 });
    expect(Object.keys(result)).toEqual(['a', 'anyOf', 'z']);
  });

  it('copies unchanged when the keyword is not there', () => {
    const schema: JSONSchema = { a: 1 };
    const result = renameKeyword(schema, 'oneOf', 'anyOf');
    expect(result).toEqual({ a: 1 });
    expect(result).not.toBe(schema);
  });
});
