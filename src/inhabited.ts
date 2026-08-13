import type { JSONSchema, JSONSchemaObject } from './types.js';
import { isSchema, isSchemaObject, typeList } from './keywords.js';
import { isUnsatisfiable } from './intersect.js';
import { join, resolve } from './pointer.js';

/**
 * Which optional properties a profile's "every property must be required" rule
 * cannot require, because nothing would satisfy them.
 *
 * A self-referential object is the case that matters. Require `next` at every
 * level of `{"next": {"$ref": "#"}}` and no finite instance is left: the
 * fitted schema accepts nothing, which is sound and useless. The property was
 * optional, so dropping it keeps a schema that still accepts what it can.
 *
 * Dropping one property can make others reachable again — once `next` is gone,
 * the object it sits in is satisfiable, and so is every reference to it — so
 * this settles by dropping the innermost offender and asking again. Innermost
 * first is what keeps the loss small: the outer references then need no
 * dropping at all.
 */
export function unreachableProperties(document: JSONSchema): ReadonlySet<string> {
  const dropped = new Set<string>();
  // Each round drops one property, so a schema with n properties settles in at
  // most n rounds. The cap is only there to make termination obvious.
  for (let round = 0; round < 500; round++) {
    const next = innermostUnreachable(document, dropped);
    if (next === undefined) break;
    dropped.add(next);
  }
  return dropped;
}

/**
 * Can any instance satisfy this schema, once every property it declares — bar
 * the ones already dropped — is required?
 *
 * The answer is the least fixed point: a reference that comes back round to
 * itself contributes nothing, which is what makes a recursive object bottom out
 * at "no". Recursion through an array comes out "yes", since the empty array
 * ends it — which is why providers that demand all-required still document
 * recursive schemas that work.
 *
 * Every case this does not model answers "yes". Being wrong in that direction
 * costs nothing: a property is only ever dropped on a definite "no".
 */
export function inhabited(
  schema: JSONSchema,
  document: JSONSchema,
  dropped: ReadonlySet<string>,
  path: string,
  stack: string[] = [],
): boolean {
  if (schema === true) return true;
  if (schema === false) return false;
  if (!isSchemaObject(schema)) return true;
  if (isUnsatisfiable(schema)) return false;

  const ref = schema['$ref'];
  if (typeof ref === 'string') {
    if (!ref.startsWith('#')) return true;
    // A reference already being followed adds nothing: an instance built from
    // it would have to be infinitely deep.
    if (stack.includes(ref)) return false;
    const target = resolve(document, ref.slice(1));
    if (!isSchema(target)) return true;
    return inhabited(target, document, dropped, ref.slice(1), [...stack, ref]);
  }

  const types = typeList(schema);
  const mayBeObject = !types || types.includes('object');
  const mayBeArray = !types || types.includes('array');
  const mayBeScalar = !types || types.some((type) => type !== 'object' && type !== 'array');

  if (mayBeScalar) return true;
  if (mayBeArray && arrayInhabited(schema, document, dropped, path, stack)) return true;
  if (mayBeObject && objectInhabited(schema, document, dropped, path, stack)) return true;
  return false;
}

function arrayInhabited(
  schema: JSONSchemaObject,
  document: JSONSchema,
  dropped: ReadonlySet<string>,
  path: string,
  stack: string[],
): boolean {
  const minItems = typeof schema['minItems'] === 'number' ? schema['minItems'] : 0;
  // The empty array ends the recursion, so an array only needs an inhabited
  // item schema when it is obliged to hold something.
  if (minItems <= 0 && schema['contains'] === undefined) return true;
  const items = schema['items'];
  if (!isSchema(items)) return true;
  return inhabited(items, document, dropped, join(path, 'items'), stack);
}

function objectInhabited(
  schema: JSONSchemaObject,
  document: JSONSchema,
  dropped: ReadonlySet<string>,
  path: string,
  stack: string[],
): boolean {
  const properties = schema['properties'];
  if (!isSchemaObject(properties)) return true;
  // Every declared property is about to be required, so every one that survives
  // has to be reachable for the object to be.
  for (const name of Object.keys(properties)) {
    const property = properties[name];
    if (!isSchema(property)) continue;
    const at = join(path, 'properties', name);
    if (dropped.has(at)) continue;
    if (!inhabited(property, document, dropped, at, stack)) return false;
  }
  return true;
}

/** The deepest optional property nothing can satisfy, or `undefined` if none. */
function innermostUnreachable(document: JSONSchema, dropped: ReadonlySet<string>): string | undefined {
  const candidates: string[] = [];
  collect(document, document, dropped, '', candidates);
  if (candidates.length === 0) return undefined;
  // Deepest first, then by name, so the choice does not depend on key order.
  candidates.sort((a, b) => {
    const depth = b.split('/').length - a.split('/').length;
    return depth !== 0 ? depth : a < b ? -1 : a > b ? 1 : 0;
  });
  return candidates[0];
}

function collect(
  node: JSONSchema,
  document: JSONSchema,
  dropped: ReadonlySet<string>,
  path: string,
  out: string[],
): void {
  if (!isSchemaObject(node)) return;

  const properties = node['properties'];
  if (isSchemaObject(properties)) {
    const required = Array.isArray(node['required']) ? node['required'] : [];
    for (const name of Object.keys(properties)) {
      const property = properties[name];
      if (!isSchema(property)) continue;
      const at = join(path, 'properties', name);
      // A property the schema already required cannot be dropped: an object
      // without it is one the original rejects.
      if (required.includes(name) || dropped.has(at)) continue;
      if (!inhabited(property, document, dropped, at)) out.push(at);
    }
  }

  // Anything object-shaped is walked as a schema, which covers the maps too:
  // `$defs` and `properties` look like schemas with odd keyword names, and
  // their entries come out at the right pointers either way.
  for (const [keyword, value] of Object.entries(node)) {
    if (isSchemaObject(value)) collect(value, document, dropped, join(path, keyword), out);
    else if (Array.isArray(value)) {
      value.forEach((entry, index) => {
        if (isSchema(entry)) collect(entry, document, dropped, join(path, keyword, index), out);
      });
    }
  }
}
