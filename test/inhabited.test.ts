import { describe, expect, it } from 'vitest';
import { inhabited, unreachableProperties } from '../src/inhabited.js';
import { unsatisfiable } from '../src/intersect.js';
import type { JSONSchema } from '../src/types.js';

/**
 * The question here is "could anything satisfy this, once every property it
 * declares is required?" — which is what a profile demanding all-required
 * raises and cannot answer for itself. Wrong in the "yes" direction is free;
 * wrong in the "no" direction drops a property that did not need dropping, so
 * every case that is not modelled has to come out "yes".
 */

const none = new Set<string>();
const ask = (schema: JSONSchema, document: JSONSchema = schema, dropped = none) =>
  inhabited(schema, document, dropped, '');

describe('inhabited', () => {
  it('reads the boolean schemas', () => {
    expect(ask(true)).toBe(true);
    expect(ask(false)).toBe(false);
    expect(ask({})).toBe(true);
  });

  it('knows the schema that accepts nothing', () => {
    expect(ask(unsatisfiable())).toBe(false);
  });

  it('says yes to anything that can be a scalar', () => {
    expect(ask({ type: 'string' })).toBe(true);
    expect(ask({ type: 'null' })).toBe(true);
    expect(ask({ type: ['object', 'null'] })).toBe(true);
    expect(ask({ minLength: 3 })).toBe(true);
  });

  it('follows a reference to what it points at', () => {
    const document = { $defs: { s: { type: 'string' }, nothing: false } };
    expect(ask({ $ref: '#/$defs/s' }, document)).toBe(true);
    expect(ask({ $ref: '#/$defs/nothing' }, document)).toBe(false);
  });

  it('assumes yes for a reference it cannot follow', () => {
    expect(ask({ $ref: 'https://example.com/s.json' }, {})).toBe(true);
    expect(ask({ $ref: '#/$defs/missing' }, { $defs: {} })).toBe(true);
  });

  it('says no to an object that requires its way back to itself', () => {
    const document = {
      $defs: { N: { type: 'object', properties: { next: { $ref: '#/$defs/N' } } } },
    };
    expect(ask({ $ref: '#/$defs/N' }, document)).toBe(false);
  });

  it('says no through mutual recursion too', () => {
    const document = {
      $defs: {
        A: { type: 'object', properties: { b: { $ref: '#/$defs/B' } } },
        B: { type: 'object', properties: { a: { $ref: '#/$defs/A' } } },
      },
    };
    expect(ask({ $ref: '#/$defs/A' }, document)).toBe(false);
  });

  it('says yes when the recursion ends in an empty array', () => {
    const document = {
      $defs: {
        N: { type: 'object', properties: { kids: { type: 'array', items: { $ref: '#/$defs/N' } } } },
      },
    };
    expect(ask({ $ref: '#/$defs/N' }, document)).toBe(true);
  });

  it('says no when the array is obliged to hold something unreachable', () => {
    const document = {
      $defs: {
        N: {
          type: 'object',
          properties: { kids: { type: 'array', minItems: 1, items: { $ref: '#/$defs/N' } } },
        },
      },
    };
    expect(ask({ $ref: '#/$defs/N' }, document)).toBe(false);
  });

  it('treats contains as an obligation to hold something', () => {
    expect(ask({ type: 'array', contains: { type: 'string' }, items: false })).toBe(false);
    expect(ask({ type: 'array', items: false })).toBe(true);
    expect(ask({ type: 'array', minItems: 1, items: { type: 'string' } })).toBe(true);
    expect(ask({ type: 'array', minItems: 1 })).toBe(true);
  });

  it('needs every declared property of an object to be reachable', () => {
    expect(ask({ type: 'object', properties: { a: { type: 'string' } } })).toBe(true);
    expect(ask({ type: 'object', properties: { a: false } })).toBe(false);
    expect(ask({ type: 'object' })).toBe(true);
    expect(ask({ type: 'object', properties: {} })).toBe(true);
  });

  it('ignores a property already dropped', () => {
    const schema = { type: 'object', properties: { a: false } };
    expect(ask(schema, schema, new Set(['/properties/a']))).toBe(true);
  });
});

describe('unreachableProperties', () => {
  it('finds nothing to drop in a schema that needs no help', () => {
    expect([...unreachableProperties({ type: 'object', properties: { a: { type: 'string' } } })]).toEqual([]);
    expect([...unreachableProperties(true)]).toEqual([]);
  });

  it('drops the self-reference, and nothing else', () => {
    const schema = {
      $defs: { N: { type: 'object', properties: { next: { $ref: '#/$defs/N' } } } },
      type: 'object',
      properties: { n: { $ref: '#/$defs/N' } },
    };
    // Once `next` is gone the definition is satisfiable, so the reference to it
    // needs no dropping of its own.
    expect([...unreachableProperties(schema)]).toEqual(['/$defs/N/properties/next']);
  });

  it('leaves a property the schema already required', () => {
    const schema = {
      $defs: { N: { type: 'object', properties: { next: { $ref: '#/$defs/N' } }, required: ['next'] } },
      type: 'object',
      properties: { n: { $ref: '#/$defs/N' } },
      required: ['n'],
    };
    // The original demands both, so an instance without them is one it rejects.
    // Nothing here can be dropped, and the schema accepts nothing either way.
    expect([...unreachableProperties(schema)]).toEqual([]);
  });

  it('drops one side of a mutual recursion', () => {
    const schema = {
      $defs: {
        A: { type: 'object', properties: { b: { $ref: '#/$defs/B' } } },
        B: { type: 'object', properties: { a: { $ref: '#/$defs/A' } } },
      },
      type: 'object',
      properties: { start: { $ref: '#/$defs/A' } },
    };
    expect([...unreachableProperties(schema)]).toHaveLength(1);
  });

  it('leaves recursion that ends in an empty array alone', () => {
    const schema = {
      $defs: {
        N: { type: 'object', properties: { kids: { type: 'array', items: { $ref: '#/$defs/N' } } } },
      },
      type: 'object',
      properties: { n: { $ref: '#/$defs/N' } },
    };
    expect([...unreachableProperties(schema)]).toEqual([]);
  });

  it('drops a property another rewrite left accepting nothing', () => {
    expect([...unreachableProperties({ type: 'object', properties: { a: false, b: { type: 'string' } } })]).toEqual([
      '/properties/a',
    ]);
  });

  it('looks inside combinators and item schemas', () => {
    const schema = {
      anyOf: [{ type: 'object', properties: { a: false } }],
      items: { type: 'object', properties: { b: false } },
    };
    expect([...unreachableProperties(schema)].sort()).toEqual(['/anyOf/0/properties/a', '/items/properties/b']);
  });

  it('takes the deepest offender first', () => {
    const schema = {
      type: 'object',
      properties: {
        outer: { type: 'object', properties: { inner: false } },
      },
    };
    // Dropping `inner` makes `outer` satisfiable, so only one drop is needed.
    expect([...unreachableProperties(schema)]).toEqual(['/properties/outer/properties/inner']);
  });
});

describe('unreachableProperties, in detail', () => {
  it('takes offenders at the same depth in name order', () => {
    const schema = { type: 'object', properties: { b: false, a: false, c: { type: 'string' } } };
    // Each round drops one, so the order this comes back in is the order they
    // were chosen: same depth, so by name.
    expect([...unreachableProperties(schema)]).toEqual(['/properties/a', '/properties/b']);
  });

  it('prefers the deeper offender when depths differ', () => {
    const schema = {
      type: 'object',
      properties: {
        z: { type: 'object', properties: { deep: false } },
        a: false,
      },
    };
    const dropped = [...unreachableProperties(schema)];
    expect(dropped[0]).toBe('/properties/z/properties/deep');
    expect(dropped).toContain('/properties/a');
  });

  it('steps over entries that are not schemas at all', () => {
    const schema = { type: 'object', properties: { a: 'nonsense', b: false } };
    expect([...unreachableProperties(schema)]).toEqual(['/properties/b']);
  });

  it('steps over a properties keyword that is not a map', () => {
    expect([...unreachableProperties({ type: 'object', properties: 'nonsense' })]).toEqual([]);
  });
});
