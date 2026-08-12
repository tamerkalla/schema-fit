import { describe, expect, it } from 'vitest';
import { check } from '../src/check.js';
import { profiles } from '../src/profiles.js';
import type { JSONSchema, Profile, Violation } from '../src/types.js';
import { narrow, noBounds, noRefs, noSiblings, permissive, shallow, variant } from './profiles.js';

/**
 * Rows assert the full violation array as `path` + `rule` pairs. Message text is
 * asserted separately, once, for every row: it is prose, and pinning it here
 * would make every wording fix look like a behaviour change.
 */
interface Row {
  name: string;
  schema: JSONSchema;
  profile: Profile;
  expected: Array<{ path: string; rule: string }>;
}

const { openaiStrict, anthropic, gemini } = profiles;

const rows: Row[] = [
  // --- degenerate schemas -------------------------------------------------
  { name: 'empty schema, openai', schema: {}, profile: openaiStrict, expected: [{ path: '', rule: 'root-must-be-object' }] },
  { name: 'empty schema, anthropic', schema: {}, profile: anthropic, expected: [{ path: '', rule: 'root-must-be-object' }] },
  { name: 'empty schema, gemini', schema: {}, profile: gemini, expected: [] },
  { name: 'true as a schema, openai', schema: true, profile: openaiStrict, expected: [{ path: '', rule: 'root-must-be-object' }] },
  { name: 'true as a schema, gemini', schema: true, profile: gemini, expected: [] },
  { name: 'false as a schema, openai', schema: false, profile: openaiStrict, expected: [{ path: '', rule: 'root-must-be-object' }] },
  { name: 'false as a schema, gemini', schema: false, profile: gemini, expected: [] },

  // --- schemas already conforming ----------------------------------------
  {
    name: 'conforming schema, openai',
    schema: {
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: ['integer', 'null'] } },
      required: ['a', 'b'],
      additionalProperties: false,
    },
    profile: openaiStrict,
    expected: [],
  },
  {
    name: 'conforming schema, anthropic',
    schema: {
      type: 'object',
      properties: { a: { type: 'string', format: 'uri', default: 'x' } },
      oneOf: [true, true],
      not: false,
    },
    profile: anthropic,
    expected: [],
  },
  {
    name: 'conforming schema, gemini',
    schema: { type: 'array', items: { type: 'string', enum: ['a', 'b'] }, minItems: 1 },
    profile: gemini,
    expected: [],
  },

  // --- unknown keywords ---------------------------------------------------
  {
    name: 'unknown keyword is reported when the profile strips',
    schema: { type: 'object', additionalProperties: false, 'x-vendor': 1 },
    profile: openaiStrict,
    expected: [{ path: '/x-vendor', rule: 'unknown-keyword' }],
  },
  {
    name: 'unknown keyword is kept quietly when the profile keeps',
    schema: { type: 'object', 'x-vendor': 1 },
    profile: anthropic,
    expected: [],
  },
  {
    name: 'a property named like a keyword is not a keyword',
    schema: { type: 'object', additionalProperties: false, properties: { 'x-vendor': true }, required: ['x-vendor'] },
    profile: openaiStrict,
    expected: [],
  },

  // --- references ---------------------------------------------------------
  {
    name: 'refs: none reports both the reference and the definitions',
    schema: { $defs: { a: true }, $ref: '#/$defs/a' },
    profile: noRefs,
    expected: [
      { path: '/$defs', rule: 'no-defs' },
      { path: '/$ref', rule: 'no-ref' },
    ],
  },
  {
    name: 'refs: internal accepts a plain internal reference',
    schema: { $defs: { a: { type: 'string' } }, properties: { p: { $ref: '#/$defs/a' } } },
    profile: permissive,
    expected: [],
  },
  {
    name: 'refs: internal-no-siblings reports a reference with a validating neighbour',
    schema: { $defs: { a: { type: 'string' } }, properties: { p: { $ref: '#/$defs/a', minLength: 1 } } },
    profile: noSiblings,
    expected: [{ path: '/properties/p/$ref', rule: 'ref-siblings' }],
  },
  {
    name: 'refs: internal-no-siblings ignores annotation neighbours',
    schema: { $defs: { a: { type: 'string' } }, properties: { p: { $ref: '#/$defs/a', description: 'x' } } },
    profile: noSiblings,
    expected: [],
  },
  {
    name: 'a reference pointing outside the schema is reported',
    schema: { $ref: 'https://example.com/schema.json' },
    profile: permissive,
    expected: [{ path: '/$ref', rule: 'external-ref' }],
  },
  {
    name: 'a reference pointing nowhere is reported',
    schema: { $ref: '#/$defs/missing' },
    profile: permissive,
    expected: [{ path: '/$ref', rule: 'unresolvable-ref' }],
  },
  {
    // The rule named here is the rule `fit` will use, whatever the refs setting.
    name: 'a broken reference is reported as broken, not as a reference',
    schema: { $ref: '#/$defs/missing' },
    profile: noRefs,
    expected: [{ path: '/$ref', rule: 'unresolvable-ref' }],
  },

  // --- combinators --------------------------------------------------------
  {
    name: 'oneOf is reported for openai',
    schema: { type: 'object', additionalProperties: false, oneOf: [true, true] },
    profile: openaiStrict,
    expected: [{ path: '/oneOf', rule: 'no-oneof' }],
  },
  {
    name: 'anyOf is reported when unsupported',
    schema: { anyOf: [true, true] },
    profile: variant(permissive, { supports: { anyOf: false } }),
    expected: [{ path: '/anyOf', rule: 'no-anyof' }],
  },
  {
    name: 'allOf is reported for openai',
    schema: { type: 'object', additionalProperties: false, allOf: [true] },
    profile: openaiStrict,
    expected: [{ path: '/allOf', rule: 'no-allof' }],
  },
  {
    name: 'not is reported for openai',
    schema: { type: 'object', additionalProperties: false, not: true },
    profile: openaiStrict,
    expected: [{ path: '/not', rule: 'no-not' }],
  },
  {
    name: 'every combinator at once, sorted by path',
    schema: { allOf: [true], anyOf: [true], not: true, oneOf: [true] },
    profile: variant(permissive, { supports: { oneOf: false, anyOf: false, allOf: false, not: false } }),
    expected: [
      { path: '/allOf', rule: 'no-allof' },
      { path: '/anyOf', rule: 'no-anyof' },
      { path: '/not', rule: 'no-not' },
      { path: '/oneOf', rule: 'no-oneof' },
    ],
  },

  // --- values and constraints --------------------------------------------
  {
    name: 'enum is reported when unsupported',
    schema: { enum: [1, 2] },
    profile: variant(permissive, { supports: { enum: false } }),
    expected: [{ path: '/enum', rule: 'no-enum' }],
  },
  {
    name: 'const is reported for openai',
    schema: { type: 'object', additionalProperties: false, const: {} },
    profile: openaiStrict,
    expected: [{ path: '/const', rule: 'no-const' }],
  },
  {
    name: 'patternProperties is reported for openai',
    schema: { type: 'object', additionalProperties: false, patternProperties: { '^a': true } },
    profile: openaiStrict,
    expected: [{ path: '/patternProperties', rule: 'no-pattern-properties' }],
  },
  {
    name: 'prefixItems is reported for gemini',
    schema: { type: 'array', prefixItems: [true] },
    profile: gemini,
    expected: [{ path: '/prefixItems', rule: 'no-tuple-items' }],
  },
  {
    name: 'the draft-07 tuple spelling is reported too',
    schema: { type: 'array', items: [true] },
    profile: gemini,
    expected: [{ path: '/items', rule: 'no-tuple-items' }],
  },
  {
    name: 'additionalItems is reported for gemini',
    schema: { type: 'array', additionalItems: true },
    profile: gemini,
    expected: [{ path: '/additionalItems', rule: 'no-additional-items' }],
  },
  {
    name: 'an unhonoured format is reported',
    schema: { type: 'object', additionalProperties: false, format: 'uri' },
    profile: openaiStrict,
    expected: [{ path: '/format', rule: 'no-format' }],
  },
  {
    name: 'an honoured format is not reported',
    schema: { type: 'object', additionalProperties: false, format: 'uuid' },
    profile: openaiStrict,
    expected: [],
  },
  {
    name: 'every kind of bound is reported when unhonoured',
    schema: { minimum: 1, maxLength: 2, uniqueItems: true, default: 3 },
    profile: noBounds,
    expected: [
      { path: '/default', rule: 'no-defaults' },
      { path: '/maxLength', rule: 'no-string-bounds' },
      { path: '/minimum', rule: 'no-numeric-bounds' },
      { path: '/uniqueItems', rule: 'no-array-bounds' },
    ],
  },
  {
    name: 'a list of types is reported for gemini',
    schema: { type: ['string', 'null'] },
    profile: gemini,
    expected: [{ path: '/type', rule: 'no-nullable-via-type' }],
  },
  {
    name: 'a list of types is fine for openai',
    schema: { type: 'object', additionalProperties: false, properties: { a: { type: ['string', 'null'] } }, required: ['a'] },
    profile: openaiStrict,
    expected: [],
  },

  // --- object shape -------------------------------------------------------
  {
    name: 'an open object is reported for openai',
    schema: { type: 'object' },
    profile: openaiStrict,
    expected: [{ path: '/additionalProperties', rule: 'additional-properties-must-be-false' }],
  },
  {
    name: 'an optional property is reported for openai',
    schema: { type: 'object', additionalProperties: false, properties: { a: true, b: true }, required: ['a'] },
    profile: openaiStrict,
    expected: [{ path: '/properties/b', rule: 'property-must-be-required' }],
  },
  {
    name: 'too many properties on one object',
    schema: { type: 'object', properties: { a: true, b: true, c: true } },
    profile: narrow,
    expected: [{ path: '/properties', rule: 'max-properties' }],
  },
  {
    name: 'exactly at the property limit',
    schema: { type: 'object', properties: { a: true, b: true } },
    profile: narrow,
    expected: [],
  },

  // --- nesting ------------------------------------------------------------
  {
    name: 'nesting exactly at the limit',
    schema: { properties: { a: { properties: { b: { type: 'string' } } } } },
    profile: shallow,
    expected: [],
  },
  {
    name: 'nesting one level past the limit',
    schema: { properties: { a: { properties: { b: { properties: { c: { type: 'string' } } } } } } },
    profile: shallow,
    expected: [{ path: '/properties/a/properties/b/properties/c', rule: 'max-depth' }],
  },
  {
    name: 'combinators do not count as nesting',
    schema: { anyOf: [{ anyOf: [{ properties: { a: { properties: { b: { type: 'string' } } } } }] }] },
    profile: shallow,
    expected: [],
  },
];

describe('check', () => {
  for (const row of rows) {
    it(row.name, () => {
      const result = check(row.schema, row.profile);
      expect(result.violations.map(({ path, rule }) => ({ path, rule }))).toEqual(row.expected);
      expect(result.ok).toBe(row.expected.length === 0);
    });
  }

  it('every message is one plain sentence', () => {
    const seen: Violation[] = [];
    for (const row of rows) seen.push(...check(row.schema, row.profile).violations);
    expect(seen.length).toBeGreaterThan(20);
    for (const violation of seen) {
      expect(violation.message.length).toBeGreaterThan(10);
      expect(violation.message.endsWith('.')).toBe(true);
    }
  });

  it('violations are sorted by path, then rule', () => {
    const schema = {
      type: 'string',
      'x-b': 1,
      'x-a': 1,
      allOf: [true],
    };
    const result = check(schema, variant(profiles.openaiStrict, { supports: { allOf: false } }));
    expect(result.violations.map((violation) => [violation.path, violation.rule])).toEqual([
      ['', 'root-must-be-object'],
      ['/allOf', 'no-allof'],
      ['/x-a', 'unknown-keyword'],
      ['/x-b', 'unknown-keyword'],
    ]);
  });

  it('sorts two violations at the same path by rule', () => {
    // The property schema sits one level too deep *and* the object it hangs off
    // has to be closed, so both land on the same pointer.
    // The schema for anything undeclared is both a level too deep and not the
    // `false` this provider demands, so both violations land on one pointer.
    const flat = variant(profiles.openaiStrict, { maxDepth: 0 });
    const result = check({ type: 'object', additionalProperties: { type: 'string' } }, flat);
    expect(result.violations.map((violation) => [violation.path, violation.rule])).toEqual([
      ['/additionalProperties', 'additional-properties-must-be-false'],
      ['/additionalProperties', 'max-depth'],
    ]);
  });

  it('counts nesting from the root, whichever way down', () => {
    const flat = variant(permissive, { maxDepth: 1 });
    const result = check({ items: { properties: { a: { type: 'string' } } } }, flat);
    expect(result.violations.map((violation) => violation.path)).toEqual(['/items/properties/a']);
  });

  it('does not touch the schema it is given', () => {
    const schema = Object.freeze({ type: 'string', allOf: Object.freeze([Object.freeze({ minimum: 1 })]) });
    expect(() => check(schema, profiles.openaiStrict)).not.toThrow();
  });
});
