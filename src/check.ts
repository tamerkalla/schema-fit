import type { CheckResult, JSONSchema, JSONSchemaObject, Profile, Violation } from './types.js';
import {
  ANNOTATION_KEYWORDS,
  KNOWN_KEYWORDS,
  isObjectLike,
  isSchemaObject,
  subschemas,
} from './keywords.js';
import { join, resolve } from './pointer.js';
import { ARRAY_BOUND_KEYWORDS, NUMERIC_BOUND_KEYWORDS, RULES, STRING_BOUND_KEYWORDS } from './rules.js';

/** True when `$ref` sits next to a keyword that changes what the schema accepts. */
export function hasRefSiblings(schema: JSONSchemaObject): boolean {
  return Object.keys(schema).some((key) => key !== '$ref' && !ANNOTATION_KEYWORDS.has(key));
}

/** True when the profile's root requirement is already met. */
export function isConformingRoot(schema: JSONSchema): boolean {
  return isSchemaObject(schema) && schema['type'] === 'object';
}

export function formatAccepted(profile: Profile, value: string): boolean {
  return profile.supports.formats === 'all' || profile.supports.formats.includes(value);
}

/**
 * Report every place a schema steps outside a profile, without changing anything.
 *
 * Violations are sorted by `path`, then `rule`, so the result is stable across
 * runs and safe to snapshot.
 */
export function check(schema: JSONSchema, profile: Profile): CheckResult {
  const violations: Violation[] = [];
  visit(schema, '', 0, true, schema, profile, violations);
  violations.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0));
  return { ok: violations.length === 0, violations };
}

function report(out: Violation[], path: string, rule: string, message: string): void {
  out.push({ path, rule, message });
}

function visit(
  schema: JSONSchema,
  path: string,
  depth: number,
  isRoot: boolean,
  root: JSONSchema,
  profile: Profile,
  out: Violation[],
): void {
  // A boolean subschema declares no structure, so it never counts as a level.
  if (isSchemaObject(schema) && profile.maxDepth !== null && depth > profile.maxDepth) {
    report(
      out,
      path,
      RULES.maxDepth,
      `This part of the schema sits ${depth} levels deep, and ${profile.id} accepts at most ${profile.maxDepth}.`,
    );
    return;
  }

  if (isRoot && profile.rootMustBeObject && !isConformingRoot(schema)) {
    report(out, path, RULES.rootMustBeObject, `The top level of the schema has to be an object for ${profile.id}.`);
  }

  if (!isSchemaObject(schema)) return;

  checkUnknownKeywords(schema, path, profile, out);
  checkRefs(schema, path, root, profile, out);
  checkCombinators(schema, path, profile, out);
  checkConstraints(schema, path, profile, out);
  checkObjectShape(schema, path, profile, out);

  for (const slot of subschemas(schema, path)) {
    visit(slot.schema, slot.path, depth + (slot.nesting ? 1 : 0), false, root, profile, out);
  }
}

function checkUnknownKeywords(schema: JSONSchemaObject, path: string, profile: Profile, out: Violation[]): void {
  if (profile.unknownKeywords !== 'strip') return;
  for (const keyword of Object.keys(schema)) {
    if (!KNOWN_KEYWORDS.has(keyword)) {
      report(
        out,
        join(path, keyword),
        RULES.unknownKeyword,
        `"${keyword}" is not a JSON Schema keyword, and ${profile.id} rejects keywords it does not know.`,
      );
    }
  }
}

function checkRefs(
  schema: JSONSchemaObject,
  path: string,
  root: JSONSchema,
  profile: Profile,
  out: Violation[],
): void {
  if (profile.refs === 'none') {
    for (const keyword of ['$defs', 'definitions']) {
      if (schema[keyword] !== undefined) {
        report(
          out,
          join(path, keyword),
          RULES.noDefs,
          `${profile.id} does not accept a section of reusable definitions.`,
        );
      }
    }
  }

  const ref = schema['$ref'];
  if (typeof ref !== 'string') return;
  const refPath = join(path, '$ref');

  if (profile.refs === 'none') {
    report(out, refPath, RULES.noRef, `${profile.id} does not accept references, so this one has to be replaced by what it points at.`);
    return;
  }
  if (!ref.startsWith('#')) {
    report(out, refPath, RULES.externalRef, `This reference points outside the schema, and schema-fit never fetches anything.`);
    return;
  }
  if (resolve(root, ref.slice(1)) === undefined) {
    report(out, refPath, RULES.unresolvableRef, `This reference points at "${ref}", which does not exist in this schema.`);
    return;
  }
  if (profile.refs === 'internal-no-siblings' && hasRefSiblings(schema)) {
    report(
      out,
      refPath,
      RULES.refSiblings,
      `${profile.id} ignores the keywords sitting next to this reference, so it has to be replaced by what it points at.`,
    );
  }
}

function checkCombinators(schema: JSONSchemaObject, path: string, profile: Profile, out: Violation[]): void {
  const pairs: Array<[keyword: string, supported: boolean, rule: string]> = [
    ['oneOf', profile.supports.oneOf, RULES.noOneOf],
    ['anyOf', profile.supports.anyOf, RULES.noAnyOf],
    ['allOf', profile.supports.allOf, RULES.noAllOf],
    ['not', profile.supports.not, RULES.noNot],
  ];
  for (const [keyword, supported, rule] of pairs) {
    if (!supported && schema[keyword] !== undefined) {
      report(out, join(path, keyword), rule, `${profile.id} does not accept "${keyword}".`);
    }
  }
}

function checkConstraints(schema: JSONSchemaObject, path: string, profile: Profile, out: Violation[]): void {
  const { supports } = profile;

  if (!supports.enum && schema['enum'] !== undefined) {
    report(out, join(path, 'enum'), RULES.noEnum, `${profile.id} does not accept a fixed list of allowed values.`);
  }
  if (!supports.const && schema['const'] !== undefined) {
    report(out, join(path, 'const'), RULES.noConst, `${profile.id} does not accept a single fixed value.`);
  }
  if (!supports.patternProperties && schema['patternProperties'] !== undefined) {
    report(
      out,
      join(path, 'patternProperties'),
      RULES.noPatternProperties,
      `${profile.id} does not accept properties selected by a pattern.`,
    );
  }
  if (!supports.tupleItems && schema['prefixItems'] !== undefined) {
    report(
      out,
      join(path, 'prefixItems'),
      RULES.noTupleItems,
      `${profile.id} does not accept a per-position list of item schemas.`,
    );
  }
  if (!supports.tupleItems && Array.isArray(schema['items'])) {
    report(
      out,
      join(path, 'items'),
      RULES.noTupleItems,
      `${profile.id} does not accept a per-position list of item schemas.`,
    );
  }
  if (!supports.additionalItems && schema['additionalItems'] !== undefined) {
    report(
      out,
      join(path, 'additionalItems'),
      RULES.noAdditionalItems,
      `${profile.id} does not accept a separate schema for the items past the listed ones.`,
    );
  }
  if (typeof schema['format'] === 'string' && !formatAccepted(profile, schema['format'])) {
    report(
      out,
      join(path, 'format'),
      RULES.noFormat,
      `${profile.id} does not honour the "${schema['format']}" format.`,
    );
  }
  if (!supports.numericBounds) {
    for (const keyword of NUMERIC_BOUND_KEYWORDS) {
      if (schema[keyword] !== undefined) {
        report(out, join(path, keyword), RULES.noNumericBounds, `${profile.id} does not honour "${keyword}".`);
      }
    }
  }
  if (!supports.stringBounds) {
    for (const keyword of STRING_BOUND_KEYWORDS) {
      if (schema[keyword] !== undefined) {
        report(out, join(path, keyword), RULES.noStringBounds, `${profile.id} does not honour "${keyword}".`);
      }
    }
  }
  if (!supports.arrayBounds) {
    for (const keyword of ARRAY_BOUND_KEYWORDS) {
      if (schema[keyword] !== undefined) {
        report(out, join(path, keyword), RULES.noArrayBounds, `${profile.id} does not honour "${keyword}".`);
      }
    }
  }
  if (!supports.defaults && schema['default'] !== undefined) {
    report(out, join(path, 'default'), RULES.noDefaults, `${profile.id} does not accept a default value.`);
  }
  if (!supports.nullableViaType && Array.isArray(schema['type'])) {
    report(
      out,
      join(path, 'type'),
      RULES.noNullableViaType,
      `${profile.id} needs a single type here, not a list of types.`,
    );
  }
}

function checkObjectShape(schema: JSONSchemaObject, path: string, profile: Profile, out: Violation[]): void {
  if (profile.additionalPropertiesMustBeFalse && isObjectLike(schema) && schema['additionalProperties'] !== false) {
    report(
      out,
      join(path, 'additionalProperties'),
      RULES.additionalPropertiesMustBeFalse,
      `${profile.id} needs every object to say "additionalProperties": false.`,
    );
  }

  const properties = schema['properties'];
  if (!isSchemaObject(properties)) return;
  const names = Object.keys(properties);

  if (profile.allPropertiesMustBeRequired) {
    const required = Array.isArray(schema['required']) ? schema['required'] : [];
    for (const name of names) {
      if (!required.includes(name)) {
        report(
          out,
          join(path, 'properties', name),
          RULES.propertyMustBeRequired,
          `${profile.id} needs every property listed as required, and "${name}" is not.`,
        );
      }
    }
  }

  if (profile.maxProperties !== null && names.length > profile.maxProperties) {
    report(
      out,
      join(path, 'properties'),
      RULES.maxProperties,
      `This object declares ${names.length} properties, and ${profile.id} accepts at most ${profile.maxProperties}.`,
    );
  }
}
