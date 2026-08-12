import type { JSONSchema, JSONSchemaObject } from './types.js';
import { NESTING_KEYWORDS, SCHEMA_ARRAY_KEYWORDS, SCHEMA_KEYWORDS, SCHEMA_MAP_KEYWORDS, isSchema, isSchemaObject } from './keywords.js';
import { join } from './pointer.js';

/**
 * `nesting` is true when the child sits one instance level deeper than its
 * parent — `properties/a` does, `anyOf/0` does not.
 */
export type Rewriter = (schema: JSONSchema, path: string, nesting: boolean, keyword: string) => JSONSchema;

/**
 * Rebuild a schema with each direct subschema passed through `visit`, keeping
 * keyword order. Returns the input untouched when nothing changed, so an
 * unchanged schema stays reference-identical all the way up.
 */
export function mapChildren(schema: JSONSchemaObject, path: string, visit: Rewriter): JSONSchemaObject {
  const out: JSONSchemaObject = {};
  let changed = false;

  for (const keyword of Object.keys(schema)) {
    const value = schema[keyword];
    const nesting = NESTING_KEYWORDS.has(keyword);

    if ((SCHEMA_KEYWORDS as readonly string[]).includes(keyword) && isSchema(value)) {
      const next = visit(value, join(path, keyword), nesting, keyword);
      if (next !== value) changed = true;
      out[keyword] = next;
      continue;
    }

    const isArrayPosition =
      (SCHEMA_ARRAY_KEYWORDS as readonly string[]).includes(keyword) || (keyword === 'items' && Array.isArray(value));
    if (isArrayPosition && Array.isArray(value)) {
      const mapped = value.map((entry, index) =>
        isSchema(entry) ? visit(entry, join(path, keyword, index), keyword === 'items' ? true : nesting, keyword) : entry,
      );
      if (mapped.some((entry, index) => entry !== value[index])) changed = true;
      out[keyword] = mapped;
      continue;
    }

    if ((SCHEMA_MAP_KEYWORDS as readonly string[]).includes(keyword) && isSchemaObject(value)) {
      const mapped: JSONSchemaObject = {};
      let mapChanged = false;
      for (const name of Object.keys(value)) {
        const entry = value[name];
        if (isSchema(entry)) {
          const next = visit(entry, join(path, keyword, name), nesting, keyword);
          if (next !== entry) mapChanged = true;
          mapped[name] = next;
        } else {
          mapped[name] = entry;
        }
      }
      if (mapChanged) changed = true;
      out[keyword] = mapped;
      continue;
    }

    out[keyword] = value;
  }

  return changed ? out : schema;
}

/** A copy with `keyword` removed, keeping the order of everything else. */
export function without(schema: JSONSchemaObject, ...keywords: string[]): JSONSchemaObject {
  const out: JSONSchemaObject = {};
  for (const key of Object.keys(schema)) {
    if (!keywords.includes(key)) out[key] = schema[key];
  }
  return out;
}

/**
 * A copy with `keyword` set, keeping its position if it was already there and
 * otherwise adding it where `position` says.
 */
export function withKeyword(
  schema: JSONSchemaObject,
  keyword: string,
  value: unknown,
  position: 'first' | 'last' = 'last',
): JSONSchemaObject {
  const out: JSONSchemaObject = {};
  const isNew = schema[keyword] === undefined;
  if (isNew && position === 'first') out[keyword] = value;
  for (const key of Object.keys(schema)) {
    out[key] = key === keyword ? value : schema[key];
  }
  if (isNew && position === 'last') out[keyword] = value;
  return out;
}

/** A copy with `from` renamed to `to`, keeping its position. */
export function renameKeyword(schema: JSONSchemaObject, from: string, to: string): JSONSchemaObject {
  const out: JSONSchemaObject = {};
  for (const key of Object.keys(schema)) {
    if (key === from) out[to] = schema[key];
    else out[key] = schema[key];
  }
  return out;
}
