import fc from 'fast-check';
import type { JSONSchema, JSONSchemaObject } from '../src/types.js';

/**
 * A generator for valid draft 2020-12 schemas, covering every keyword a Profile
 * can talk about. The properties are only as good as this, so it comes first.
 */

const key = fc.constantFrom('a', 'b', 'c', 'ab', 'id', 'name');
const format = fc.constantFrom('date-time', 'email', 'uuid', 'uri', 'ipv4', 'duration', 'date');
const pattern = fc.constantFrom('^a', '^b.*', '[0-9]+', '.');
const value = fc.oneof(
  fc.string({ maxLength: 4 }),
  fc.integer({ min: -5, max: 5 }),
  fc.boolean(),
  fc.constant(null),
);

const bounds = (max: number) =>
  fc
    .tuple(fc.integer({ min: 0, max }), fc.integer({ min: 0, max }))
    .map(([x, y]) => ({ low: Math.min(x, y), high: Math.max(x, y) }));

const stringSchema = fc
  .record(
    {
      minLength: fc.integer({ min: 0, max: 3 }),
      maxLength: fc.integer({ min: 3, max: 6 }),
      pattern,
      format,
    },
    { requiredKeys: [] },
  )
  .map((extras) => ({ type: 'string', ...extras }) as JSONSchemaObject);

const numberSchema = fc
  .tuple(
    fc.constantFrom('number', 'integer'),
    bounds(10),
    fc.option(fc.integer({ min: 1, max: 4 }), { nil: undefined }),
  )
  .chain(([type, span, multipleOf]) =>
    fc.record({ withBounds: fc.boolean() }).map(({ withBounds }) => {
      const schema: JSONSchemaObject = { type };
      if (withBounds) {
        schema['minimum'] = span.low;
        schema['maximum'] = span.high;
      }
      if (multipleOf !== undefined) schema['multipleOf'] = multipleOf;
      return schema;
    }),
  );

const scalarSchema = fc.oneof(
  fc.constant(true as JSONSchema),
  fc.constant(false as JSONSchema),
  fc.constant({} as JSONSchema),
  fc.constant({ type: 'boolean' } as JSONSchema),
  fc.constant({ type: 'null' } as JSONSchema),
  stringSchema,
  numberSchema,
  fc.uniqueArray(value, { minLength: 1, maxLength: 3 }).map((values) => ({ enum: values }) as JSONSchema),
  value.map((only) => ({ const: only }) as JSONSchema),
  fc
    .constantFrom('string', 'integer', 'boolean')
    .map((type) => ({ type: [type, 'null'] }) as JSONSchema),
);

function objectSchema(inner: fc.Arbitrary<JSONSchema>): fc.Arbitrary<JSONSchema> {
  return fc
    .tuple(
      fc.uniqueArray(fc.tuple(key, inner), { minLength: 1, maxLength: 3, selector: ([name]) => name }),
      fc.boolean(),
      fc.oneof(fc.constant(undefined), fc.constant(false as JSONSchema), inner),
      fc.boolean(),
    )
    .map(([entries, requireAll, additional, withDefault]) => {
      const properties: JSONSchemaObject = {};
      for (const [name, schema] of entries) properties[name] = schema;
      const out: JSONSchemaObject = { type: 'object', properties };
      const names = entries.map(([name]) => name);
      out['required'] = requireAll ? names : names.slice(0, 1);
      if (additional !== undefined) out['additionalProperties'] = additional;
      if (withDefault) out['default'] = {};
      return out;
    });
}

function patternPropertiesSchema(inner: fc.Arbitrary<JSONSchema>): fc.Arbitrary<JSONSchema> {
  return fc.tuple(pattern, inner, fc.option(fc.tuple(key, inner), { nil: undefined })).map(([p, schema, declared]) => {
    const out: JSONSchemaObject = { type: 'object', patternProperties: { [p]: schema } };
    if (declared) out['properties'] = { [declared[0]]: declared[1] };
    return out;
  });
}

function arraySchema(inner: fc.Arbitrary<JSONSchema>): fc.Arbitrary<JSONSchema> {
  return fc.tuple(inner, bounds(4), fc.boolean()).map(([items, span, unique]) => {
    const out: JSONSchemaObject = { type: 'array', items, minItems: span.low, maxItems: span.high };
    if (unique) out['uniqueItems'] = true;
    return out;
  });
}

function tupleSchema(inner: fc.Arbitrary<JSONSchema>): fc.Arbitrary<JSONSchema> {
  return fc
    .tuple(fc.array(inner, { minLength: 1, maxLength: 2 }), fc.option(inner, { nil: undefined }), fc.boolean())
    .map(([prefixItems, rest, legacy]) => {
      const out: JSONSchemaObject = { type: 'array', prefixItems };
      if (rest !== undefined) out['items'] = rest;
      if (legacy) out['additionalItems'] = { type: 'string' };
      return out;
    });
}

function combinatorSchema(inner: fc.Arbitrary<JSONSchema>): fc.Arbitrary<JSONSchema> {
  return fc
    .tuple(fc.constantFrom('oneOf', 'anyOf', 'allOf'), fc.array(inner, { minLength: 1, maxLength: 3 }))
    .map(([keyword, branches]) => ({ [keyword]: branches }) as JSONSchema);
}

function notSchema(inner: fc.Arbitrary<JSONSchema>): fc.Arbitrary<JSONSchema> {
  return inner.map((schema) => ({ not: schema }) as JSONSchema);
}

/** `if` is the other position where a stricter subschema is not a stricter whole. */
function conditionalSchema(inner: fc.Arbitrary<JSONSchema>): fc.Arbitrary<JSONSchema> {
  return fc.tuple(inner, inner, fc.option(inner, { nil: undefined })).map(([condition, then, otherwise]) => {
    const out: JSONSchemaObject = { if: condition, then };
    if (otherwise !== undefined) out['else'] = otherwise;
    return out;
  });
}

function annotated(inner: fc.Arbitrary<JSONSchema>): fc.Arbitrary<JSONSchema> {
  return fc.tuple(inner, fc.string({ maxLength: 5 })).map(([schema, note]) =>
    typeof schema === 'boolean' ? schema : ({ ...schema, title: note, 'x-vendor': note } as JSONSchema),
  );
}

function schemaAt(depth: number): fc.Arbitrary<JSONSchema> {
  if (depth <= 0) return scalarSchema;
  const inner = fc.oneof({ depthSize: 'small' }, scalarSchema, schemaAt(depth - 1));
  return fc.oneof(
    { arbitrary: scalarSchema, weight: 3 },
    { arbitrary: objectSchema(inner), weight: 3 },
    { arbitrary: arraySchema(inner), weight: 2 },
    { arbitrary: tupleSchema(inner), weight: 1 },
    { arbitrary: patternPropertiesSchema(inner), weight: 1 },
    { arbitrary: combinatorSchema(inner), weight: 2 },
    { arbitrary: notSchema(scalarSchema), weight: 1 },
    { arbitrary: conditionalSchema(scalarSchema), weight: 1 },
    { arbitrary: annotated(inner), weight: 1 },
  );
}

/** A schema with a `$defs` section and references into it, none of them cyclic. */
function referencing(inner: fc.Arbitrary<JSONSchema>): fc.Arbitrary<JSONSchema> {
  const siblings = fc.constantFrom<JSONSchemaObject>(
    {},
    { description: 'a note' },
    { minLength: 1 },
    { type: 'string' },
  );
  return fc
    .tuple(inner, inner, siblings, fc.boolean())
    .map(([definition, other, sibling, negated]) => ({
      $defs: { shared: definition },
      type: 'object',
      properties: {
        p: { $ref: '#/$defs/shared', ...sibling },
        // A reference reached through a `not` puts the definition itself in a
        // position where narrowing it would widen the schema.
        q: negated ? { not: { $ref: '#/$defs/shared' } } : { $ref: '#/$defs/shared' },
        r: other,
      },
      required: ['p'],
    }));
}

export function schemaArbitrary(depth = 3): fc.Arbitrary<JSONSchema> {
  return fc.oneof({ arbitrary: schemaAt(depth), weight: 6 }, { arbitrary: referencing(schemaAt(depth - 1)), weight: 1 });
}

/** Arbitrary JSON, for throwing at schemas that were never meant to see it. */
export const instanceArbitrary: fc.Arbitrary<unknown> = fc.oneof(
  value,
  fc.array(value, { maxLength: 3 }),
  fc.dictionary(key, value, { maxKeys: 3 }),
  fc.dictionary(key, fc.oneof(value, fc.array(value, { maxLength: 2 })), { maxKeys: 3 }),
);
