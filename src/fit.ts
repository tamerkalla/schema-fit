import type { FitResult, JSONSchema, JSONSchemaObject, Profile } from './types.js';
import { UnfittableSchemaError } from './types.js';
import {
  ANNOTATION_KEYWORDS,
  KNOWN_KEYWORDS,
  acceptsEverything,
  clone,
  deepEqual,
  isObjectLike,
  isSchema,
  isSchemaObject,
  subschemas,
  typeList,
} from './keywords.js';
import { formatAccepted, hasRefSiblings, isConformingRoot } from './check.js';
import { unreachableProperties } from './inhabited.js';
import { intersect, intersectAll, isUnsatisfiable, unsatisfiable } from './intersect.js';
import { join, resolve } from './pointer.js';
import type { Poison } from './recorder.js';
import { Recorder, isPoison, poison } from './recorder.js';
import { ARRAY_BOUND_KEYWORDS, NUMERIC_BOUND_KEYWORDS, RULES, STRING_BOUND_KEYWORDS } from './rules.js';
import type { Ctx } from './transform.js';
import { mapChildrenPolar, pointsAtTroubled, transform, withDefinitionRetry } from './transform.js';
import { renameKeyword, withKeyword, without } from './walk.js';

/**
 * The rewrite passes, in the order they run. Exported so tests can switch any
 * single rule on or off; not part of the public API.
 */
export const PASSES = [
  'strip-unknown',
  'refs',
  'root-object',
  'combinators',
  'constraints',
  'additional-properties',
  'required',
  'max-properties',
  'max-depth',
  'nullability',
] as const;

export type PassId = (typeof PASSES)[number];

export interface FitOptions {
  /** Which passes to run. Defaults to all of them, in order. */
  rules?: readonly PassId[];
}

/**
 * Rewrite a schema so the profile accepts it, without ever widening it.
 *
 * If `fit(S, P).schema` accepts an instance, `S` accepts it too. The converse
 * does not hold: a fitted schema may reject instances the original accepted,
 * and every such rewrite is recorded with `narrowing: true`.
 *
 * Throws {@link UnfittableSchemaError} — and nothing else — when the profile
 * forbids `$ref` and the schema references itself.
 */
export function fit(schema: JSONSchema, profile: Profile): FitResult {
  return fitInternal(schema, profile);
}

/** `fit`, with the ability to run a subset of the passes. Used by the tests. */
export function fitInternal(schema: JSONSchema, profile: Profile, options: FitOptions = {}): FitResult {
  const enabled = new Set<PassId>(options.rules ?? PASSES);
  const out = new Recorder();
  let current = schema;

  for (const pass of PASSES) {
    if (enabled.has(pass)) current = runPass(pass, current, profile, out);
  }

  return {
    schema: current,
    changes: out.changes,
    lossless: out.changes.every((change) => !change.narrowing),
  };
}

function runPass(pass: PassId, schema: JSONSchema, profile: Profile, out: Recorder): JSONSchema {
  switch (pass) {
    case 'strip-unknown':
      return stripUnknownKeywords(schema, profile, out);
    case 'refs':
      return resolveReferences(schema, profile, out);
    case 'root-object':
      return forceObjectRoot(schema, profile, out);
    case 'combinators':
      return fixCombinators(schema, profile, out);
    case 'constraints':
      return fixConstraints(schema, profile, out);
    case 'additional-properties':
      return closeObjects(schema, profile, out);
    case 'required':
      return requireEveryProperty(schema, profile, out);
    case 'max-properties':
      return limitProperties(schema, profile, out);
    case 'max-depth':
      return limitDepth(schema, profile, out);
    case 'nullability':
      return normalizeNullability(schema, profile, out);
  }
}

/* -------------------------------------------------------------------------- */
/* 1. unknown keywords                                                        */
/* -------------------------------------------------------------------------- */

function stripUnknownKeywords(schema: JSONSchema, profile: Profile, out: Recorder): JSONSchema {
  if (profile.unknownKeywords !== 'strip') return schema;
  return transform(schema, out, {
    after: (node, ctx) => {
      const unknown = Object.keys(node).filter((keyword) => !KNOWN_KEYWORDS.has(keyword));
      if (unknown.length === 0) return node;
      for (const keyword of unknown) {
        // Draft 2020-12 ignores keywords it does not define, so this is exact in
        // every position.
        out.apply(
          join(ctx.path, keyword),
          RULES.unknownKeyword,
          `Removed "${keyword}", which ${profile.id} does not recognise; it never affected which values are valid.`,
          'exact',
          ctx.polarity,
        );
      }
      return without(node, ...unknown);
    },
  });
}

/* -------------------------------------------------------------------------- */
/* 2. references                                                              */
/* -------------------------------------------------------------------------- */

function resolveReferences(schema: JSONSchema, profile: Profile, out: Recorder): JSONSchema {
  const document = schema;

  return withDefinitionRetry(schema, out, (plan) => {
  const walk = (node: JSONSchema, ctx: Ctx, stack: string[]): JSONSchema | Poison => {
    if (!isSchemaObject(node)) return node;
    if (ctx.polarity !== 'positive' && pointsAtTroubled(node['$ref'], plan)) {
      return poison(RULES.refInFlippedPosition);
    }

    const rebuilt = mapChildrenPolar(node, ctx, out, plan, (child, childCtx) => walk(child, childCtx, stack));
    if (isPoison(rebuilt) || !isSchemaObject(rebuilt)) return rebuilt;

    const ref = rebuilt['$ref'];
    if (typeof ref !== 'string') return rebuilt;

    const at = join(ctx.path, '$ref');
    if (!ref.startsWith('#')) {
      const ok = out.apply(
        at,
        RULES.externalRef,
        `Replaced a reference to "${ref}" with a schema that accepts nothing, because schema-fit never fetches anything from outside the schema.`,
        'narrowing',
        ctx.polarity,
      );
      return ok ? unsatisfiable() : poison(RULES.externalRef);
    }

    const target = resolve(document, ref.slice(1));
    if (!isSchema(target)) {
      const ok = out.apply(
        at,
        RULES.unresolvableRef,
        `Replaced a reference to "${ref}" with a schema that accepts nothing, because nothing in this schema sits at that location.`,
        'narrowing',
        ctx.polarity,
      );
      return ok ? unsatisfiable() : poison(RULES.unresolvableRef);
    }

    const mustInline = profile.refs === 'none' || (profile.refs === 'internal-no-siblings' && hasRefSiblings(rebuilt));
    if (!mustInline) return rebuilt;

    if (stack.includes(ref)) throw new UnfittableSchemaError(at);
    const expanded = walk(clone(target), { ...ctx, path: ref.slice(1) }, [...stack, ref]);
    if (isPoison(expanded)) return expanded;

    const siblings = without(rebuilt, '$ref');
    const rule = profile.refs === 'none' ? RULES.noRef : RULES.refSiblings;
    const reason =
      profile.refs === 'none'
        ? `${profile.id} does not accept references`
        : `${profile.id} ignores the keywords sitting next to a reference`;

    if (!hasRefSiblings(rebuilt)) {
      out.apply(at, rule, `Replaced a reference with what it pointed at, because ${reason}.`, 'exact', ctx.polarity);
      if (!isSchemaObject(expanded)) return expanded;
      // Only annotations sat alongside the reference; carry them across.
      const merged: JSONSchemaObject = { ...expanded };
      for (const keyword of Object.keys(siblings)) {
        if (merged[keyword] === undefined) merged[keyword] = siblings[keyword];
      }
      return merged;
    }

    const combined = intersect(expanded, siblings);
    if (!combined.exact && profile.supports.allOf) {
      out.apply(
        at,
        rule,
        `Replaced a reference with what it pointed at and kept its neighbouring keywords beside it, because ${reason}.`,
        'exact',
        ctx.polarity,
      );
      return { allOf: [expanded, siblings] };
    }
    const ok = out.apply(
      at,
      rule,
      combined.exact
        ? `Replaced a reference with what it pointed at, folding in the keywords beside it, because ${reason}.`
        : `Replaced a reference and its neighbouring keywords with a schema that accepts nothing, because they cannot be folded into one schema ${profile.id} accepts.`,
      combined.exact ? 'exact' : 'narrowing',
      ctx.polarity,
    );
    return ok ? combined.schema : poison(rule);
  };

  const walked = walk(schema, { path: '', polarity: 'positive', depth: 0 }, []);
  let current = isPoison(walked) ? unsatisfiable() : walked;
  if (profile.refs !== 'none') return current;

  current = transform(current, out, {
    after: (node, ctx) => {
      const present = ['$defs', 'definitions'].filter((keyword) => node[keyword] !== undefined);
      if (present.length === 0) return node;
      for (const keyword of present) {
        // Definitions are never applied to an instance on their own.
        out.apply(
          join(ctx.path, keyword),
          RULES.noDefs,
          `Removed the reusable definitions, which ${profile.id} does not accept; every reference to them has already been replaced by what it pointed at.`,
          'exact',
          ctx.polarity,
        );
      }
      return without(node, ...present);
    },
  });
  return current;
  });
}

/* -------------------------------------------------------------------------- */
/* 3. object root                                                             */
/* -------------------------------------------------------------------------- */

function forceObjectRoot(schema: JSONSchema, profile: Profile, out: Recorder): JSONSchema {
  if (!profile.rootMustBeObject || isConformingRoot(schema)) return schema;

  const message = `Restricted the top level of the schema to objects, which ${profile.id} requires.`;

  if (schema === false || isUnsatisfiable(schema)) {
    out.record('', RULES.rootMustBeObject, `${message} It already accepted nothing.`, false);
    return unsatisfiable();
  }
  if (schema === true || !isSchemaObject(schema)) {
    out.record('', RULES.rootMustBeObject, message, true);
    return { type: 'object' };
  }

  const types = typeList(schema);
  if (types && !types.includes('object')) {
    out.record(
      '',
      RULES.rootMustBeObject,
      `${message} Nothing is left, because the schema accepted no objects to begin with.`,
      true,
    );
    return unsatisfiable();
  }
  out.record('', RULES.rootMustBeObject, message, !types || types.length > 1);
  return withKeyword(schema, 'type', 'object', 'first');
}

/* -------------------------------------------------------------------------- */
/* 4. combinators                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Unsupported combinators are taken apart on the way *down*, before their
 * branches are visited. A `oneOf` branch and a `not` are positions where making
 * a schema stricter does not make the whole stricter, so rewriting inside them
 * is mostly forbidden; removing the combinator first turns its branches into
 * ordinary positions that the later passes can work on freely.
 */
function fixCombinators(schema: JSONSchema, profile: Profile, out: Recorder): JSONSchema {
  const unsupportedHere = (node: JSONSchemaObject): boolean =>
    (!profile.supports.oneOf && node['oneOf'] !== undefined) ||
    (!profile.supports.anyOf && node['anyOf'] !== undefined) ||
    (!profile.supports.allOf && node['allOf'] !== undefined) ||
    (!profile.supports.not && node['not'] !== undefined);

  return transform(schema, out, {
    before: (node, ctx) => {
      let current: JSONSchema | Poison = node;
      // Merging a branch in can bring another combinator up to this level, so
      // keep going until the node is clean. Each round removes one keyword, so
      // the bound is only there to make termination obvious.
      for (let round = 0; round < 8; round++) {
        if (!isSchemaObject(current) || !unsupportedHere(current)) break;
        if (isSchemaObject(current) && !profile.supports.oneOf && current['oneOf'] !== undefined) {
          current = fixOneOf(current, ctx, profile, out);
        }
        if (isSchemaObject(current) && !profile.supports.anyOf && current['anyOf'] !== undefined) {
          current = collapseUnion(current, 'anyOf', RULES.noAnyOf, ctx, profile, out);
        }
        if (isSchemaObject(current) && !profile.supports.allOf && current['allOf'] !== undefined) {
          current = flattenAllOf(current, ctx, profile, out);
        }
        if (isSchemaObject(current) && !profile.supports.not && current['not'] !== undefined) {
          current = removeNot(current, ctx, profile, out);
        }
      }
      return current;
    },
  });
}

function branchesOf(node: JSONSchemaObject, keyword: string): JSONSchema[] {
  const value = node[keyword];
  return Array.isArray(value) ? value.filter(isSchema) : [];
}

/**
 * `oneOf` means *exactly* one, so a single branch is only a subset of the whole
 * when nothing else can match alongside it. Where that cannot be shown, keeping
 * a branch would accept instances the original rejected — the one thing this
 * library promises never to do.
 */
function fixOneOf(node: JSONSchemaObject, ctx: Ctx, profile: Profile, out: Recorder): JSONSchema | Poison {
  const branches = branchesOf(node, 'oneOf');
  const at = join(ctx.path, 'oneOf');

  if (branches.length === 0) {
    out.apply(
      at,
      RULES.noOneOf,
      `Replaced an empty "oneOf", which accepted nothing, with a schema that accepts nothing.`,
      'exact',
      ctx.polarity,
    );
    return unsatisfiable();
  }

  if (branches.length > 1 && profile.supports.anyOf && branchesAreDisjoint(branches)) {
    out.apply(
      at,
      RULES.noOneOf,
      `Turned "oneOf" into "anyOf", which ${profile.id} accepts; the options cannot overlap, so the same values are still valid.`,
      'exact',
      ctx.polarity,
    );
    return renameKeyword(node, 'oneOf', 'anyOf');
  }

  if (branches.length > 1 && profile.supports.anyOf && profile.supports.allOf && profile.supports.not) {
    const expanded = branches.map((branch, index) => ({
      allOf: [branch, ...branches.filter((_, other) => other !== index).map((other) => ({ not: other }))],
    }));
    out.apply(
      at,
      RULES.noOneOf,
      `Rewrote "oneOf" as "anyOf" with each option ruling out the others, because ${profile.id} does not accept "oneOf"; the same values are still valid.`,
      'exact',
      ctx.polarity,
    );
    return withKeyword(without(node, 'oneOf'), 'anyOf', expanded);
  }

  if (branches.length === 1) {
    const merged = intersect(without(node, 'oneOf'), branches[0] as JSONSchema);
    const ok = out.apply(
      at,
      RULES.noOneOf,
      `Folded the single "oneOf" option into the schema around it, because ${profile.id} does not accept "oneOf".`,
      merged.exact ? 'exact' : 'narrowing',
      ctx.polarity,
    );
    return ok ? merged.schema : poison(RULES.noOneOf);
  }

  const keepable = branches.findIndex((branch, index) =>
    branches.every((other, otherIndex) => otherIndex === index || pairIsDisjoint(branch, other)),
  );
  if (keepable !== -1) {
    const merged = intersect(without(node, 'oneOf'), branches[keepable] as JSONSchema);
    const ok = out.apply(
      at,
      RULES.noOneOf,
      `Kept one of ${branches.length} options, the only one that cannot overlap the others, because ${profile.id} accepts neither "oneOf" nor a safe substitute for it here.`,
      'narrowing',
      ctx.polarity,
    );
    return ok ? merged.schema : poison(RULES.noOneOf);
  }

  const ok = out.apply(
    at,
    RULES.noOneOf,
    `Replaced "oneOf" with a schema that accepts nothing, because ${profile.id} does not accept "oneOf" and its options can overlap, so keeping any one of them would allow values the original rejected.`,
    'narrowing',
    ctx.polarity,
  );
  return ok ? unsatisfiable() : poison(RULES.noOneOf);
}

function collapseUnion(
  node: JSONSchemaObject,
  keyword: string,
  rule: string,
  ctx: Ctx,
  profile: Profile,
  out: Recorder,
): JSONSchema | Poison {
  const branches = branchesOf(node, keyword);
  const at = join(ctx.path, keyword);

  if (branches.length === 0) {
    out.apply(
      at,
      rule,
      `Replaced an empty "${keyword}", which accepted nothing, with a schema that accepts nothing.`,
      'exact',
      ctx.polarity,
    );
    return unsatisfiable();
  }

  const merged = intersect(without(node, keyword), branches[0] as JSONSchema);
  const effect = branches.length > 1 || !merged.exact ? 'narrowing' : 'exact';
  const ok = out.apply(
    at,
    rule,
    branches.length > 1
      ? `Kept only the first of ${branches.length} options, because ${profile.id} does not accept "${keyword}".`
      : `Folded the single "${keyword}" option into the schema around it, because ${profile.id} does not accept "${keyword}".`,
    effect,
    ctx.polarity,
  );
  return ok ? merged.schema : poison(rule);
}

function flattenAllOf(node: JSONSchemaObject, ctx: Ctx, profile: Profile, out: Recorder): JSONSchema | Poison {
  const branches = branchesOf(node, 'allOf');
  const at = join(ctx.path, 'allOf');
  const merged = intersectAll([without(node, 'allOf'), ...branches]);
  const ok = out.apply(
    at,
    RULES.noAllOf,
    merged.exact
      ? `Merged the "allOf" pieces into a single schema, because ${profile.id} does not accept "allOf"; the same values are still valid.`
      : `Replaced "allOf" with a schema that accepts nothing, because its pieces cannot be merged into one schema and dropping any of them would allow values the original rejected.`,
    merged.exact ? 'exact' : 'narrowing',
    ctx.polarity,
  );
  return ok ? merged.schema : poison(RULES.noAllOf);
}

const BASE_TYPES = ['null', 'boolean', 'object', 'array', 'number', 'string'];

function removeNot(node: JSONSchemaObject, ctx: Ctx, profile: Profile, out: Recorder): JSONSchema | Poison {
  const negated = node['not'];
  const rest = without(node, 'not');
  const at = join(ctx.path, 'not');

  if (negated === false) {
    out.apply(at, RULES.noNot, `Removed "not", which ruled out nothing; the same values are still valid.`, 'exact', ctx.polarity);
    return rest;
  }
  if (negated === true || (isSchema(negated) && acceptsEverything(negated))) {
    out.apply(at, RULES.noNot, `Removed "not", which ruled out everything; the schema still accepts nothing.`, 'exact', ctx.polarity);
    return unsatisfiable();
  }

  if (isSchemaObject(negated)) {
    const meaningful = Object.keys(negated).filter((keyword) => !ANNOTATION_KEYWORDS.has(keyword));

    if (meaningful.length === 1 && meaningful[0] === 'type') {
      const excluded = typeList(negated) ?? [];
      const base = typeList(rest) ?? BASE_TYPES;
      const kept: string[] = [];
      let exact = true;

      for (const type of base) {
        if (excluded.includes(type)) continue;
        // Every integer is a number, so ruling out numbers rules out integers.
        if (type === 'integer' && excluded.includes('number')) continue;
        if (type === 'number' && excluded.includes('integer')) {
          // The other way round has no answer: "a number that is not an
          // integer" is not a type. Giving up the whole of `number` costs the
          // fractions, and is the only way not to let the integers back in.
          exact = false;
          continue;
        }
        kept.push(type);
      }

      if (kept.length === 0) {
        const ok = out.apply(
          at,
          RULES.noNot,
          `Removed "not" by ruling out every remaining type, so the schema accepts nothing.`,
          exact ? 'exact' : 'narrowing',
          ctx.polarity,
        );
        return ok ? unsatisfiable() : poison(RULES.noNot);
      }
      const ok = out.apply(
        at,
        RULES.noNot,
        exact
          ? `Replaced "not" with the list of types it left over, because ${profile.id} does not accept "not"; the same values are still valid.`
          : `Replaced "not" with the list of types it left over and gave up numbers altogether, because ${profile.id} does not accept "not" and "a number that is not a whole number" is not a type; the schema now rejects fractions it used to allow.`,
        exact ? 'exact' : 'narrowing',
        ctx.polarity,
      );
      if (!ok) return poison(RULES.noNot);
      return withKeyword(rest, 'type', kept.length === 1 ? (kept[0] as string) : kept);
    }

    const negatesValuesOnly = meaningful.length === 1 && (meaningful[0] === 'const' || meaningful[0] === 'enum');
    const forbidden =
      negated['const'] !== undefined ? [negated['const']] : Array.isArray(negated['enum']) ? negated['enum'] : undefined;
    const allowed = Array.isArray(rest['enum'])
      ? rest['enum']
      : rest['const'] !== undefined
        ? [rest['const']]
        : undefined;

    if (negatesValuesOnly && forbidden && allowed) {
      const kept = allowed.filter((value) => !forbidden.some((other) => deepEqual(value, other)));
      if (kept.length === 0) {
        out.apply(at, RULES.noNot, `Removed "not" by ruling out every allowed value, so the schema accepts nothing.`, 'exact', ctx.polarity);
        return unsatisfiable();
      }
      out.apply(
        at,
        RULES.noNot,
        `Replaced "not" by dropping the values it ruled out, because ${profile.id} does not accept "not"; the same values are still valid.`,
        'exact',
        ctx.polarity,
      );
      return withKeyword(without(rest, 'const'), 'enum', kept);
    }
  }

  const ok = out.apply(
    at,
    RULES.noNot,
    `Replaced a schema using "not" with one that accepts nothing, because ${profile.id} does not accept "not" and dropping it would allow values the original rejected.`,
    'narrowing',
    ctx.polarity,
  );
  return ok ? unsatisfiable() : poison(RULES.noNot);
}

/** True when no instance at all can satisfy both schemas. */
export function pairIsDisjoint(a: JSONSchema, b: JSONSchema): boolean {
  if (a === false || b === false) return true;
  if (isUnsatisfiable(a) || isUnsatisfiable(b)) return true;
  if (!isSchemaObject(a) || !isSchemaObject(b)) return false;
  return typesAreDisjoint(a, b) || valuesAreDisjoint(a, b) || discriminatorsDiffer(a, b);
}

/** True when no instance can satisfy two of these at once. */
export function branchesAreDisjoint(branches: JSONSchema[]): boolean {
  for (let i = 0; i < branches.length; i++) {
    for (let j = i + 1; j < branches.length; j++) {
      if (!pairIsDisjoint(branches[i] as JSONSchema, branches[j] as JSONSchema)) return false;
    }
  }
  return true;
}

function typesAreDisjoint(a: JSONSchemaObject, b: JSONSchemaObject): boolean {
  const ta = typeList(a);
  const tb = typeList(b);
  if (!ta || !tb || ta.length === 0 || tb.length === 0) return false;
  return !ta.some(
    (type) =>
      tb.includes(type) ||
      (type === 'integer' && tb.includes('number')) ||
      (type === 'number' && tb.includes('integer')),
  );
}

/** The values a schema pins down outright, if it pins any down at all. */
function fixedValues(schema: JSONSchema): unknown[] | undefined {
  if (!isSchemaObject(schema)) return undefined;
  if (schema['const'] !== undefined) return [schema['const']];
  if (Array.isArray(schema['enum'])) return schema['enum'];
  return undefined;
}

function valuesAreDisjoint(a: JSONSchemaObject, b: JSONSchemaObject): boolean {
  const va = fixedValues(a);
  const vb = fixedValues(b);
  if (!va || !vb) return false;
  return !va.some((value) => vb.some((other) => deepEqual(value, other)));
}

/** The discriminated-union shape: both pin the same required property differently. */
function discriminatorsDiffer(a: JSONSchemaObject, b: JSONSchemaObject): boolean {
  if (!deepEqual(typeList(a), ['object']) || !deepEqual(typeList(b), ['object'])) return false;
  const propsA = a['properties'];
  const propsB = b['properties'];
  const requiredA = a['required'];
  const requiredB = b['required'];
  if (!isSchemaObject(propsA) || !isSchemaObject(propsB)) return false;
  if (!Array.isArray(requiredA) || !Array.isArray(requiredB)) return false;

  for (const key of Object.keys(propsA)) {
    if (!requiredA.includes(key) || !requiredB.includes(key)) continue;
    const left = propsA[key];
    const right = propsB[key];
    if (!isSchema(left) || !isSchema(right)) continue;
    if (pairIsDisjoint(left, right)) return true;
  }
  return false;
}

/* -------------------------------------------------------------------------- */
/* 5. unsupported constraints                                                 */
/* -------------------------------------------------------------------------- */

function fixConstraints(schema: JSONSchema, profile: Profile, out: Recorder): JSONSchema {
  const { supports } = profile;

  return transform(schema, out, {
    after: (node, ctx) => {
      let current: JSONSchema | Poison = node;

      if (isSchemaObject(current) && !supports.enum && current['enum'] !== undefined) {
        current = fixEnum(current, ctx, profile, out);
      }
      if (isSchemaObject(current) && !supports.const && current['const'] !== undefined) {
        current = fixConst(current, ctx, profile, out);
      }
      if (isSchemaObject(current) && !supports.patternProperties && current['patternProperties'] !== undefined) {
        current = fixPatternProperties(current, ctx, profile, out);
      }
      if (isSchemaObject(current) && !supports.tupleItems && hasTuple(current)) {
        current = fixTupleItems(current, ctx, profile, out);
      }
      if (isSchemaObject(current) && !supports.additionalItems && current['additionalItems'] !== undefined) {
        // Draft 2020-12 dropped the keyword, so removing it changes nothing.
        out.apply(
          join(ctx.path, 'additionalItems'),
          RULES.noAdditionalItems,
          `Removed "additionalItems", which ${profile.id} does not accept; draft 2020-12 ignores it anyway, so the same values are still valid.`,
          'exact',
          ctx.polarity,
        );
        current = without(current, 'additionalItems');
      }
      if (isSchemaObject(current) && typeof current['format'] === 'string' && !formatAccepted(profile, current['format'])) {
        // `format` is an annotation in draft 2020-12, not an assertion.
        out.apply(
          join(ctx.path, 'format'),
          RULES.noFormat,
          `Removed the "${current['format']}" format, which ${profile.id} does not honour; draft 2020-12 treats a format as a note rather than a rule, so the same values are still valid.`,
          'exact',
          ctx.polarity,
        );
        current = without(current, 'format');
      }
      if (isSchemaObject(current)) {
        current = dropBounds(current, ctx, profile, out);
      }
      if (isSchemaObject(current) && !supports.defaults && current['default'] !== undefined) {
        out.apply(
          join(ctx.path, 'default'),
          RULES.noDefaults,
          `Removed the default value, which ${profile.id} does not accept; a default never decided which values are valid.`,
          'exact',
          ctx.polarity,
        );
        current = without(current, 'default');
      }

      return current;
    },
  });
}

function fixEnum(node: JSONSchemaObject, ctx: Ctx, profile: Profile, out: Recorder): JSONSchema | Poison {
  const values = Array.isArray(node['enum']) ? node['enum'] : [];
  const at = join(ctx.path, 'enum');

  if (values.length === 0) {
    out.apply(
      at,
      RULES.noEnum,
      `Replaced an empty list of allowed values, which accepted nothing, with a schema that accepts nothing.`,
      'exact',
      ctx.polarity,
    );
    return unsatisfiable();
  }
  if (values.length === 1 && profile.supports.const) {
    out.apply(
      at,
      RULES.noEnum,
      `Turned a one-item list of allowed values into a single fixed value, because ${profile.id} does not accept "enum"; the same values are still valid.`,
      'exact',
      ctx.polarity,
    );
    return withKeyword(without(node, 'enum'), 'const', values[0]);
  }
  const ok = out.apply(
    at,
    RULES.noEnum,
    `Replaced the list of allowed values with a schema that accepts nothing, because ${profile.id} does not accept "enum" and dropping the list would allow values the original rejected.`,
    'narrowing',
    ctx.polarity,
  );
  return ok ? unsatisfiable() : poison(RULES.noEnum);
}

function fixConst(node: JSONSchemaObject, ctx: Ctx, profile: Profile, out: Recorder): JSONSchema | Poison {
  const at = join(ctx.path, 'const');
  if (profile.supports.enum) {
    out.apply(
      at,
      RULES.noConst,
      `Turned the single fixed value into a one-item list of allowed values, because ${profile.id} does not accept "const"; the same values are still valid.`,
      'exact',
      ctx.polarity,
    );
    return withKeyword(without(node, 'const'), 'enum', [node['const']]);
  }
  const ok = out.apply(
    at,
    RULES.noConst,
    `Replaced the single fixed value with a schema that accepts nothing, because ${profile.id} accepts neither "const" nor "enum" and dropping it would allow values the original rejected.`,
    'narrowing',
    ctx.polarity,
  );
  return ok ? unsatisfiable() : poison(RULES.noConst);
}

function fixPatternProperties(node: JSONSchemaObject, ctx: Ctx, profile: Profile, out: Recorder): JSONSchema | Poison {
  const patterns = node['patternProperties'];
  const at = join(ctx.path, 'patternProperties');
  const closedAlready = node['additionalProperties'] === false;
  let exact = true;

  let result = without(node, 'patternProperties');
  if (isSchemaObject(patterns) && isSchemaObject(result['properties'])) {
    const properties: JSONSchemaObject = { ...result['properties'] };
    for (const name of Object.keys(properties)) {
      for (const pattern of Object.keys(patterns)) {
        let regex: RegExp;
        try {
          regex = new RegExp(pattern, 'u');
        } catch {
          exact = false;
          continue;
        }
        if (!regex.test(name)) continue;
        const merged = intersect(properties[name] as JSONSchema, patterns[pattern] as JSONSchema);
        if (!merged.exact) exact = false;
        properties[name] = merged.schema;
      }
    }
    result = withKeyword(result, 'properties', properties);
  }
  result = withKeyword(result, 'additionalProperties', false);

  const effect = !closedAlready || !exact ? 'narrowing' : 'exact';
  const ok = out.apply(
    at,
    RULES.noPatternProperties,
    closedAlready
      ? `Folded the pattern-matched property rules into the properties they applied to, because ${profile.id} does not accept "patternProperties".`
      : `Folded the pattern-matched property rules into the properties they applied to and closed the object, because ${profile.id} does not accept "patternProperties"; the schema now rejects any property it does not declare.`,
    effect,
    ctx.polarity,
  );
  return ok ? result : poison(RULES.noPatternProperties);
}

function hasTuple(node: JSONSchemaObject): boolean {
  return node['prefixItems'] !== undefined || Array.isArray(node['items']);
}

function fixTupleItems(node: JSONSchemaObject, ctx: Ctx, profile: Profile, out: Recorder): JSONSchema | Poison {
  const prefix = Array.isArray(node['prefixItems'])
    ? node['prefixItems'].filter(isSchema)
    : Array.isArray(node['items'])
      ? node['items'].filter(isSchema)
      : [];
  const rest = Array.isArray(node['prefixItems']) && isSchema(node['items']) ? (node['items'] as JSONSchema) : true;
  const at = join(ctx.path, node['prefixItems'] !== undefined ? 'prefixItems' : 'items');

  if (prefix.length === 0) {
    out.apply(
      at,
      RULES.noTupleItems,
      `Removed an empty list of per-position item schemas, which constrained nothing, because ${profile.id} accepts one item schema only.`,
      'exact',
      ctx.polarity,
    );
    return without(node, 'prefixItems');
  }

  const merged = intersectAll([...prefix, rest]);
  const stripped = without(node, 'prefixItems', 'items');
  const ok = out.apply(
    at,
    RULES.noTupleItems,
    `Replaced the per-position item schemas with a single schema every item must satisfy, because ${profile.id} accepts one item schema only; the schema now rejects arrays whose items only matched their own position.`,
    'narrowing',
    ctx.polarity,
  );
  if (!ok) return poison(RULES.noTupleItems);
  return merged.schema === true ? stripped : withKeyword(stripped, 'items', merged.schema);
}

function dropBounds(node: JSONSchemaObject, ctx: Ctx, profile: Profile, out: Recorder): JSONSchemaObject | Poison {
  const groups: Array<[keywords: readonly string[], supported: boolean, rule: string, subject: string]> = [
    [NUMERIC_BOUND_KEYWORDS, profile.supports.numericBounds, RULES.noNumericBounds, 'number limits'],
    [STRING_BOUND_KEYWORDS, profile.supports.stringBounds, RULES.noStringBounds, 'text limits'],
    [ARRAY_BOUND_KEYWORDS, profile.supports.arrayBounds, RULES.noArrayBounds, 'list limits'],
  ];

  let result = node;
  for (const [keywords, supported, rule, subject] of groups) {
    if (supported) continue;
    const present = keywords.filter((keyword) => result[keyword] !== undefined);
    if (present.length === 0) continue;
    for (const keyword of present) {
      // Dropping a limit is the one rewrite that hands the provider a schema
      // wider than the original. See the README.
      const ok = out.apply(
        join(ctx.path, keyword),
        rule,
        `Removed "${keyword}", because ${profile.id} does not honour ${subject}; it would have ignored the limit anyway, so keep validating against your original schema.`,
        'widening',
        ctx.polarity,
      );
      if (!ok) return poison(rule);
    }
    result = without(result, ...present);
  }
  return result;
}

/* -------------------------------------------------------------------------- */
/* 6. additionalProperties: false                                             */
/* -------------------------------------------------------------------------- */

function closeObjects(schema: JSONSchema, profile: Profile, out: Recorder): JSONSchema {
  if (!profile.additionalPropertiesMustBeFalse) return schema;
  return transform(schema, out, {
    after: (node, ctx) => {
      if (!isObjectLike(node) || node['additionalProperties'] === false) return node;
      const previous = node['additionalProperties'];
      const effect = isSchema(previous) && isUnsatisfiable(previous) ? 'exact' : 'narrowing';
      const ok = out.apply(
        join(ctx.path, 'additionalProperties'),
        RULES.additionalPropertiesMustBeFalse,
        `Set "additionalProperties" to false, which ${profile.id} requires of every object; the schema now rejects any property it does not declare.`,
        effect,
        ctx.polarity,
      );
      return ok ? withKeyword(node, 'additionalProperties', false) : poison(RULES.additionalPropertiesMustBeFalse);
    },
  });
}

/* -------------------------------------------------------------------------- */
/* 7. every property required                                                 */
/* -------------------------------------------------------------------------- */

function requireEveryProperty(schema: JSONSchema, profile: Profile, out: Recorder): JSONSchema {
  if (!profile.allPropertiesMustBeRequired) return schema;
  // Worked out once, over the schema as it stands before this pass: which
  // optional properties cannot be required without leaving a schema that
  // accepts nothing.
  const unreachable = unreachableProperties(schema);

  return transform(schema, out, {
    after: (node, ctx) => {
      if (!isSchemaObject(node['properties'])) return node;
      const properties = node['properties'];
      const names = Object.keys(properties);
      const required = Array.isArray(node['required']) ? [...node['required']] : [];
      const missing = names.filter((name) => !required.includes(name));
      if (missing.length === 0) return node;

      const dropped: string[] = [];
      for (const name of missing) {
        const property = properties[name];
        // Requiring a property nothing can satisfy leaves an object nothing can
        // satisfy either — which is what a self-referential property does once
        // every property is required. The property was optional, so an object
        // without it is one the original accepts: dropping it keeps the schema
        // usable, and closing the object keeps it sound.
        if (isSchema(property) && unreachable.has(join(ctx.path, 'properties', name))) {
          const ok = out.apply(
            join(ctx.path, 'properties', name),
            RULES.unreachableProperty,
            `Dropped "${name}" instead of marking it required, because nothing can satisfy it and ${profile.id} requires every property it declares; requiring it would have left a schema that accepts nothing at all. The schema now rejects objects carrying "${name}".`,
            'narrowing',
            ctx.polarity,
          );
          if (!ok) return poison(RULES.unreachableProperty);
          dropped.push(name);
          continue;
        }

        const ok = out.apply(
          join(ctx.path, 'properties', name),
          RULES.propertyMustBeRequired,
          `Marked "${name}" as required, because ${profile.id} demands it of every property; the schema now rejects objects that leave it out.`,
          'narrowing',
          ctx.polarity,
        );
        if (!ok) return poison(RULES.propertyMustBeRequired);
        required.push(name);
      }

      let result = node;
      if (dropped.length > 0) {
        const kept: JSONSchemaObject = {};
        for (const name of names) if (!dropped.includes(name)) kept[name] = properties[name];
        result = withKeyword(result, 'properties', kept);
        // Closing the object is what bans the dropped names rather than leaving
        // them unconstrained.
        result = withKeyword(result, 'additionalProperties', false);
      }
      return withKeyword(result, 'required', required);
    },
  });
}

/* -------------------------------------------------------------------------- */
/* 8. property-count limit                                                    */
/* -------------------------------------------------------------------------- */

function limitProperties(schema: JSONSchema, profile: Profile, out: Recorder): JSONSchema {
  const limit = profile.maxProperties;
  if (limit === null) return schema;
  return transform(schema, out, {
    after: (node, ctx) => {
      if (!isSchemaObject(node['properties'])) return node;
      const names = Object.keys(node['properties']);
      if (names.length <= limit) return node;

      const required = Array.isArray(node['required']) ? node['required'] : [];
      const keep = new Set<string>();
      for (const name of names) if (required.includes(name) && keep.size < limit) keep.add(name);
      for (const name of names) if (!keep.has(name) && keep.size < limit) keep.add(name);

      const properties: JSONSchemaObject = {};
      for (const name of names) if (keep.has(name)) properties[name] = (node['properties'] as JSONSchemaObject)[name];

      const ok = out.apply(
        join(ctx.path, 'properties'),
        RULES.maxProperties,
        `Dropped ${names.length - keep.size} of ${names.length} properties and closed the object, because ${profile.id} accepts at most ${limit} on one object; the schema now rejects objects carrying the properties that were dropped.`,
        'narrowing',
        ctx.polarity,
      );
      if (!ok) return poison(RULES.maxProperties);
      // Closing the object is what makes dropping sound: an undeclared property
      // is now rejected rather than left unconstrained.
      return withKeyword(withKeyword(node, 'properties', properties), 'additionalProperties', false);
    },
  });
}

/* -------------------------------------------------------------------------- */
/* 9. nesting limit                                                           */
/* -------------------------------------------------------------------------- */

function limitDepth(schema: JSONSchema, profile: Profile, out: Recorder): JSONSchema {
  const limit = profile.maxDepth;
  if (limit === null) return schema;

  return transform(schema, out, {
    before: (node, ctx) => {
      if (ctx.depth < limit) return node;
      const deeper = subschemas(node, ctx.path).some((slot) => slot.nesting && isSchemaObject(slot.schema));
      if (!deeper) return node;
      const ok = out.apply(
        ctx.path,
        RULES.maxDepth,
        `Replaced everything from this point down with a schema that accepts nothing, because ${profile.id} accepts at most ${limit} levels of nesting and there was more below.`,
        isUnsatisfiable(node) ? 'exact' : 'narrowing',
        ctx.polarity,
      );
      return ok ? unsatisfiable() : poison(RULES.maxDepth);
    },
  });
}

/* -------------------------------------------------------------------------- */
/* 10. nullability                                                            */
/* -------------------------------------------------------------------------- */

function normalizeNullability(schema: JSONSchema, profile: Profile, out: Recorder): JSONSchema {
  if (profile.supports.nullableViaType) return schema;
  return transform(schema, out, {
    after: (node, ctx) => {
      if (!Array.isArray(node['type'])) return node;
      const types = node['type'].filter((type): type is string => typeof type === 'string');
      const at = join(ctx.path, 'type');

      if (types.length === 0) {
        out.apply(
          at,
          RULES.noNullableViaType,
          `Replaced an empty list of types, which accepted nothing, with a schema that accepts nothing.`,
          'exact',
          ctx.polarity,
        );
        return unsatisfiable();
      }
      const chosen = types.find((type) => type !== 'null') ?? (types[0] as string);
      const ok = out.apply(
        at,
        RULES.noNullableViaType,
        types.length === 1
          ? `Wrote the single type on its own, because ${profile.id} does not accept a list of types.`
          : `Kept only the "${chosen}" type out of ${types.length}, because ${profile.id} does not accept a list of types; the schema now rejects the other types.`,
        types.length > 1 ? 'narrowing' : 'exact',
        ctx.polarity,
      );
      return ok ? withKeyword(node, 'type', chosen) : poison(RULES.noNullableViaType);
    },
  });
}
