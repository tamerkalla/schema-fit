import { describe, expect, it } from 'vitest';
import { check } from '../src/check.js';
import { fit } from '../src/fit.js';
import type { JSONSchema, Profile } from '../src/types.js';
import { profiles } from '../src/profiles.js';
import { permissive, variant } from './profiles.js';

/**
 * Making a subschema stricter usually makes the whole schema stricter. Under
 * `not` it does the opposite, and inside `oneOf` and `if` it does neither
 * reliably. These are the cases where `fit` has to refuse a rewrite it would
 * happily make anywhere else — including when a `$ref` is what carries a
 * definition into one of those positions.
 */

const NOTHING = {
  type: 'object',
  properties: {},
  additionalProperties: false,
  required: ['__schema_fit_unsatisfiable__'],
};

/** Supports `not` and references, but demands closed objects: a narrowing rewrite. */
const strictButExpressive: Profile = variant(permissive, {
  id: 'strict-but-expressive',
  additionalPropertiesMustBeFalse: true,
});

describe('positions where a rewrite would run the wrong way', () => {
  it('closes an object in an ordinary position', () => {
    const result = fit({ type: 'object', properties: { a: { type: 'string' } } }, strictButExpressive);
    expect(result.schema).toEqual({
      type: 'object',
      properties: { a: { type: 'string' } },
      additionalProperties: false,
    });
    expect(result.changes.map((change) => change.rule)).toEqual(['additional-properties-must-be-false']);
  });

  it('refuses to close an object inside a not, and takes the not with it', () => {
    const result = fit({ not: { type: 'object', properties: { a: { type: 'string' } } } }, strictButExpressive);
    expect(result.schema).toEqual(NOTHING);
    expect(result.changes).toEqual([
      {
        path: '',
        rule: 'additional-properties-must-be-false',
        message: expect.stringContaining('accepts nothing'),
        narrowing: true,
      },
    ]);
  });

  it('rolls back the changes recorded inside the subtree it threw away', () => {
    const result = fit(
      { not: { type: 'object', properties: { a: { type: 'object', properties: { b: true } } } } },
      strictButExpressive,
    );
    // One change for the whole thing, not one per object it never got to close.
    expect(result.changes).toHaveLength(1);
    expect(result.schema).toEqual(NOTHING);
  });

  it('refuses a narrowing rewrite inside a oneOf option', () => {
    const schema = {
      oneOf: [
        { type: 'object', properties: { a: { type: 'string' } } },
        { type: 'object', properties: { b: { type: 'string' } } },
      ],
    };
    const result = fit(schema, strictButExpressive);
    expect(result.schema).toEqual(NOTHING);
    expect(result.lossless).toBe(false);
  });

  it('refuses a narrowing rewrite inside an if', () => {
    const result = fit({ if: { type: 'object', properties: { a: true } }, then: true }, strictButExpressive);
    expect(result.schema).toEqual(NOTHING);
  });

  it('makes the rewrite in then and else, which are ordinary positions', () => {
    const result = fit({ if: true, then: { type: 'object', properties: { a: true } } }, strictButExpressive);
    expect(result.schema).toEqual({
      if: true,
      then: { type: 'object', properties: { a: true }, additionalProperties: false },
    });
  });

  it('refuses to cut a subtree past the nesting limit inside a not', () => {
    const shallow = variant(permissive, { id: 'shallow', maxDepth: 2 });
    const schema = { not: { properties: { a: { properties: { b: { properties: { c: { type: 'string' } } } } } } } };
    const result = fit(schema, shallow);
    expect(result.schema).toEqual(NOTHING);
    expect(result.changes.map((change) => change.rule)).toEqual(['max-depth']);
  });

  it('refuses to trim properties past the limit inside a not', () => {
    const narrow = variant(permissive, { id: 'narrow', maxProperties: 2 });
    const result = fit({ not: { properties: { a: true, b: true, c: true } } }, narrow);
    expect(result.schema).toEqual(NOTHING);
    expect(result.changes.map((change) => change.rule)).toEqual(['max-properties']);
  });

  it('refuses to collapse a list of types inside a not', () => {
    const single = variant(permissive, { id: 'single-type', supports: { nullableViaType: false } });
    const result = fit({ not: { type: ['string', 'null'] } }, single);
    expect(result.schema).toEqual(NOTHING);
    expect(result.changes.map((change) => change.rule)).toEqual(['no-nullable-via-type']);
  });

  it('allows a rewrite that loosens a negated schema, and reports it as the narrowing it is', () => {
    // Dropping a limit widens the schema it sits in. Inside a `not`, that makes
    // the schema around it stricter — sound, but a loss worth reporting.
    const ignoresBounds = variant(permissive, { id: 'ignores-bounds', supports: { numericBounds: false } });
    const result = fit({ not: { minimum: 5 } }, ignoresBounds);
    expect(result.schema).toEqual({ not: {} });
    expect(result.changes).toEqual([
      {
        path: '/not/minimum',
        rule: 'no-numeric-bounds',
        message: expect.stringContaining('minimum'),
        narrowing: true,
      },
    ]);
    expect(result.lossless).toBe(false);
  });

  it('reports the same rewrite in an ordinary position as no loss at all', () => {
    const ignoresBounds = variant(permissive, { id: 'ignores-bounds', supports: { numericBounds: false } });
    const result = fit({ minimum: 5 }, ignoresBounds);
    expect(result.schema).toEqual({});
    expect(result.changes.map((change) => change.narrowing)).toEqual([false]);
    expect(result.lossless).toBe(true);
  });

  it('makes an exact rewrite inside a not, where direction does not matter', () => {
    const result = fit(
      { not: { const: 'x' } },
      variant(strictButExpressive, { supports: { const: false } }),
    );
    expect(result.schema).toEqual({ not: { enum: ['x'] } });
    expect(result.lossless).toBe(true);
  });

  it('two nots cancel out, so the rewrite is allowed again', () => {
    const result = fit({ not: { not: { type: 'object', properties: { a: true } } } }, strictButExpressive);
    expect(result.schema).toEqual({
      not: { not: { type: 'object', properties: { a: true }, additionalProperties: false } },
    });
    expect(result.changes.map((change) => change.rule)).toEqual(['additional-properties-must-be-false']);
  });
});

describe('definitions take the position of whatever references them', () => {
  const definition = { type: 'object', properties: { a: { type: 'string' } } };

  it('rewrites a definition every reference reaches in an ordinary position', () => {
    const schema = {
      $defs: { shared: definition },
      type: 'object',
      properties: { p: { $ref: '#/$defs/shared' } },
    };
    const result = fit(schema, strictButExpressive);
    expect(result.schema).toEqual({
      $defs: {
        shared: { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false },
      },
      type: 'object',
      properties: { p: { $ref: '#/$defs/shared' } },
      additionalProperties: false,
    });
    expect(check(result.schema, strictButExpressive).ok).toBe(true);
  });

  it('rewrites the definition and gives up on the reference that negated it', () => {
    const schema = {
      $defs: { shared: definition },
      type: 'object',
      properties: { p: { not: { $ref: '#/$defs/shared' } } },
    };
    const result = fit(schema, strictButExpressive);
    // The definition is closed like any other object; what could not stand is
    // the one reference that reached it through a `not`, so that goes instead.
    expect(result.schema).toEqual({
      $defs: {
        shared: { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false },
      },
      type: 'object',
      properties: { p: NOTHING },
      additionalProperties: false,
    });
    expect(result.changes.map((change) => [change.path, change.rule])).toEqual([
      ['/$defs/shared/additionalProperties', 'additional-properties-must-be-false'],
      ['/properties/p', 'ref-in-flipped-position'],
      ['/additionalProperties', 'additional-properties-must-be-false'],
    ]);
    expect(check(result.schema, strictButExpressive).ok).toBe(true);
  });

  it('keeps the references that stand in an ordinary position', () => {
    const schema = {
      $defs: { shared: definition },
      type: 'object',
      properties: { p: { $ref: '#/$defs/shared' }, q: { not: { $ref: '#/$defs/shared' } } },
    };
    const result = fit(schema, strictButExpressive);
    const properties = (result.schema as Record<string, Record<string, JSONSchema>>)['properties'] as Record<string, JSONSchema>;
    expect(properties['p']).toEqual({ $ref: '#/$defs/shared' });
    expect(properties['q']).toEqual(NOTHING);
    expect(check(result.schema, strictButExpressive).ok).toBe(true);
  });

  it('follows a reference through another definition', () => {
    const schema = {
      $defs: {
        inner: definition,
        outer: { not: { $ref: '#/$defs/inner' } },
      },
      type: 'object',
      properties: { p: { $ref: '#/$defs/outer' } },
    };
    const result = fit(schema, strictButExpressive);
    const defs = (result.schema as Record<string, Record<string, JSONSchema>>)['$defs'] as Record<string, JSONSchema>;
    // `inner` is rewritten, and `outer`, which is the schema that negated it,
    // is what gives way.
    expect(defs['inner']).toEqual({
      type: 'object',
      properties: { a: { type: 'string' } },
      additionalProperties: false,
    });
    expect(defs['outer']).toEqual(NOTHING);
    expect(check(result.schema, strictButExpressive).ok).toBe(true);
  });

  it('gives up on a reference that points inside a troubled definition', () => {
    const schema = {
      $defs: { shared: { type: 'object', properties: { a: definition } } },
      type: 'object',
      properties: { p: { not: { $ref: '#/$defs/shared/properties/a' } } },
    };
    const result = fit(schema, strictButExpressive);
    const properties = (result.schema as Record<string, Record<string, JSONSchema>>)['properties'] as Record<string, JSONSchema>;
    expect(properties['p']).toEqual(NOTHING);
    expect(check(result.schema, strictButExpressive).ok).toBe(true);
  });

  it('needs no second run when every definition stands where it is used', () => {
    const schema = {
      $defs: { shared: definition },
      type: 'object',
      properties: { p: { $ref: '#/$defs/shared' } },
      additionalProperties: false,
    };
    const result = fit(schema, strictButExpressive);
    // One change, from the one object that was open — no sign of a second run.
    expect(result.changes.map((change) => change.path)).toEqual(['/$defs/shared/additionalProperties']);
  });

  it('rewrites a definition nothing references at all', () => {
    const schema = { $defs: { unused: definition }, type: 'object', properties: {} };
    const result = fit(schema, strictButExpressive);
    const defs = (result.schema as Record<string, Record<string, JSONSchema>>)['$defs'] as Record<string, JSONSchema>;
    expect(defs['unused']).toEqual({
      type: 'object',
      properties: { a: { type: 'string' } },
      additionalProperties: false,
    });
  });
});

describe('properties nothing can satisfy', () => {
  const strict = profiles.openaiStrict;

  it('drops a self-referential optional property rather than requiring it', () => {
    const schema = {
      $defs: { N: { type: 'object', properties: { next: { $ref: '#/$defs/N' } } } },
      type: 'object',
      properties: { n: { $ref: '#/$defs/N' } },
    };
    const result = fit(schema, strict);
    // Requiring `next` would leave a schema no finite instance satisfies, so it
    // goes; the reference to the definition itself is fine to require.
    expect(result.schema).toEqual({
      $defs: { N: { type: 'object', properties: {}, additionalProperties: false, required: [] } },
      type: 'object',
      properties: { n: { $ref: '#/$defs/N' } },
      additionalProperties: false,
      required: ['n'],
    });
    expect(result.changes.map((change) => [change.path, change.rule])).toEqual([
      ['/$defs/N/additionalProperties', 'additional-properties-must-be-false'],
      ['/additionalProperties', 'additional-properties-must-be-false'],
      ['/$defs/N/properties/next', 'unreachable-property'],
      ['/properties/n', 'property-must-be-required'],
    ]);
    expect(check(result.schema, strict).ok).toBe(true);
  });

  it('keeps recursion that ends in an empty array', () => {
    const schema = {
      $defs: {
        Node: {
          type: 'object',
          properties: { children: { type: 'array', items: { $ref: '#/$defs/Node' } } },
        },
      },
      type: 'object',
      properties: { root: { $ref: '#/$defs/Node' } },
    };
    const result = fit(schema, strict);
    const defs = (result.schema as Record<string, Record<string, JSONSchema>>)['$defs'] as Record<string, JSONSchema>;
    // An empty array ends the recursion, so requiring `children` costs nothing
    // it could not already have.
    expect((defs['Node'] as Record<string, unknown>)['required']).toEqual(['children']);
    expect((defs['Node'] as Record<string, unknown>)['properties']).toEqual({
      children: { type: 'array', items: { $ref: '#/$defs/Node' } },
    });
    expect(check(result.schema, strict).ok).toBe(true);
  });

  it('drops a property another rule left accepting nothing', () => {
    const schema = {
      type: 'object',
      properties: { a: { type: 'string' }, b: { oneOf: [{ minimum: 1 }, { maximum: 5 }] } },
      required: ['a'],
    };
    const result = fit(schema, strict);
    const properties = (result.schema as Record<string, Record<string, JSONSchema>>)['properties'] ?? {};
    expect(Object.keys(properties)).toEqual(['a']);
    expect((result.schema as Record<string, unknown>)['required']).toEqual(['a']);
    expect(check(result.schema, strict).ok).toBe(true);
  });

  it('keeps a required property that accepts nothing, because dropping it would widen', () => {
    const schema = {
      type: 'object',
      properties: { b: { oneOf: [{ minimum: 1 }, { maximum: 5 }] } },
      required: ['b'],
    };
    const result = fit(schema, strict);
    const properties = (result.schema as Record<string, Record<string, JSONSchema>>)['properties'] ?? {};
    // The original demands `b`, so an object without it is one the original
    // rejects. The schema accepts nothing, and that is the sound answer.
    expect(Object.keys(properties)).toEqual(['b']);
    expect(check(result.schema, strict).ok).toBe(true);
  });

  it('settles mutual recursion by dropping one side', () => {
    const schema = {
      $defs: {
        A: { type: 'object', properties: { b: { $ref: '#/$defs/B' } } },
        B: { type: 'object', properties: { a: { $ref: '#/$defs/A' } } },
      },
      type: 'object',
      properties: { start: { $ref: '#/$defs/A' } },
    };
    const result = fit(schema, strict);
    expect(check(result.schema, strict).ok).toBe(true);
    const defs = (result.schema as Record<string, Record<string, JSONSchema>>)['$defs'] as Record<string, Record<string, unknown>>;
    const count = (name: string) => Object.keys((defs[name]?.['properties'] ?? {}) as object).length;
    const kept = count('A') + count('B');
    expect(kept).toBe(1);
  });
});
