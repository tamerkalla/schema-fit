import type { JSONSchema, JSONSchemaObject } from './types.js';
import { isSchemaObject } from './keywords.js';
import { unsatisfiable } from './intersect.js';
import type { Poison, Polarity } from './recorder.js';
import { Recorder, combinePolarity, isPoison, poison, polarityFor } from './recorder.js';
import { RULES } from './rules.js';
import { mapChildren } from './walk.js';

export interface Ctx {
  path: string;
  polarity: Polarity;
  /** How many instance levels below the root this schema sits. */
  depth: number;
}

export type NodeRewriter = (node: JSONSchemaObject, ctx: Ctx) => JSONSchema | Poison;

export type Visitor = (node: JSONSchema, ctx: Ctx) => JSONSchema | Poison;

/**
 * Where each entry of a `$defs` section stands, worked out from the places that
 * reference it. A definition used only in ordinary positions can be rewritten
 * like anything else; one reached from inside a `not` cannot.
 */
export type DefinitionPolarity = ReadonlyMap<string, Polarity>;

const DEFINITION_KEYWORDS = new Set(['$defs', 'definitions']);

/**
 * A pass in progress: where the definitions stand, which of them turned out to
 * need a rewrite their position forbids, and whether this is the second run.
 */
export interface Plan {
  definitions: DefinitionPolarity;
  /** Definitions that could not be rewritten where their references put them. */
  troubled: Set<string>;
  retry: boolean;
}

/** The position of a definition entry, defaulting to ordinary for unused ones. */
function polarityOfDefinition(plan: Plan, path: string): Polarity {
  // On the second run a troubled definition is rewritten freely, because every
  // reference that reached it from a tricky position has been dealt with.
  if (plan.retry && plan.troubled.has(path)) return 'positive';
  return plan.definitions.get(path) ?? 'positive';
}

/** True when this reference points into one of the definitions we gave up on. */
export function pointsAtTroubled(ref: unknown, plan: Plan): boolean {
  if (!plan.retry || typeof ref !== 'string' || !ref.startsWith('#')) return false;
  const target = ref.slice(1);
  for (const definition of plan.troubled) {
    if (target === definition || target.startsWith(`${definition}/`)) return true;
  }
  return false;
}

/**
 * Run a pass, and run it again if a definition turned out to need a rewrite that
 * the places referencing it forbid.
 *
 * The second run takes the other way out: rewrite the definition, and replace the
 * references that reach it from a flipped position — those are what would have
 * widened the schema. Replacing the reference is a far smaller loss than
 * replacing the definition, which every other reference shares.
 *
 * A pass that needs no second run records nothing extra, so a schema that
 * already conforms still comes back untouched.
 */
export function withDefinitionRetry(
  schema: JSONSchema,
  out: Recorder,
  run: (plan: Plan) => JSONSchema,
): JSONSchema {
  const definitions = definitionPolarity(schema);
  const troubled = new Set<string>();
  const mark = out.mark();

  const first = run({ definitions, troubled, retry: false });
  if (troubled.size === 0) return first;

  out.rollback(mark);
  return run({ definitions, troubled, retry: true });
}

/**
 * Work out the position of every definition, by following the references to it.
 * A definition that references another passes its own position along, so the
 * answer is a fixed point; three rounds settle every realistic schema and the
 * result is only ever made weaker by another round.
 */
export function definitionPolarity(schema: JSONSchema): DefinitionPolarity {
  const definitions: string[] = [];
  collectDefinitions(schema, '', definitions);
  if (definitions.length === 0) return new Map();

  let map = new Map<string, Polarity>();
  for (let round = 0; round < 3; round++) {
    const sites: Array<{ target: string; polarity: Polarity }> = [];
    collectReferences(schema, { path: '', polarity: 'positive', depth: 0 }, map, sites);

    const next = new Map<string, Polarity>();
    for (const definition of definitions) {
      let combined: Polarity | undefined;
      for (const site of sites) {
        if (site.target !== definition && !site.target.startsWith(`${definition}/`)) continue;
        combined = combined === undefined ? site.polarity : combinePolarity(combined, site.polarity);
      }
      if (combined !== undefined) next.set(definition, combined);
    }
    if (sameMap(map, next)) return next;
    map = next;
  }
  return map;
}

function sameMap(a: ReadonlyMap<string, Polarity>, b: ReadonlyMap<string, Polarity>): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) if (b.get(key) !== value) return false;
  return true;
}

function collectDefinitions(schema: JSONSchema, path: string, out: string[]): void {
  if (!isSchemaObject(schema)) return;
  mapChildren(schema, path, (child, childPath, _nesting, keyword) => {
    if (DEFINITION_KEYWORDS.has(keyword)) out.push(childPath);
    collectDefinitions(child, childPath, out);
    return child;
  });
}

function collectReferences(
  schema: JSONSchema,
  ctx: Ctx,
  known: DefinitionPolarity,
  out: Array<{ target: string; polarity: Polarity }>,
): void {
  if (!isSchemaObject(schema)) return;
  const ref = schema['$ref'];
  if (typeof ref === 'string' && ref.startsWith('#')) {
    out.push({ target: ref.slice(1), polarity: ctx.polarity });
  }
  mapChildren(schema, ctx.path, (child, childPath, nesting, keyword) => {
    const polarity = DEFINITION_KEYWORDS.has(keyword)
      ? (known.get(childPath) ?? 'positive')
      : polarityFor(ctx.polarity, keyword);
    collectReferences(child, { path: childPath, polarity, depth: ctx.depth + (nesting ? 1 : 0) }, known, out);
    return child;
  });
}

/**
 * Rebuild the children of a schema, carrying position and depth down and
 * handling a child that could not be rewritten where it stood.
 *
 * A poisoned child is absorbed by the nearest ancestor in an ordinary position:
 * that ancestor becomes a schema accepting nothing, which is always sound. Any
 * change recorded inside the discarded subtree is rolled back, because none of
 * it survives into the result.
 *
 * A definition is the exception. Poison from one does not travel up into the
 * schema that happens to hold the `$defs` section — that would throw away the
 * whole document over one negated reference. It is noted instead, and
 * {@link withDefinitionRetry} runs the pass again the other way round.
 */
export function mapChildrenPolar(
  node: JSONSchemaObject,
  ctx: Ctx,
  out: Recorder,
  plan: Plan,
  visit: Visitor,
): JSONSchemaObject | Poison {
  const mark = out.mark();
  let poisoned: Poison | undefined;

  const rebuilt = mapChildren(node, ctx.path, (child, childPath, nesting, keyword) => {
    if (poisoned) return child;
    const isDefinition = DEFINITION_KEYWORDS.has(keyword);
    const polarity = isDefinition ? polarityOfDefinition(plan, childPath) : polarityFor(ctx.polarity, keyword);
    const childMark = out.mark();

    const result = visit(child, { path: childPath, polarity, depth: ctx.depth + (nesting ? 1 : 0) });
    if (!isPoison(result)) return result;

    if (!isDefinition) {
      poisoned = result;
      return child;
    }

    out.rollback(childMark);
    if (!plan.retry) {
      // Note it and leave the definition alone; the second run will rewrite it
      // and deal with the references that made this impossible.
      plan.troubled.add(childPath);
      return child;
    }
    out.record(
      childPath,
      result.rule,
      `Replaced this definition with one that accepts nothing, because the rewrite it needed could not be made where it is used.`,
      true,
    );
    return unsatisfiable();
  });

  if (!poisoned) return rebuilt;
  if (ctx.polarity !== 'positive') return poisoned;

  out.rollback(mark);
  out.record(
    ctx.path,
    poisoned.rule,
    `Replaced this schema with one that accepts nothing, because the rewrite it needed sits where making a schema stricter does not make the schema around it stricter, and applying it there would have allowed values the original rejected.`,
    true,
  );
  return unsatisfiable();
}

export interface Rewriters {
  /** Runs before the children, so it can take away what makes a position tricky. */
  before?: NodeRewriter;
  /** Runs after the children have been rewritten. */
  after?: NodeRewriter;
}

/** Walk the whole schema, rewriting every subschema the position allows. */
export function transform(schema: JSONSchema, out: Recorder, rewriters: Rewriters): JSONSchema {
  return withDefinitionRetry(schema, out, (plan) => {
    const visit: Visitor = (node, ctx) => {
      if (!isSchemaObject(node)) return node;

      // On the second run, a reference reaching a rewritten definition from a
      // flipped position is the thing that has to give.
      if (ctx.polarity !== 'positive' && pointsAtTroubled(node['$ref'], plan)) {
        return poison(RULES.refInFlippedPosition);
      }

      let current: JSONSchema = node;
      if (rewriters.before) {
        const early = rewriters.before(node, ctx);
        if (isPoison(early)) return early;
        if (!isSchemaObject(early)) return early;
        current = early;
      }

      const rebuilt = mapChildrenPolar(current, ctx, out, plan, visit);
      if (isPoison(rebuilt) || !isSchemaObject(rebuilt)) return rebuilt;
      return rewriters.after ? rewriters.after(rebuilt, ctx) : rebuilt;
    };

    const result = visit(schema, { path: '', polarity: 'positive', depth: 0 });
    // The root is always in an ordinary position, so nothing escapes unabsorbed.
    return isPoison(result) ? unsatisfiable() : result;
  });
}
