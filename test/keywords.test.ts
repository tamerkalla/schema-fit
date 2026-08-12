import { describe, expect, it } from 'vitest';
import {
  ANNOTATION_KEYWORDS,
  KNOWN_KEYWORDS,
  NESTING_KEYWORDS,
  SCHEMA_ARRAY_KEYWORDS,
  SCHEMA_KEYWORDS,
  SCHEMA_MAP_KEYWORDS,
  acceptsEverything,
  clone,
  deepEqual,
  isObjectLike,
  isSchema,
  isSchemaObject,
  subschemas,
  typeList,
} from '../src/keywords.js';

/**
 * These lists decide what the whole library treats as a schema, as a level of
 * nesting, and as a keyword worth keeping. They are pinned exactly: an addition
 * is a deliberate decision, not something to discover from a failing property
 * test months later.
 */

describe('the keyword lists', () => {
  it('knows every draft 2020-12 keyword, and the two legacy spellings', () => {
    expect([...KNOWN_KEYWORDS].sort()).toEqual(
      [
        '$anchor',
        '$comment',
        '$defs',
        '$dynamicAnchor',
        '$dynamicRef',
        '$id',
        '$ref',
        '$schema',
        '$vocabulary',
        'additionalItems',
        'additionalProperties',
        'allOf',
        'anyOf',
        'const',
        'contains',
        'contentEncoding',
        'contentMediaType',
        'contentSchema',
        'default',
        'definitions',
        'dependentRequired',
        'dependentSchemas',
        'deprecated',
        'description',
        'else',
        'enum',
        'examples',
        'exclusiveMaximum',
        'exclusiveMinimum',
        'format',
        'if',
        'items',
        'maxContains',
        'maxItems',
        'maxLength',
        'maxProperties',
        'maximum',
        'minContains',
        'minItems',
        'minLength',
        'minProperties',
        'minimum',
        'multipleOf',
        'not',
        'oneOf',
        'pattern',
        'patternProperties',
        'prefixItems',
        'properties',
        'propertyNames',
        'readOnly',
        'required',
        'then',
        'title',
        'type',
        'unevaluatedItems',
        'unevaluatedProperties',
        'uniqueItems',
        'writeOnly',
      ].sort(),
    );
  });

  it('counts exactly these positions as a level of nesting', () => {
    expect([...NESTING_KEYWORDS].sort()).toEqual(
      [
        'additionalItems',
        'additionalProperties',
        'contains',
        'items',
        'patternProperties',
        'prefixItems',
        'properties',
        'propertyNames',
        'unevaluatedItems',
        'unevaluatedProperties',
      ].sort(),
    );
  });

  it('treats exactly these keywords as carrying no validation weight', () => {
    expect([...ANNOTATION_KEYWORDS].sort()).toEqual(
      [
        '$anchor',
        '$comment',
        '$defs',
        '$id',
        '$schema',
        'definitions',
        'deprecated',
        'description',
        'examples',
        'readOnly',
        'title',
        'writeOnly',
      ].sort(),
    );
  });

  it('knows where subschemas live', () => {
    expect([...SCHEMA_KEYWORDS]).toEqual([
      'additionalProperties',
      'additionalItems',
      'items',
      'contains',
      'not',
      'if',
      'then',
      'else',
      'propertyNames',
      'unevaluatedItems',
      'unevaluatedProperties',
      'contentSchema',
    ]);
    expect([...SCHEMA_ARRAY_KEYWORDS]).toEqual(['allOf', 'anyOf', 'oneOf', 'prefixItems']);
    expect([...SCHEMA_MAP_KEYWORDS]).toEqual([
      'properties',
      'patternProperties',
      'dependentSchemas',
      '$defs',
      'definitions',
    ]);
  });

  it('every annotation keyword is a keyword it knows', () => {
    for (const keyword of ANNOTATION_KEYWORDS) expect(KNOWN_KEYWORDS.has(keyword), keyword).toBe(true);
  });

  it('every nesting keyword is a keyword it knows', () => {
    for (const keyword of NESTING_KEYWORDS) expect(KNOWN_KEYWORDS.has(keyword), keyword).toBe(true);
  });
});

describe('subschemas', () => {
  it('finds every subschema, with its path and whether it is a level deeper', () => {
    const schema = {
      type: 'object',
      properties: { a: { type: 'string' }, 'x/y': true },
      patternProperties: { '^a': true },
      additionalProperties: false,
      propertyNames: { maxLength: 2 },
      items: { type: 'number' },
      prefixItems: [true, false],
      contains: true,
      not: true,
      if: true,
      then: true,
      else: true,
      allOf: [true],
      anyOf: [true],
      oneOf: [true],
      dependentSchemas: { a: true },
      $defs: { d: true },
      definitions: { e: true },
      unevaluatedItems: true,
      unevaluatedProperties: true,
      contentSchema: true,
      additionalItems: true,
      title: 'not a subschema',
      required: ['a'],
    };
    expect(subschemas(schema, '').map((slot) => [slot.path, slot.nesting, slot.keyword])).toEqual([
      ['/properties/a', true, 'properties'],
      ['/properties/x~1y', true, 'properties'],
      ['/patternProperties/^a', true, 'patternProperties'],
      ['/additionalProperties', true, 'additionalProperties'],
      ['/propertyNames', true, 'propertyNames'],
      ['/items', true, 'items'],
      ['/prefixItems/0', true, 'prefixItems'],
      ['/prefixItems/1', true, 'prefixItems'],
      ['/contains', true, 'contains'],
      ['/not', false, 'not'],
      ['/if', false, 'if'],
      ['/then', false, 'then'],
      ['/else', false, 'else'],
      ['/allOf/0', false, 'allOf'],
      ['/anyOf/0', false, 'anyOf'],
      ['/oneOf/0', false, 'oneOf'],
      ['/dependentSchemas/a', false, 'dependentSchemas'],
      ['/$defs/d', false, '$defs'],
      ['/definitions/e', false, 'definitions'],
      ['/unevaluatedItems', true, 'unevaluatedItems'],
      ['/unevaluatedProperties', true, 'unevaluatedProperties'],
      ['/contentSchema', false, 'contentSchema'],
      ['/additionalItems', true, 'additionalItems'],
    ]);
  });

  it('reads the draft-07 tuple spelling as a list of item schemas', () => {
    expect(subschemas({ items: [true, { type: 'string' }] }, '/x').map((slot) => [slot.path, slot.nesting])).toEqual([
      ['/x/items/0', true],
      ['/x/items/1', true],
    ]);
  });

  it('finds nothing in a schema without subschemas', () => {
    expect(subschemas({ type: 'string', required: ['a'], enum: [1] }, '')).toEqual([]);
  });

  it('skips entries that are not schemas at all', () => {
    expect(subschemas({ properties: { a: 'nonsense' }, allOf: ['nonsense'] }, '')).toEqual([]);
  });
});

describe('the small predicates', () => {
  it('tells a schema object from anything else', () => {
    expect(isSchemaObject({})).toBe(true);
    expect(isSchemaObject([])).toBe(false);
    expect(isSchemaObject(null)).toBe(false);
    expect(isSchemaObject(true)).toBe(false);
    expect(isSchemaObject('x')).toBe(false);
  });

  it('counts booleans as schemas too', () => {
    expect(isSchema(true)).toBe(true);
    expect(isSchema(false)).toBe(true);
    expect(isSchema({})).toBe(true);
    expect(isSchema([])).toBe(false);
    expect(isSchema('x')).toBe(false);
  });

  it('knows which schemas accept everything', () => {
    expect(acceptsEverything(true)).toBe(true);
    expect(acceptsEverything({})).toBe(true);
    expect(acceptsEverything({ title: 'x', description: 'y' })).toBe(true);
    expect(acceptsEverything(false)).toBe(false);
    expect(acceptsEverything({ type: 'string' })).toBe(false);
    expect(acceptsEverything({ title: 'x', minLength: 1 })).toBe(false);
  });

  it('normalises type to a list', () => {
    expect(typeList({ type: 'string' })).toEqual(['string']);
    expect(typeList({ type: ['string', 'null'] })).toEqual(['string', 'null']);
    expect(typeList({ type: [] })).toEqual([]);
    expect(typeList({})).toBeUndefined();
    expect(typeList({ type: 5 })).toBeUndefined();
    expect(typeList({ type: ['string', 5] })).toEqual(['string']);
  });

  it('knows which schemas can accept an object', () => {
    expect(isObjectLike({ type: 'object' })).toBe(true);
    expect(isObjectLike({ type: ['object', 'null'] })).toBe(true);
    expect(isObjectLike({ properties: {} })).toBe(true);
    expect(isObjectLike({ patternProperties: {} })).toBe(true);
    expect(isObjectLike({ type: 'string' })).toBe(false);
    expect(isObjectLike({ type: 'string', properties: {} })).toBe(false);
    expect(isObjectLike({})).toBe(false);
    expect(isObjectLike(true)).toBe(false);
  });
});

describe('deepEqual', () => {
  it('compares by structure', () => {
    expect(deepEqual(1, 1)).toBe(true);
    expect(deepEqual('a', 'a')).toBe(true);
    expect(deepEqual(null, null)).toBe(true);
    expect(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
    expect(deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
  });

  it('sees through anything that differs', () => {
    expect(deepEqual(1, '1')).toBe(false);
    expect(deepEqual(null, {})).toBe(false);
    expect(deepEqual({}, null)).toBe(false);
    expect(deepEqual([1], [1, 2])).toBe(false);
    expect(deepEqual([1], { 0: 1 })).toBe(false);
    expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(deepEqual({ a: 1, b: 2 }, { a: 1, c: 2 })).toBe(false);
    expect(deepEqual([1, 2], [2, 1])).toBe(false);
  });
});

describe('clone', () => {
  it('copies deeply, sharing nothing', () => {
    const source = { a: [1, { b: 2 }], c: null, d: 'x', e: true };
    const copy = clone(source);
    expect(copy).toEqual(source);
    expect(copy).not.toBe(source);
    expect(copy.a).not.toBe(source.a);
    expect(copy.a[1]).not.toBe(source.a[1]);
  });

  it('passes primitives straight through', () => {
    expect(clone(1)).toBe(1);
    expect(clone('x')).toBe('x');
    expect(clone(null)).toBe(null);
    expect(clone(true)).toBe(true);
  });
});
