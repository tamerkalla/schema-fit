import type { JSONSchema, JSONSchemaObject } from './types.js';
import { acceptsEverything, clone, deepEqual, isSchema, isSchemaObject, typeList } from './keywords.js';

/**
 * A schema that accepts nothing at all, written with the plainest keywords
 * available so that every profile still accepts the shape of it.
 *
 * It is the safe answer whenever a rewrite cannot be expressed: a schema that
 * accepts nothing is a subset of every schema, so substituting it can never
 * break the soundness guarantee. It always costs something, which is why every
 * change that produces one is recorded as narrowing.
 */
export const UNSATISFIABLE_KEY = '__schema_fit_unsatisfiable__';

export function unsatisfiable(): JSONSchemaObject {
  return {
    type: 'object',
    properties: {},
    additionalProperties: false,
    required: [UNSATISFIABLE_KEY],
  };
}

export function isUnsatisfiable(schema: JSONSchema): boolean {
  if (schema === false) return true;
  return (
    isSchemaObject(schema) &&
    Array.isArray(schema['required']) &&
    schema['required'].length === 1 &&
    schema['required'][0] === UNSATISFIABLE_KEY &&
    schema['additionalProperties'] === false &&
    isSchemaObject(schema['properties']) &&
    Object.keys(schema['properties']).length === 0
  );
}

export interface MergeResult {
  /** Always sound: it never accepts anything the inputs did not both accept. */
  schema: JSONSchema;
  /** True when the result is exactly the intersection, losing nothing. */
  exact: boolean;
}

/** Signals a conflict at this level that cannot be written as a single schema. */
class Inexact extends Error {}

/**
 * The largest schema that both inputs accept — or, where that cannot be written
 * as one schema, something smaller. Never something larger.
 */
export function intersect(a: JSONSchema, b: JSONSchema): MergeResult {
  const state = { exact: true };
  try {
    const schema = merge(a, b, state);
    return { schema, exact: state.exact };
  } catch (error) {
    if (error instanceof Inexact) return { schema: unsatisfiable(), exact: false };
    throw error;
  }
}

export function intersectAll(schemas: JSONSchema[]): MergeResult {
  if (schemas.length === 0) return { schema: true, exact: true };
  let exact = true;
  let accumulator: JSONSchema = schemas[0] as JSONSchema;
  for (let index = 1; index < schemas.length; index++) {
    const result = intersect(accumulator, schemas[index] as JSONSchema);
    accumulator = result.schema;
    exact &&= result.exact;
  }
  return { schema: accumulator, exact };
}

interface State {
  exact: boolean;
}

function merge(a: JSONSchema, b: JSONSchema, state: State): JSONSchema {
  if (a === false || b === false) return unsatisfiable();
  if (isUnsatisfiable(a) || isUnsatisfiable(b)) return unsatisfiable();
  if (a === true || acceptsEverything(a)) return clone(b);
  if (b === true || acceptsEverything(b)) return clone(a);
  if (!isSchemaObject(a) || !isSchemaObject(b)) return unsatisfiable();
  if (deepEqual(a, b)) return clone(a);

  const out: JSONSchemaObject = {};

  mergeType(a, b, out);
  mergeValues(a, b, out);
  mergeNumeric(a, b, out);
  mergeString(a, b, out);
  mergeArrayKeywords(a, b, out, state);
  mergeObjectKeywords(a, b, out, state);
  mergeApplicators(a, b, out);
  mergeRemaining(a, b, out);

  if (out['type'] === undefined && Object.keys(out).length === 0) return true;
  return out;
}

/** Child intersections never throw: they degrade to "accepts nothing" instead. */
function mergeChild(a: JSONSchema, b: JSONSchema, state: State): JSONSchema {
  const result = intersect(a, b);
  if (!result.exact) state.exact = false;
  return result.schema;
}

function bothPresent(a: JSONSchemaObject, b: JSONSchemaObject, keyword: string): boolean {
  return a[keyword] !== undefined && b[keyword] !== undefined;
}

function carry(a: JSONSchemaObject, b: JSONSchemaObject, out: JSONSchemaObject, keyword: string): void {
  if (a[keyword] !== undefined) out[keyword] = clone(a[keyword]);
  else if (b[keyword] !== undefined) out[keyword] = clone(b[keyword]);
}

function mergeType(a: JSONSchemaObject, b: JSONSchemaObject, out: JSONSchemaObject): void {
  const ta = typeList(a);
  const tb = typeList(b);
  if (!ta && !tb) return;
  if (!ta) {
    out['type'] = clone(b['type']);
    return;
  }
  if (!tb) {
    out['type'] = clone(a['type']);
    return;
  }
  const merged: string[] = [];
  const add = (type: string): void => {
    if (!merged.includes(type)) merged.push(type);
  };
  for (const type of ta) {
    // `number` on one side and `integer` on the other intersects to `integer`.
    if (tb.includes(type)) add(type);
    else if (type === 'integer' && tb.includes('number')) add('integer');
    else if (type === 'number' && tb.includes('integer')) add('integer');
  }
  if (merged.length === 0) throw new Inexact();
  out['type'] = merged.length === 1 ? (merged[0] as string) : merged;
}

function allowedValues(schema: JSONSchemaObject): unknown[] | undefined {
  if (schema['const'] !== undefined) return [schema['const']];
  if (Array.isArray(schema['enum'])) return schema['enum'];
  return undefined;
}

function mergeValues(a: JSONSchemaObject, b: JSONSchemaObject, out: JSONSchemaObject): void {
  const va = allowedValues(a);
  const vb = allowedValues(b);
  if (!va && !vb) return;
  if (!va || !vb) {
    const source = va ? a : b;
    carry(source, source, out, 'const');
    carry(source, source, out, 'enum');
    return;
  }
  const kept = va.filter((value) => vb.some((other) => deepEqual(value, other)));
  if (kept.length === 0) throw new Inexact();
  if (kept.length === 1 && a['const'] !== undefined && b['const'] !== undefined) {
    out['const'] = clone(kept[0]);
  } else {
    out['enum'] = clone(kept);
  }
}

function mergeNumeric(a: JSONSchemaObject, b: JSONSchemaObject, out: JSONSchemaObject): void {
  tightest(a, b, out, 'minimum', Math.max);
  tightest(a, b, out, 'exclusiveMinimum', Math.max);
  tightest(a, b, out, 'maximum', Math.min);
  tightest(a, b, out, 'exclusiveMaximum', Math.min);

  const ma = a['multipleOf'];
  const mb = b['multipleOf'];
  if (typeof ma === 'number' && typeof mb === 'number') {
    if (ma === mb) out['multipleOf'] = ma;
    else if (ma % mb === 0) out['multipleOf'] = ma;
    else if (mb % ma === 0) out['multipleOf'] = mb;
    else throw new Inexact();
  } else {
    carry(a, b, out, 'multipleOf');
  }
}

function mergeString(a: JSONSchemaObject, b: JSONSchemaObject, out: JSONSchemaObject): void {
  tightest(a, b, out, 'minLength', Math.max);
  tightest(a, b, out, 'maxLength', Math.min);

  if (bothPresent(a, b, 'pattern')) {
    if (a['pattern'] === b['pattern']) out['pattern'] = a['pattern'];
    else throw new Inexact();
  } else {
    carry(a, b, out, 'pattern');
  }

  // `format` is an annotation in draft 2020-12, so keeping one of two is safe.
  carry(a, b, out, 'format');
}

function tightest(
  a: JSONSchemaObject,
  b: JSONSchemaObject,
  out: JSONSchemaObject,
  keyword: string,
  pick: (x: number, y: number) => number,
): void {
  const va = a[keyword];
  const vb = b[keyword];
  if (typeof va === 'number' && typeof vb === 'number') out[keyword] = pick(va, vb);
  else carry(a, b, out, keyword);
}

export interface ArrayShape {
  prefix: JSONSchema[];
  rest: JSONSchema;
  hasTuple: boolean;
}

/**
 * `additionalItems` is deliberately ignored: draft 2020-12 dropped it, so it
 * constrains nothing and folding it in here would make the merge narrower than
 * the true intersection while still claiming to be exact.
 */
export function arrayShape(schema: JSONSchemaObject): ArrayShape {
  const items = schema['items'];
  if (Array.isArray(schema['prefixItems'])) {
    return {
      prefix: schema['prefixItems'].filter(isSchema),
      rest: isSchema(items) ? items : true,
      hasTuple: true,
    };
  }
  if (Array.isArray(items)) {
    return { prefix: items.filter(isSchema), rest: true, hasTuple: true };
  }
  return { prefix: [], rest: isSchema(items) ? items : true, hasTuple: false };
}

function mergeArrayKeywords(a: JSONSchemaObject, b: JSONSchemaObject, out: JSONSchemaObject, state: State): void {
  tightest(a, b, out, 'minItems', Math.max);
  tightest(a, b, out, 'maxItems', Math.min);

  if (a['uniqueItems'] === true || b['uniqueItems'] === true) out['uniqueItems'] = true;
  else carry(a, b, out, 'uniqueItems');

  if (bothPresent(a, b, 'contains')) throw new Inexact();
  carry(a, b, out, 'contains');
  carry(a, b, out, 'minContains');
  carry(a, b, out, 'maxContains');

  const sa = arrayShape(a);
  const sb = arrayShape(b);
  if (!sa.hasTuple && !sb.hasTuple) {
    if (sa.rest !== true || sb.rest !== true) {
      const rest = mergeChild(sa.rest, sb.rest, state);
      if (rest !== true) out['items'] = rest;
    }
    return;
  }

  const length = Math.max(sa.prefix.length, sb.prefix.length);
  const prefix: JSONSchema[] = [];
  for (let index = 0; index < length; index++) {
    prefix.push(mergeChild(sa.prefix[index] ?? sa.rest, sb.prefix[index] ?? sb.rest, state));
  }
  const rest = mergeChild(sa.rest, sb.rest, state);
  out['prefixItems'] = prefix;
  if (rest !== true) out['items'] = rest;
}

function patternSchemasFor(schema: JSONSchemaObject, key: string): JSONSchema[] {
  const patternProperties = schema['patternProperties'];
  if (!isSchemaObject(patternProperties)) return [];
  const matches: JSONSchema[] = [];
  for (const pattern of Object.keys(patternProperties)) {
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, 'u');
    } catch {
      throw new Inexact();
    }
    if (regex.test(key)) {
      const value = patternProperties[pattern];
      if (isSchema(value)) matches.push(value);
    }
  }
  return matches;
}

/** What one side applies to a property name it does not declare outright. */
function fallbackFor(schema: JSONSchemaObject, key: string): JSONSchema {
  // A key matched by patternProperties is governed by that keyword, which we
  // carry across untouched, so nothing extra applies to it here.
  if (patternSchemasFor(schema, key).length > 0) return true;
  const additional = schema['additionalProperties'];
  return isSchema(additional) ? additional : true;
}

function mergeObjectKeywords(a: JSONSchemaObject, b: JSONSchemaObject, out: JSONSchemaObject, state: State): void {
  tightest(a, b, out, 'minProperties', Math.max);
  tightest(a, b, out, 'maxProperties', Math.min);

  const propsA = isSchemaObject(a['properties']) ? a['properties'] : undefined;
  const propsB = isSchemaObject(b['properties']) ? b['properties'] : undefined;

  if (propsA || propsB) {
    const names: string[] = [];
    for (const name of Object.keys(propsA ?? {})) names.push(name);
    for (const name of Object.keys(propsB ?? {})) if (!names.includes(name)) names.push(name);

    const merged: Record<string, JSONSchema> = {};
    for (const name of names) {
      const fromA = propsA && isSchema(propsA[name]) ? (propsA[name] as JSONSchema) : fallbackFor(a, name);
      const fromB = propsB && isSchema(propsB[name]) ? (propsB[name] as JSONSchema) : fallbackFor(b, name);
      merged[name] = mergeChild(fromA, fromB, state);
    }
    out['properties'] = merged;
  }

  const ppA = isSchemaObject(a['patternProperties']) ? a['patternProperties'] : undefined;
  const ppB = isSchemaObject(b['patternProperties']) ? b['patternProperties'] : undefined;
  if (ppA || ppB) {
    const mergedPatterns: Record<string, JSONSchema> = {};
    for (const pattern of Object.keys(ppA ?? {})) {
      const value = (ppA as JSONSchemaObject)[pattern];
      if (isSchema(value)) mergedPatterns[pattern] = clone(value);
    }
    for (const pattern of Object.keys(ppB ?? {})) {
      const value = (ppB as JSONSchemaObject)[pattern];
      if (!isSchema(value)) continue;
      const existing = mergedPatterns[pattern];
      mergedPatterns[pattern] = existing === undefined ? clone(value) : mergeChild(existing, value, state);
    }
    out['patternProperties'] = mergedPatterns;
  }

  const apA = a['additionalProperties'];
  const apB = b['additionalProperties'];
  if (apA !== undefined || apB !== undefined) {
    // `false` is the plainest way to say "and nothing else", and every provider
    // accepts it in this position, so it survives merging as itself.
    if (apA === false || apB === false) {
      out['additionalProperties'] = false;
    } else {
      const merged = mergeChild(isSchema(apA) ? apA : true, isSchema(apB) ? apB : true, state);
      if (merged !== true) out['additionalProperties'] = merged;
    }
  }

  const requiredA = Array.isArray(a['required']) ? a['required'] : [];
  const requiredB = Array.isArray(b['required']) ? b['required'] : [];
  if (requiredA.length > 0 || requiredB.length > 0) {
    const required = [...requiredA];
    for (const name of requiredB) if (!required.includes(name)) required.push(name);
    out['required'] = required;
  }

  if (bothPresent(a, b, 'propertyNames')) {
    out['propertyNames'] = mergeChild(a['propertyNames'] as JSONSchema, b['propertyNames'] as JSONSchema, state);
  } else {
    carry(a, b, out, 'propertyNames');
  }

  const depA = isSchemaObject(a['dependentSchemas']) ? a['dependentSchemas'] : undefined;
  const depB = isSchemaObject(b['dependentSchemas']) ? b['dependentSchemas'] : undefined;
  if (depA || depB) {
    const merged: Record<string, JSONSchema> = {};
    for (const key of Object.keys(depA ?? {})) {
      const value = (depA as JSONSchemaObject)[key];
      if (isSchema(value)) merged[key] = clone(value);
    }
    for (const key of Object.keys(depB ?? {})) {
      const value = (depB as JSONSchemaObject)[key];
      if (!isSchema(value)) continue;
      const existing = merged[key];
      merged[key] = existing === undefined ? clone(value) : mergeChild(existing, value, state);
    }
    out['dependentSchemas'] = merged;
  }

  const drA = isSchemaObject(a['dependentRequired']) ? a['dependentRequired'] : undefined;
  const drB = isSchemaObject(b['dependentRequired']) ? b['dependentRequired'] : undefined;
  if (drA || drB) {
    const merged: Record<string, string[]> = {};
    for (const source of [drA, drB]) {
      if (!source) continue;
      for (const key of Object.keys(source)) {
        const value = source[key];
        if (!Array.isArray(value)) continue;
        const existing = merged[key] ?? [];
        for (const name of value) if (!existing.includes(name)) existing.push(name);
        merged[key] = existing;
      }
    }
    out['dependentRequired'] = merged;
  }
}

function mergeApplicators(a: JSONSchemaObject, b: JSONSchemaObject, out: JSONSchemaObject): void {
  if (a['$ref'] !== undefined || b['$ref'] !== undefined) throw new Inexact();
  if (a['unevaluatedProperties'] !== undefined || b['unevaluatedProperties'] !== undefined) throw new Inexact();
  if (a['unevaluatedItems'] !== undefined || b['unevaluatedItems'] !== undefined) throw new Inexact();
  if (a['$dynamicRef'] !== undefined || b['$dynamicRef'] !== undefined) throw new Inexact();

  const allOfA = Array.isArray(a['allOf']) ? a['allOf'].filter(isSchema) : [];
  const allOfB = Array.isArray(b['allOf']) ? b['allOf'].filter(isSchema) : [];
  if (allOfA.length > 0 || allOfB.length > 0) out['allOf'] = clone([...allOfA, ...allOfB]);

  for (const keyword of ['anyOf', 'oneOf', 'not', 'if']) {
    if (bothPresent(a, b, keyword)) throw new Inexact();
  }
  carry(a, b, out, 'anyOf');
  carry(a, b, out, 'oneOf');
  carry(a, b, out, 'not');
  if (a['if'] !== undefined || b['if'] !== undefined) {
    const source = a['if'] !== undefined ? a : b;
    carry(source, source, out, 'if');
    carry(source, source, out, 'then');
    carry(source, source, out, 'else');
  }
}

const MERGED_ELSEWHERE = new Set<string>([
  'type',
  'const',
  'enum',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'pattern',
  'format',
  'minItems',
  'maxItems',
  'uniqueItems',
  'contains',
  'minContains',
  'maxContains',
  'items',
  'prefixItems',
  'minProperties',
  'maxProperties',
  'properties',
  'patternProperties',
  'additionalProperties',
  'required',
  'propertyNames',
  'dependentSchemas',
  'dependentRequired',
  'allOf',
  'anyOf',
  'oneOf',
  'not',
  'if',
  'then',
  'else',
]);

/** Everything left over is metadata: keep it, preferring the first schema's. */
function mergeRemaining(a: JSONSchemaObject, b: JSONSchemaObject, out: JSONSchemaObject): void {
  for (const source of [a, b]) {
    for (const keyword of Object.keys(source)) {
      if (MERGED_ELSEWHERE.has(keyword)) continue;
      if (out[keyword] !== undefined) continue;
      out[keyword] = clone(source[keyword]);
    }
  }
}
