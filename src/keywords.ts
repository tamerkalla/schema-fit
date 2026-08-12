import type { JSONSchema, JSONSchemaObject } from './types.js';
import { join } from './pointer.js';

/** Keywords whose value is a single subschema. */
export const SCHEMA_KEYWORDS = [
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
] as const;

/** Keywords whose value is an array of subschemas. */
export const SCHEMA_ARRAY_KEYWORDS = ['allOf', 'anyOf', 'oneOf', 'prefixItems'] as const;

/** Keywords whose value is an object mapping names to subschemas. */
export const SCHEMA_MAP_KEYWORDS = [
  'properties',
  'patternProperties',
  'dependentSchemas',
  '$defs',
  'definitions',
] as const;

/**
 * Subschema positions that describe a *deeper instance*. `properties/a` puts you
 * one level further into the data; `anyOf/0` does not. Provider nesting limits
 * count the former.
 */
export const NESTING_KEYWORDS = new Set<string>([
  'properties',
  'patternProperties',
  'additionalProperties',
  'items',
  'prefixItems',
  'additionalItems',
  'contains',
  'propertyNames',
  'unevaluatedItems',
  'unevaluatedProperties',
]);

/** Every keyword defined by draft 2020-12, plus the two legacy names we tolerate. */
export const KNOWN_KEYWORDS = new Set<string>([
  // core
  '$schema',
  '$id',
  '$ref',
  '$anchor',
  '$dynamicRef',
  '$dynamicAnchor',
  '$vocabulary',
  '$comment',
  '$defs',
  // applicators
  'allOf',
  'anyOf',
  'oneOf',
  'not',
  'if',
  'then',
  'else',
  'dependentSchemas',
  'prefixItems',
  'items',
  'contains',
  'properties',
  'patternProperties',
  'additionalProperties',
  'propertyNames',
  // unevaluated
  'unevaluatedItems',
  'unevaluatedProperties',
  // validation
  'type',
  'enum',
  'const',
  'multipleOf',
  'maximum',
  'exclusiveMaximum',
  'minimum',
  'exclusiveMinimum',
  'maxLength',
  'minLength',
  'pattern',
  'maxItems',
  'minItems',
  'uniqueItems',
  'maxContains',
  'minContains',
  'maxProperties',
  'minProperties',
  'required',
  'dependentRequired',
  // format + content
  'format',
  'contentEncoding',
  'contentMediaType',
  'contentSchema',
  // metadata
  'title',
  'description',
  'default',
  'deprecated',
  'readOnly',
  'writeOnly',
  'examples',
  // tolerated legacy spellings
  'definitions',
  'additionalItems',
]);

/**
 * Keywords that carry no validation weight, so a `$ref` sitting next to them is
 * still effectively a lone `$ref`.
 */
export const ANNOTATION_KEYWORDS = new Set<string>([
  '$schema',
  '$id',
  '$anchor',
  '$comment',
  '$defs',
  'definitions',
  'title',
  'description',
  'deprecated',
  'readOnly',
  'writeOnly',
  'examples',
]);

export function isSchemaObject(schema: unknown): schema is JSONSchemaObject {
  return typeof schema === 'object' && schema !== null && !Array.isArray(schema);
}

export function isSchema(value: unknown): value is JSONSchema {
  return typeof value === 'boolean' || isSchemaObject(value);
}

/** `true` and `{}` both accept every instance. */
export function acceptsEverything(schema: JSONSchema): boolean {
  if (schema === true) return true;
  return isSchemaObject(schema) && Object.keys(schema).every((k) => ANNOTATION_KEYWORDS.has(k));
}

/** The declared `type`, normalised to a list. `undefined` means "any type". */
export function typeList(schema: JSONSchemaObject): string[] | undefined {
  const type = schema['type'];
  if (typeof type === 'string') return [type];
  if (Array.isArray(type)) return type.filter((t): t is string => typeof t === 'string');
  return undefined;
}

/** True when this schema can accept an object instance. */
export function isObjectLike(schema: JSONSchema): boolean {
  if (!isSchemaObject(schema)) return false;
  const types = typeList(schema);
  if (types) return types.includes('object');
  return schema['properties'] !== undefined || schema['patternProperties'] !== undefined;
}

export interface SubschemaSlot {
  schema: JSONSchema;
  path: string;
  /** True when this position is one instance level deeper than its parent. */
  nesting: boolean;
  keyword: string;
}

/** Enumerate the direct subschemas of a schema object, in a stable order. */
export function subschemas(schema: JSONSchemaObject, path: string): SubschemaSlot[] {
  const out: SubschemaSlot[] = [];
  for (const keyword of Object.keys(schema)) {
    const value = schema[keyword];
    if ((SCHEMA_KEYWORDS as readonly string[]).includes(keyword)) {
      if (isSchema(value)) {
        out.push({ schema: value, path: join(path, keyword), nesting: NESTING_KEYWORDS.has(keyword), keyword });
      } else if (Array.isArray(value) && keyword === 'items') {
        // draft-07 tuple spelling; tolerated so we can report on it.
        value.forEach((entry, index) => {
          if (isSchema(entry)) {
            out.push({ schema: entry, path: join(path, keyword, index), nesting: true, keyword });
          }
        });
      }
    } else if ((SCHEMA_ARRAY_KEYWORDS as readonly string[]).includes(keyword)) {
      if (Array.isArray(value)) {
        value.forEach((entry, index) => {
          if (isSchema(entry)) {
            out.push({
              schema: entry,
              path: join(path, keyword, index),
              nesting: NESTING_KEYWORDS.has(keyword),
              keyword,
            });
          }
        });
      }
    } else if ((SCHEMA_MAP_KEYWORDS as readonly string[]).includes(keyword)) {
      if (isSchemaObject(value)) {
        for (const name of Object.keys(value)) {
          const entry = value[name];
          if (isSchema(entry)) {
            out.push({
              schema: entry,
              path: join(path, keyword, name),
              nesting: NESTING_KEYWORDS.has(keyword),
              keyword,
            });
          }
        }
      }
    }
  }
  return out;
}

/** Structural equality for JSON values. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((entry, index) => deepEqual(entry, b[index]));
  }
  if (typeof a === 'object') {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const ak = Object.keys(ao);
    const bk = Object.keys(bo);
    if (ak.length !== bk.length) return false;
    return ak.every((k) => Object.prototype.hasOwnProperty.call(bo, k) && deepEqual(ao[k], bo[k]));
  }
  return false;
}

export function clone<T>(value: T): T {
  if (Array.isArray(value)) return value.map((entry) => clone(entry)) as unknown as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>)) {
      out[key] = clone((value as Record<string, unknown>)[key]);
    }
    return out as unknown as T;
  }
  return value;
}
