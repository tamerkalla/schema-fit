import { describe, expect, it } from 'vitest';
import { intersect, intersectAll, isUnsatisfiable, unsatisfiable } from '../src/intersect.js';
import type { JSONSchema } from '../src/types.js';

/**
 * The merge engine is where "and" gets written as a single schema. When it
 * cannot be, it says so, and hands back something that accepts nothing — never
 * something that accepts more than both inputs.
 */

interface Row {
  name: string;
  a: JSONSchema;
  b: JSONSchema;
  schema: JSONSchema;
  exact: boolean;
}

const NOTHING = unsatisfiable();

const rows: Row[] = [
  { name: 'true is the identity', a: true, b: { type: 'string' }, schema: { type: 'string' }, exact: true },
  { name: 'the empty schema is the identity', a: {}, b: { type: 'string' }, schema: { type: 'string' }, exact: true },
  { name: 'false swallows everything', a: false, b: { type: 'string' }, schema: NOTHING, exact: true },
  { name: 'identical schemas merge to themselves', a: { type: 'string' }, b: { type: 'string' }, schema: { type: 'string' }, exact: true },

  { name: 'types intersect', a: { type: ['string', 'number'] }, b: { type: ['number', 'null'] }, schema: { type: 'number' }, exact: true },
  { name: 'integer is inside number', a: { type: 'number' }, b: { type: 'integer' }, schema: { type: 'integer' }, exact: true },
  { name: 'integer is inside number, either way round', a: { type: 'integer' }, b: { type: 'number' }, schema: { type: 'integer' }, exact: true },
  { name: 'disjoint types accept nothing', a: { type: 'string' }, b: { type: 'number' }, schema: NOTHING, exact: false },
  { name: 'more than one type survives', a: { type: ['string', 'number', 'null'] }, b: { type: ['string', 'number'] }, schema: { type: ['string', 'number'] }, exact: true },

  { name: 'enums intersect', a: { enum: [1, 2, 3] }, b: { enum: [2, 3, 4] }, schema: { enum: [2, 3] }, exact: true },
  { name: 'an enum and a const intersect', a: { enum: ['a', 'b'] }, b: { const: 'b' }, schema: { enum: ['b'] }, exact: true },
  { name: 'two identical consts stay a const', a: { const: 'b' }, b: { const: 'b' }, schema: { const: 'b' }, exact: true },
  { name: 'two different consts accept nothing', a: { const: 'a' }, b: { const: 'b' }, schema: NOTHING, exact: false },
  { name: 'an enum on one side is carried across', a: { enum: [1, 2] }, b: { type: 'integer' }, schema: { type: 'integer', enum: [1, 2] }, exact: true },

  { name: 'the tighter number bound wins', a: { minimum: 1, maximum: 9 }, b: { minimum: 4, maximum: 5 }, schema: { minimum: 4, maximum: 5 }, exact: true },
  { name: 'exclusive bounds tighten too', a: { exclusiveMinimum: 1, exclusiveMaximum: 9 }, b: { exclusiveMinimum: 2, exclusiveMaximum: 8 }, schema: { exclusiveMinimum: 2, exclusiveMaximum: 8 }, exact: true },
  { name: 'a multiple of a multiple is the tighter one', a: { multipleOf: 2 }, b: { multipleOf: 6 }, schema: { multipleOf: 6 }, exact: true },
  { name: 'unrelated multiples cannot be merged', a: { multipleOf: 4 }, b: { multipleOf: 6 }, schema: NOTHING, exact: false },

  { name: 'the tighter length wins', a: { minLength: 1, maxLength: 9 }, b: { minLength: 3, maxLength: 5 }, schema: { minLength: 3, maxLength: 5 }, exact: true },
  { name: 'the same pattern merges', a: { pattern: '^a' }, b: { pattern: '^a' }, schema: { pattern: '^a' }, exact: true },
  { name: 'two different patterns cannot be merged', a: { pattern: '^a' }, b: { pattern: '^b' }, schema: NOTHING, exact: false },

  { name: 'the tighter item count wins', a: { minItems: 1, maxItems: 9 }, b: { minItems: 2 }, schema: { minItems: 2, maxItems: 9 }, exact: true },
  { name: 'uniqueness is kept if either side wants it', a: { uniqueItems: true }, b: { type: 'array' }, schema: { type: 'array', uniqueItems: true }, exact: true },
  { name: 'item schemas merge', a: { items: { type: 'string' } }, b: { items: { minLength: 2 } }, schema: { items: { type: 'string', minLength: 2 } }, exact: true },
  {
    name: 'a tuple merges position by position, with the rest schema filling in',
    a: { prefixItems: [{ type: 'string' }] },
    b: { prefixItems: [{ minLength: 1 }, { type: 'number' }], items: { type: 'number' } },
    schema: { prefixItems: [{ type: 'string', minLength: 1 }, { type: 'number' }], items: { type: 'number' } },
    exact: true,
  },
  { name: 'two contains keywords cannot be merged', a: { contains: { type: 'string' } }, b: { contains: { type: 'number' } }, schema: NOTHING, exact: false },

  {
    name: 'properties merge key by key and required is the union',
    a: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
    b: { type: 'object', properties: { x: { minLength: 2 }, y: { type: 'number' } }, required: ['y'] },
    schema: {
      type: 'object',
      properties: { x: { type: 'string', minLength: 2 }, y: { type: 'number' } },
      required: ['x', 'y'],
    },
    exact: true,
  },
  {
    // The closed side allows no `y` at all, so the merge has to reject any
    // object carrying one — not quietly let the other side's `y` through.
    name: 'a closed object bans the properties the other side declares',
    a: { properties: { x: { type: 'string' } }, additionalProperties: false },
    b: { properties: { y: { type: 'number' } } },
    schema: {
      properties: { x: { type: 'string' }, y: NOTHING },
      additionalProperties: false,
    },
    exact: true,
  },
  {
    name: 'a property one side does not declare still meets its additionalProperties',
    a: { properties: { x: { type: 'string' } } },
    b: { additionalProperties: { maxLength: 3 } },
    schema: { properties: { x: { type: 'string', maxLength: 3 } }, additionalProperties: { maxLength: 3 } },
    exact: true,
  },
  {
    name: 'a property matched by a pattern is left to the pattern, which is carried across',
    a: { patternProperties: { '^x': { type: 'string' } } },
    b: { properties: { xy: { minLength: 2 } } },
    schema: {
      properties: { xy: { minLength: 2 } },
      patternProperties: { '^x': { type: 'string' } },
    },
    exact: true,
  },
  {
    name: 'property names merge',
    a: { propertyNames: { maxLength: 4 } },
    b: { propertyNames: { pattern: '^a' } },
    schema: { propertyNames: { maxLength: 4, pattern: '^a' } },
    exact: true,
  },
  {
    name: 'dependent requirements are unioned per key',
    a: { dependentRequired: { x: ['a'] } },
    b: { dependentRequired: { x: ['b'], y: ['c'] } },
    schema: { dependentRequired: { x: ['a', 'b'], y: ['c'] } },
    exact: true,
  },

  { name: 'allOf lists are concatenated', a: { allOf: [{ type: 'string' }] }, b: { allOf: [{ minLength: 1 }] }, schema: { allOf: [{ type: 'string' }, { minLength: 1 }] }, exact: true },
  { name: 'one anyOf is carried across', a: { anyOf: [{ type: 'string' }] }, b: { minLength: 1 }, schema: { minLength: 1, anyOf: [{ type: 'string' }] }, exact: true },
  { name: 'two anyOfs cannot be merged', a: { anyOf: [{ type: 'string' }] }, b: { anyOf: [{ type: 'number' }] }, schema: NOTHING, exact: false },
  { name: 'a reference cannot be merged', a: { $ref: '#/$defs/a' }, b: { type: 'string' }, schema: NOTHING, exact: false },
  { name: 'unevaluatedProperties cannot be merged', a: { unevaluatedProperties: false }, b: { type: 'object' }, schema: NOTHING, exact: false },


  // --- one side only: the carry paths -------------------------------------
  { name: 'a type on one side only is carried across', a: { type: 'string' }, b: { minLength: 1 }, schema: { type: 'string', minLength: 1 }, exact: true },
  { name: 'a const on the second side is carried across', a: { type: 'string' }, b: { const: 'x' }, schema: { type: 'string', const: 'x' }, exact: true },
  { name: 'a multipleOf on one side only is carried across', a: { multipleOf: 3 }, b: { type: 'integer' }, schema: { type: 'integer', multipleOf: 3 }, exact: true },
  { name: 'a bound on one side only is carried across', a: { minimum: 2 }, b: { maximum: 8 }, schema: { minimum: 2, maximum: 8 }, exact: true },
  { name: 'a format on the second side only is carried across', a: { type: 'string' }, b: { format: 'uuid' }, schema: { type: 'string', format: 'uuid' }, exact: true },
  { name: 'a pattern on the second side only is carried across', a: { type: 'string' }, b: { pattern: '^a' }, schema: { type: 'string', pattern: '^a' }, exact: true },
  { name: 'uniqueItems false on both sides stays off', a: { uniqueItems: false }, b: { type: 'array' }, schema: { type: 'array', uniqueItems: false }, exact: true },
  {
    name: 'contains on one side is carried with its counts',
    a: { contains: { type: 'string' }, minContains: 1, maxContains: 3 },
    b: { type: 'array' },
    schema: { type: 'array', contains: { type: 'string' }, minContains: 1, maxContains: 3 },
    exact: true,
  },
  { name: 'an item schema on one side only is carried across', a: { items: { type: 'string' } }, b: { type: 'array' }, schema: { type: 'array', items: { type: 'string' } }, exact: true },
  {
    name: 'a tuple on one side keeps its positions and constrains the rest with the other side',
    a: { prefixItems: [{ type: 'string' }] },
    b: { items: { maxLength: 3 } },
    schema: { prefixItems: [{ type: 'string', maxLength: 3 }], items: { maxLength: 3 } },
    exact: true,
  },
  {
    name: 'the draft-07 tuple spelling is read as positions too',
    a: { items: [{ type: 'string' }] },
    b: { items: { maxLength: 3 } },
    schema: { prefixItems: [{ type: 'string', maxLength: 3 }], items: { maxLength: 3 } },
    exact: true,
  },
  { name: 'the tighter property count wins', a: { minProperties: 1, maxProperties: 9 }, b: { minProperties: 3, maxProperties: 4 }, schema: { minProperties: 3, maxProperties: 4 }, exact: true },
  { name: 'required on one side only is carried across', a: { required: ['x'] }, b: { type: 'object' }, schema: { type: 'object', required: ['x'] }, exact: true },
  { name: 'property names on one side only are carried across', a: { propertyNames: { maxLength: 2 } }, b: { type: 'object' }, schema: { type: 'object', propertyNames: { maxLength: 2 } }, exact: true },
  {
    name: 'dependent schemas merge key by key',
    a: { dependentSchemas: { x: { required: ['a'] }, y: true } },
    b: { dependentSchemas: { x: { required: ['b'] } } },
    schema: { dependentSchemas: { x: { required: ['a', 'b'] }, y: true } },
    exact: true,
  },
  { name: 'dependent requirements on one side only are carried across', a: { dependentRequired: { x: ['a'] } }, b: { type: 'object' }, schema: { type: 'object', dependentRequired: { x: ['a'] } }, exact: true },
  {
    name: 'the same pattern on both sides merges its schemas',
    a: { patternProperties: { '^a': { type: 'string' } } },
    b: { patternProperties: { '^a': { minLength: 2 }, '^b': true } },
    schema: { patternProperties: { '^a': { type: 'string', minLength: 2 }, '^b': true } },
    exact: true,
  },
  {
    name: 'a pattern that is not a regular expression cannot be merged',
    a: { patternProperties: { '[': true } },
    b: { properties: { x: { type: 'string' } } },
    schema: NOTHING,
    exact: false,
  },
  { name: 'an allOf on one side only is carried across', a: { allOf: [{ type: 'string' }] }, b: { minLength: 1 }, schema: { minLength: 1, allOf: [{ type: 'string' }] }, exact: true },
  { name: 'two nots cannot be merged', a: { not: { type: 'string' } }, b: { not: { type: 'number' } }, schema: NOTHING, exact: false },
  { name: 'two ifs cannot be merged', a: { if: true, then: { type: 'string' } }, b: { if: false, then: true }, schema: NOTHING, exact: false },
  {
    name: 'a conditional on the second side is carried across whole',
    a: { type: 'object' },
    b: { if: { required: ['x'] }, then: { required: ['y'] }, else: { required: ['z'] } },
    schema: { type: 'object', if: { required: ['x'] }, then: { required: ['y'] }, else: { required: ['z'] } },
    exact: true,
  },
  { name: 'a dynamic reference cannot be merged', a: { $dynamicRef: '#node' }, b: { type: 'string' }, schema: NOTHING, exact: false },
  { name: 'unevaluatedItems cannot be merged', a: { unevaluatedItems: false }, b: { type: 'array' }, schema: NOTHING, exact: false },
  { name: 'a keyword nobody knows is carried from either side', a: { type: 'string', 'x-a': 1 }, b: { minLength: 1, 'x-b': 2 }, schema: { type: 'string', minLength: 1, 'x-a': 1, 'x-b': 2 }, exact: true },
  { name: 'a schema that accepts nothing swallows the other side', a: { type: 'object', properties: {}, additionalProperties: false, required: ['__schema_fit_unsatisfiable__'] }, b: { type: 'string' }, schema: NOTHING, exact: true },
  { name: 'two schemas that constrain nothing merge to true', a: { title: 'a' }, b: true, schema: true, exact: true },
  {
    name: 'annotations are kept, the first side winning',
    a: { type: 'string', title: 'a' },
    b: { minLength: 1, title: 'b', description: 'd' },
    schema: { type: 'string', minLength: 1, title: 'a', description: 'd' },
    exact: true,
  },
  {
    // A schema carrying nothing but annotations accepts everything, so merging
    // it is the same as not merging it at all.
    name: 'a schema of nothing but annotations is the identity',
    a: { title: 'a' },
    b: { title: 'b', description: 'd' },
    schema: { title: 'b', description: 'd' },
    exact: true,
  },
  { name: 'a format is kept as a note', a: { format: 'email' }, b: { format: 'uri' }, schema: { format: 'email' }, exact: true },
];

describe('intersect', () => {
  for (const row of rows) {
    it(row.name, () => {
      const result = intersect(row.a, row.b);
      expect(result.schema).toEqual(row.schema);
      expect(result.exact).toBe(row.exact);
    });
  }

  it('is commutative in what it accepts, if not in key order', () => {
    for (const row of rows) {
      const flipped = intersect(row.b, row.a);
      expect(flipped.exact).toBe(row.exact);
      if (!row.exact) expect(isUnsatisfiable(flipped.schema)).toBe(true);
    }
  });

  it('never mutates its inputs', () => {
    for (const row of rows) {
      const a = structuredClone(row.a);
      const b = structuredClone(row.b);
      intersect(row.a, row.b);
      expect(row.a).toEqual(a);
      expect(row.b).toEqual(b);
    }
  });

  it('folds a list of schemas', () => {
    expect(intersectAll([])).toEqual({ schema: true, exact: true });
    expect(intersectAll([{ type: 'string' }])).toEqual({ schema: { type: 'string' }, exact: true });
    expect(intersectAll([{ type: 'string' }, { minLength: 1 }, { maxLength: 3 }])).toEqual({
      schema: { type: 'string', minLength: 1, maxLength: 3 },
      exact: true,
    });
    const broken = intersectAll([{ type: 'string' }, { type: 'number' }, { minLength: 1 }]);
    expect(broken.exact).toBe(false);
    expect(isUnsatisfiable(broken.schema)).toBe(true);
  });

  it('recognises the schemas that accept nothing', () => {
    expect(isUnsatisfiable(false)).toBe(true);
    expect(isUnsatisfiable(unsatisfiable())).toBe(true);
    expect(isUnsatisfiable(true)).toBe(false);
    expect(isUnsatisfiable({})).toBe(false);
    expect(isUnsatisfiable({ type: 'object', properties: {}, additionalProperties: false, required: ['a'] })).toBe(false);
  });
});
