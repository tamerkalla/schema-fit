import { describe, expect, it } from 'vitest';
import { check } from '../src/check.js';
import { PASSES, fit, fitInternal } from '../src/fit.js';
import type { PassId } from '../src/fit.js';
import { profiles } from '../src/profiles.js';
import { UnfittableSchemaError } from '../src/types.js';
import type { Change, JSONSchema, Profile } from '../src/types.js';
import { narrow, noBounds, noRefs, noSiblings, permissive, shallow, variant } from './profiles.js';

/** What `fit` produces when a rewrite cannot be written any other way. */
const NOTHING = {
  type: 'object',
  properties: {},
  additionalProperties: false,
  required: ['__schema_fit_unsatisfiable__'],
};

interface Row {
  name: string;
  schema: JSONSchema;
  profile: Profile;
  /** The exact schema `fit` must produce. */
  fitted: JSONSchema;
  /** The exact change list, as `path` + `rule` + `narrowing`. */
  changes: Array<{ path: string; rule: string; narrowing: boolean }>;
}

const { openaiStrict, anthropic, gemini } = profiles;

const rows: Row[] = [
  // --- rule 1: unknown keywords ------------------------------------------
  {
    name: 'strips an unknown keyword',
    schema: { type: 'object', additionalProperties: false, 'x-vendor': 1 },
    profile: openaiStrict,
    fitted: { type: 'object', additionalProperties: false },
    changes: [{ path: '/x-vendor', rule: 'unknown-keyword', narrowing: false }],
  },
  {
    name: 'keeps an unknown keyword when the profile keeps',
    schema: { type: 'object', 'x-vendor': 1 },
    profile: anthropic,
    fitted: { type: 'object', 'x-vendor': 1 },
    changes: [],
  },

  // --- rule 2: references -------------------------------------------------
  {
    name: 'inlines a reference when the profile forbids references',
    schema: { $defs: { a: { type: 'string' } }, type: 'object', properties: { p: { $ref: '#/$defs/a' } } },
    profile: noRefs,
    fitted: { type: 'object', properties: { p: { type: 'string' } } },
    changes: [
      { path: '/properties/p/$ref', rule: 'no-ref', narrowing: false },
      { path: '/$defs', rule: 'no-defs', narrowing: false },
    ],
  },
  {
    name: 'keeps a reference when the profile allows it',
    schema: { $defs: { a: { type: 'string' } }, properties: { p: { $ref: '#/$defs/a' } } },
    profile: permissive,
    fitted: { $defs: { a: { type: 'string' } }, properties: { p: { $ref: '#/$defs/a' } } },
    changes: [],
  },
  {
    name: 'inlines a reference that has a validating neighbour',
    schema: { $defs: { a: { type: 'string' } }, properties: { p: { $ref: '#/$defs/a', minLength: 2 } } },
    profile: noSiblings,
    fitted: { $defs: { a: { type: 'string' } }, properties: { p: { type: 'string', minLength: 2 } } },
    changes: [{ path: '/properties/p/$ref', rule: 'ref-siblings', narrowing: false }],
  },
  {
    name: 'carries annotations onto an inlined reference',
    schema: { $defs: { a: { type: 'string' } }, properties: { p: { $ref: '#/$defs/a', description: 'a name' } } },
    profile: noRefs,
    fitted: { properties: { p: { type: 'string', description: 'a name' } } },
    changes: [
      { path: '/properties/p/$ref', rule: 'no-ref', narrowing: false },
      { path: '/$defs', rule: 'no-defs', narrowing: false },
    ],
  },
  {
    name: 'a reference pointing outside the schema becomes a schema that accepts nothing',
    schema: { properties: { p: { $ref: 'https://example.com/s.json' } } },
    profile: permissive,
    fitted: { properties: { p: NOTHING } },
    changes: [{ path: '/properties/p/$ref', rule: 'external-ref', narrowing: true }],
  },
  {
    name: 'a reference pointing nowhere becomes a schema that accepts nothing',
    schema: { properties: { p: { $ref: '#/$defs/missing' } } },
    profile: permissive,
    fitted: { properties: { p: NOTHING } },
    changes: [{ path: '/properties/p/$ref', rule: 'unresolvable-ref', narrowing: true }],
  },

  // --- rule 3: object root ------------------------------------------------
  {
    name: 'the empty schema becomes an object',
    schema: {},
    profile: variant(permissive, { rootMustBeObject: true }),
    fitted: { type: 'object' },
    changes: [{ path: '', rule: 'root-must-be-object', narrowing: true }],
  },
  {
    name: 'true becomes an object',
    schema: true,
    profile: variant(permissive, { rootMustBeObject: true }),
    fitted: { type: 'object' },
    changes: [{ path: '', rule: 'root-must-be-object', narrowing: true }],
  },
  {
    name: 'false stays a schema that accepts nothing',
    schema: false,
    profile: variant(permissive, { rootMustBeObject: true }),
    fitted: NOTHING,
    changes: [{ path: '', rule: 'root-must-be-object', narrowing: false }],
  },
  {
    name: 'a root that accepts no objects accepts nothing once fitted',
    schema: { type: 'string' },
    profile: variant(permissive, { rootMustBeObject: true }),
    fitted: NOTHING,
    changes: [{ path: '', rule: 'root-must-be-object', narrowing: true }],
  },
  {
    name: 'a nullable object root loses the null',
    schema: { type: ['object', 'null'], properties: { a: true } },
    profile: variant(permissive, { rootMustBeObject: true }),
    fitted: { type: 'object', properties: { a: true } },
    changes: [{ path: '', rule: 'root-must-be-object', narrowing: true }],
  },

  // --- rule 4: combinators ------------------------------------------------
  {
    name: 'oneOf becomes anyOf when the options cannot overlap',
    schema: { oneOf: [{ type: 'string' }, { type: 'number' }] },
    profile: variant(permissive, { supports: { oneOf: false } }),
    fitted: { anyOf: [{ type: 'string' }, { type: 'number' }] },
    changes: [{ path: '/oneOf', rule: 'no-oneof', narrowing: false }],
  },
  {
    name: 'oneOf becomes anyOf for a discriminated union',
    schema: {
      oneOf: [
        { type: 'object', properties: { kind: { const: 'a' } }, required: ['kind'] },
        { type: 'object', properties: { kind: { const: 'b' } }, required: ['kind'] },
      ],
    },
    profile: variant(permissive, { supports: { oneOf: false } }),
    fitted: {
      anyOf: [
        { type: 'object', properties: { kind: { const: 'a' } }, required: ['kind'] },
        { type: 'object', properties: { kind: { const: 'b' } }, required: ['kind'] },
      ],
    },
    changes: [{ path: '/oneOf', rule: 'no-oneof', narrowing: false }],
  },
  {
    name: 'overlapping oneOf options are rewritten exactly when not is available',
    schema: { oneOf: [{ minimum: 1 }, { maximum: 5 }] },
    profile: variant(permissive, { supports: { oneOf: false } }),
    fitted: {
      anyOf: [
        { allOf: [{ minimum: 1 }, { not: { maximum: 5 } }] },
        { allOf: [{ maximum: 5 }, { not: { minimum: 1 } }] },
      ],
    },
    changes: [{ path: '/oneOf', rule: 'no-oneof', narrowing: false }],
  },
  {
    // Keeping either option would accept values matching both, which "oneOf"
    // rejects. There is no sound way to keep one, so nothing is kept.
    name: 'overlapping oneOf options accept nothing when there is no safe substitute',
    schema: { type: 'object', additionalProperties: false, oneOf: [{ minimum: 1 }, { maximum: 5 }] },
    profile: openaiStrict,
    fitted: NOTHING,
    changes: [{ path: '/oneOf', rule: 'no-oneof', narrowing: true }],
  },
  {
    name: 'a oneOf option that cannot overlap the others is kept on its own',
    schema: { oneOf: [{ type: 'string' }, { type: 'number' }] },
    profile: variant(permissive, { supports: { oneOf: false, anyOf: false, allOf: false, not: false } }),
    fitted: { type: 'string' },
    changes: [{ path: '/oneOf', rule: 'no-oneof', narrowing: true }],
  },
  {
    // Inside a "not", making the negated schema stricter makes the whole schema
    // looser, so the rewrite is refused and the owner accepts nothing instead.
    name: 'a rewrite that cannot be made inside a not takes the whole schema down with it',
    schema: { type: 'object', properties: { a: { not: { enum: ['x', 'y'] } } } },
    profile: variant(permissive, { supports: { enum: false, const: false } }),
    fitted: { type: 'object', properties: { a: NOTHING } },
    changes: [{ path: '/properties/a', rule: 'no-enum', narrowing: true }],
  },
  {
    name: 'an exact rewrite inside a not is made as usual',
    schema: { type: 'object', properties: { a: { not: { const: 'x' } } } },
    profile: variant(permissive, { supports: { const: false } }),
    fitted: { type: 'object', properties: { a: { not: { enum: ['x'] } } } },
    changes: [{ path: '/properties/a/not/const', rule: 'no-const', narrowing: false }],
  },
  {
    name: 'a single oneOf option folds in without loss',
    schema: { oneOf: [{ minimum: 1 }] },
    profile: variant(permissive, { supports: { oneOf: false, anyOf: false, allOf: false, not: false } }),
    fitted: { minimum: 1 },
    changes: [{ path: '/oneOf', rule: 'no-oneof', narrowing: false }],
  },
  {
    name: 'anyOf collapses to its first option',
    schema: { anyOf: [{ type: 'string' }, { type: 'number' }] },
    profile: variant(permissive, { supports: { anyOf: false } }),
    fitted: { type: 'string' },
    changes: [{ path: '/anyOf', rule: 'no-anyof', narrowing: true }],
  },
  {
    name: 'allOf is merged into one schema',
    schema: { allOf: [{ type: 'string', minLength: 1 }, { maxLength: 5 }] },
    profile: variant(permissive, { supports: { allOf: false } }),
    fitted: { type: 'string', minLength: 1, maxLength: 5 },
    changes: [{ path: '/allOf', rule: 'no-allof', narrowing: false }],
  },
  {
    // Merging the outer allOf pulls the inner one up to the same node, so the
    // node has to be worked over more than once.
    name: 'an allOf nested inside an allOf is merged all the way down',
    schema: { allOf: [{ allOf: [{ type: 'string', minLength: 1 }] }, { maxLength: 4 }] },
    profile: variant(permissive, { supports: { allOf: false } }),
    fitted: { type: 'string', minLength: 1, maxLength: 4 },
    changes: [
      { path: '/allOf', rule: 'no-allof', narrowing: false },
      { path: '/allOf', rule: 'no-allof', narrowing: false },
    ],
  },
  {
    name: 'an unmergeable allOf accepts nothing rather than too much',
    schema: { allOf: [{ pattern: '^a' }, { pattern: '^b' }] },
    profile: variant(permissive, { supports: { allOf: false } }),
    fitted: NOTHING,
    changes: [{ path: '/allOf', rule: 'no-allof', narrowing: true }],
  },
  {
    name: 'not over a type is turned into the types it left',
    schema: { not: { type: 'string' } },
    profile: variant(permissive, { supports: { not: false } }),
    fitted: { type: ['null', 'boolean', 'object', 'array', 'number'] },
    changes: [{ path: '/not', rule: 'no-not', narrowing: false }],
  },
  {
    // Ruling out whole numbers leaves the fractions, which no type describes,
    // so numbers go entirely rather than let the integers back in.
    name: 'not over integers gives up numbers altogether',
    schema: { not: { type: ['integer', 'null'] } },
    profile: variant(permissive, { supports: { not: false } }),
    fitted: { type: ['boolean', 'object', 'array', 'string'] },
    changes: [{ path: '/not', rule: 'no-not', narrowing: true }],
  },
  {
    name: 'not over numbers rules out the integers too',
    schema: { type: ['integer', 'string'], not: { type: 'number' } },
    profile: variant(permissive, { supports: { not: false } }),
    fitted: { type: 'string' },
    changes: [{ path: '/not', rule: 'no-not', narrowing: false }],
  },
  {
    name: 'not over a value is turned into the values it left',
    schema: { enum: [1, 2, 3], not: { const: 2 } },
    profile: variant(permissive, { supports: { not: false } }),
    fitted: { enum: [1, 3] },
    changes: [{ path: '/not', rule: 'no-not', narrowing: false }],
  },
  {
    name: 'not over nothing is dropped',
    schema: { type: 'string', not: false },
    profile: variant(permissive, { supports: { not: false } }),
    fitted: { type: 'string' },
    changes: [{ path: '/not', rule: 'no-not', narrowing: false }],
  },
  {
    name: 'a not nobody can rewrite accepts nothing',
    schema: { not: { properties: { a: { type: 'string' } } } },
    profile: variant(permissive, { supports: { not: false } }),
    fitted: NOTHING,
    changes: [{ path: '/not', rule: 'no-not', narrowing: true }],
  },

  // --- rule 5: unsupported constraints ------------------------------------
  {
    name: 'a one-value enum becomes a const',
    schema: { enum: ['a'] },
    profile: variant(permissive, { supports: { enum: false } }),
    fitted: { const: 'a' },
    changes: [{ path: '/enum', rule: 'no-enum', narrowing: false }],
  },
  {
    name: 'a longer enum accepts nothing rather than everything',
    schema: { enum: ['a', 'b'] },
    profile: variant(permissive, { supports: { enum: false } }),
    fitted: NOTHING,
    changes: [{ path: '/enum', rule: 'no-enum', narrowing: true }],
  },
  {
    name: 'a const becomes a one-value enum',
    schema: { type: 'object', additionalProperties: false, const: {} },
    profile: openaiStrict,
    fitted: { type: 'object', additionalProperties: false, enum: [{}] },
    changes: [{ path: '/const', rule: 'no-const', narrowing: false }],
  },
  {
    name: 'patternProperties folds into the properties it applied to',
    schema: { type: 'object', properties: { ab: { type: 'string' } }, patternProperties: { '^a': { minLength: 2 } } },
    profile: variant(permissive, { supports: { patternProperties: false } }),
    fitted: {
      type: 'object',
      properties: { ab: { type: 'string', minLength: 2 } },
      additionalProperties: false,
    },
    changes: [{ path: '/patternProperties', rule: 'no-pattern-properties', narrowing: true }],
  },
  {
    name: 'tuple items collapse to one item schema',
    schema: { type: 'array', prefixItems: [{ type: 'string', minLength: 1 }, { type: 'string' }] },
    profile: gemini,
    fitted: { type: 'array', items: { type: 'string', minLength: 1 } },
    changes: [{ path: '/prefixItems', rule: 'no-tuple-items', narrowing: true }],
  },
  {
    name: 'additionalItems is dropped as the no-op it is in 2020-12',
    schema: { type: 'array', items: { type: 'string' }, additionalItems: { type: 'number' } },
    profile: gemini,
    fitted: { type: 'array', items: { type: 'string' } },
    changes: [{ path: '/additionalItems', rule: 'no-additional-items', narrowing: false }],
  },
  {
    name: 'an unhonoured format is dropped',
    schema: { type: 'object', additionalProperties: false, format: 'uri' },
    profile: openaiStrict,
    fitted: { type: 'object', additionalProperties: false },
    changes: [{ path: '/format', rule: 'no-format', narrowing: false }],
  },
  {
    name: 'unhonoured bounds are dropped',
    schema: { minimum: 1, maxLength: 2, uniqueItems: true, default: 3 },
    profile: noBounds,
    fitted: {},
    changes: [
      { path: '/minimum', rule: 'no-numeric-bounds', narrowing: false },
      { path: '/maxLength', rule: 'no-string-bounds', narrowing: false },
      { path: '/uniqueItems', rule: 'no-array-bounds', narrowing: false },
      { path: '/default', rule: 'no-defaults', narrowing: false },
    ],
  },

  // --- rule 6: additionalProperties --------------------------------------
  {
    name: 'an open object is closed',
    schema: { type: 'object' },
    profile: openaiStrict,
    fitted: { type: 'object', additionalProperties: false },
    changes: [{ path: '/additionalProperties', rule: 'additional-properties-must-be-false', narrowing: true }],
  },

  // --- rule 7: required ---------------------------------------------------
  {
    name: 'optional properties become required',
    schema: { type: 'object', additionalProperties: false, properties: { a: true, b: true }, required: ['a'] },
    profile: openaiStrict,
    fitted: { type: 'object', additionalProperties: false, properties: { a: true, b: true }, required: ['a', 'b'] },
    changes: [{ path: '/properties/b', rule: 'property-must-be-required', narrowing: true }],
  },

  // --- rule 8: property count --------------------------------------------
  {
    name: 'properties past the limit are dropped, required ones first to survive',
    schema: { type: 'object', properties: { a: true, b: true, c: true }, required: ['c'] },
    profile: narrow,
    fitted: { type: 'object', properties: { a: true, c: true }, required: ['c'], additionalProperties: false },
    changes: [{ path: '/properties', rule: 'max-properties', narrowing: true }],
  },

  // --- rule 9: nesting ----------------------------------------------------
  {
    name: 'nesting at the limit is left alone',
    schema: { properties: { a: { properties: { b: { type: 'string' } } } } },
    profile: shallow,
    fitted: { properties: { a: { properties: { b: { type: 'string' } } } } },
    changes: [],
  },
  {
    name: 'nesting past the limit accepts nothing rather than something else',
    schema: { properties: { a: { properties: { b: { properties: { c: { type: 'string' } } } } } } },
    profile: shallow,
    fitted: { properties: { a: { properties: { b: NOTHING } } } },
    changes: [{ path: '/properties/a/properties/b', rule: 'max-depth', narrowing: true }],
  },

  // --- rule 10: nullability ----------------------------------------------
  {
    name: 'a list of types collapses to one type',
    schema: { type: ['string', 'null'] },
    profile: gemini,
    fitted: { type: 'string' },
    changes: [{ path: '/type', rule: 'no-nullable-via-type', narrowing: true }],
  },
  {
    name: 'a one-item list of types is just written out',
    schema: { type: ['string'] },
    profile: gemini,
    fitted: { type: 'string' },
    changes: [{ path: '/type', rule: 'no-nullable-via-type', narrowing: false }],
  },
];

describe('fit', () => {
  for (const row of rows) {
    it(row.name, () => {
      const result = fit(row.schema, row.profile);
      expect(result.schema).toEqual(row.fitted);
      expect(result.changes.map(({ path, rule, narrowing }) => ({ path, rule, narrowing }))).toEqual(row.changes);
      expect(result.lossless).toBe(row.changes.every((change) => !change.narrowing));
      expect(check(result.schema, row.profile).ok).toBe(true);
    });
  }

  it('every message is one plain sentence', () => {
    const seen: Change[] = [];
    for (const row of rows) seen.push(...fit(row.schema, row.profile).changes);
    expect(seen.length).toBeGreaterThan(30);
    for (const change of seen) {
      expect(change.message.length).toBeGreaterThan(10);
      expect(change.message.endsWith('.')).toBe(true);
    }
  });

  describe('schemas that already conform', () => {
    const conforming: Array<[string, JSONSchema, Profile]> = [
      [
        'openai',
        {
          type: 'object',
          properties: { a: { type: 'string' }, b: { type: ['integer', 'null'] } },
          required: ['a', 'b'],
          additionalProperties: false,
        },
        openaiStrict,
      ],
      ['anthropic', { type: 'object', properties: { a: { type: 'string', default: 'x' } }, oneOf: [true, true] }, anthropic],
      ['gemini', { type: 'array', items: { type: 'string', enum: ['a', 'b'] }, minItems: 1 }, gemini],
    ];

    for (const [name, schema, profile] of conforming) {
      it(`${name}: handed back untouched`, () => {
        const result = fit(schema, profile);
        expect(result.changes).toEqual([]);
        expect(result.lossless).toBe(true);
        expect(result.schema).toBe(schema);
      });
    }
  });

  describe('recursive references', () => {
    const recursive = {
      $defs: { node: { type: 'object', properties: { next: { $ref: '#/$defs/node' } } } },
      type: 'object',
      properties: { root: { $ref: '#/$defs/node' } },
    };

    it('throws when the profile forbids references', () => {
      expect(() => fit(recursive, noRefs)).toThrow(UnfittableSchemaError);
      try {
        fit(recursive, noRefs);
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(UnfittableSchemaError);
        expect((error as UnfittableSchemaError).path).toBe('/$defs/node/properties/next/$ref');
        expect((error as UnfittableSchemaError).name).toBe('UnfittableSchemaError');
      }
    });

    it('is fine when the profile allows references', () => {
      const result = fit(recursive, openaiStrict);
      expect(check(result.schema, openaiStrict).ok).toBe(true);
      expect(result.lossless).toBe(false);
    });

    it('throws for a schema that references itself directly', () => {
      expect(() => fit({ $ref: '#' }, noRefs)).toThrow(UnfittableSchemaError);
    });
  });

  describe('rules can be run one at a time', () => {
    const schema = {
      type: 'string',
      'x-vendor': 1,
      properties: { a: { type: 'string' } },
    };

    it('runs only the pass it is asked for', () => {
      const only = fitInternal(schema, openaiStrict, { rules: ['strip-unknown'] });
      expect(only.changes.map((change) => change.rule)).toEqual(['unknown-keyword']);
      expect(only.schema).toEqual({ type: 'string', properties: { a: { type: 'string' } } });
    });

    it('every pass is reachable on its own', () => {
      const seen = new Set<string>();
      const cases: Array<[PassId, JSONSchema, Profile]> = [
        ['strip-unknown', { 'x-a': 1 }, openaiStrict],
        ['refs', { $defs: { a: true }, $ref: '#/$defs/a' }, noRefs],
        ['root-object', { type: 'string' }, openaiStrict],
        ['combinators', { oneOf: [{ minimum: 1 }, { maximum: 2 }] }, openaiStrict],
        ['constraints', { format: 'uri' }, openaiStrict],
        ['additional-properties', { type: 'object' }, openaiStrict],
        ['required', { properties: { a: true } }, openaiStrict],
        ['max-properties', { properties: { a: true, b: true, c: true } }, narrow],
        ['max-depth', { properties: { a: { properties: { b: { properties: { c: { type: 'string' } } } } } } }, shallow],
        ['nullability', { type: ['string', 'null'] }, gemini],
      ];
      for (const [pass, input, profile] of cases) {
        const result = fitInternal(input, profile, { rules: [pass] });
        expect(result.changes.length, `pass ${pass} produced no change`).toBeGreaterThan(0);
        seen.add(pass);
      }
      expect([...seen].sort()).toEqual([...PASSES].sort());
    });

    it('runs no pass at all when asked for none', () => {
      const result = fitInternal(schema, openaiStrict, { rules: [] });
      expect(result.changes).toEqual([]);
      expect(result.schema).toBe(schema);
    });
  });

  it('does not touch the schema it is given', () => {
    const schema = deepFreeze({
      type: 'string',
      'x-vendor': 1,
      properties: { a: { type: 'string', format: 'uri' } },
      oneOf: [{ minimum: 1 }, { maximum: 2 }],
    });
    expect(() => fit(schema, openaiStrict)).not.toThrow();
    expect(schema).toEqual({
      type: 'string',
      'x-vendor': 1,
      properties: { a: { type: 'string', format: 'uri' } },
      oneOf: [{ minimum: 1 }, { maximum: 2 }],
    });
  });
});

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}
