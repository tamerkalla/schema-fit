import { describe, expect, it } from 'vitest';
import { check } from '../src/check.js';
import { fit } from '../src/fit.js';
import type { JSONSchema, Profile } from '../src/types.js';
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
