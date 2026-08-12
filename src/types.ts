/**
 * A JSON Schema (draft 2020-12). Booleans are schemas too: `true` accepts every
 * instance, `false` accepts none.
 */
export type JSONSchema = boolean | JSONSchemaObject;

export interface JSONSchemaObject {
  [keyword: string]: unknown;
}

/**
 * A provider's accepted subset of JSON Schema, expressed as data.
 *
 * Adding a provider means adding one of these. It never means touching the
 * rewrite engine.
 */
export interface Profile {
  id: string;
  /** The root schema must be `{"type": "object", ...}`. */
  rootMustBeObject: boolean;
  /** Every object schema must carry `additionalProperties: false`. */
  additionalPropertiesMustBeFalse: boolean;
  /** Every declared property must be listed in `required`. */
  allPropertiesMustBeRequired: boolean;
  /**
   * `'none'` — no `$ref` at all; every internal reference is inlined.
   * `'internal'` — `#/...` references are kept as written.
   * `'internal-no-siblings'` — `#/...` references are kept only when `$ref` is
   * the sole validation keyword in its schema object.
   */
  refs: 'none' | 'internal' | 'internal-no-siblings';
  supports: {
    oneOf: boolean;
    anyOf: boolean;
    allOf: boolean;
    not: boolean;
    enum: boolean;
    const: boolean;
    patternProperties: boolean;
    additionalItems: boolean;
    tupleItems: boolean;
    /** `format` values honoured, or `'all'` for every value. */
    formats: string[] | 'all';
    /** `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `multipleOf`. */
    numericBounds: boolean;
    /** `minLength`, `maxLength`, `pattern`. */
    stringBounds: boolean;
    /** `minItems`, `maxItems`, `uniqueItems`. */
    arrayBounds: boolean;
    /** `default`. */
    defaults: boolean;
    /** `type: ['string', 'null']` is accepted. */
    nullableViaType: boolean;
  };
  /** Deepest allowed instance nesting level, or `null` for no limit. */
  maxDepth: number | null;
  /** Most properties allowed on a single object schema, or `null` for no limit. */
  maxProperties: number | null;
  unknownKeywords: 'keep' | 'strip';
}

export interface Violation {
  /** RFC 6901 JSON Pointer into the schema. */
  path: string;
  /** Stable machine-readable id, e.g. `'no-oneof'`. */
  rule: string;
  /** One sentence, plain English. */
  message: string;
}

export interface CheckResult {
  ok: boolean;
  /** Sorted by `path`, then `rule`. */
  violations: Violation[];
}

export interface Change {
  path: string;
  rule: string;
  message: string;
  /** True when this change rejects instances the original accepted. */
  narrowing: boolean;
}

export interface FitResult {
  /** A schema that conforms to the profile. */
  schema: JSONSchema;
  /** Every rewrite performed, in the order it was performed. */
  changes: Change[];
  /** `changes.every(c => !c.narrowing)`. */
  lossless: boolean;
}

/**
 * Thrown by {@link fit} when a schema cannot be rewritten without breaking the
 * soundness guarantee — that is, when a recursive `$ref` has to be inlined
 * (because the profile forbids `$ref`) but inlining it would never terminate.
 *
 * This is the only condition under which `check` or `fit` throws.
 */
export class UnfittableSchemaError extends Error {
  /** RFC 6901 JSON Pointer to the `$ref` that could not be inlined. */
  readonly path: string;

  constructor(path: string, message?: string) {
    super(
      message ??
        `The reference at ${path || '/'} points back at a schema that contains it, so it cannot be inlined. This profile does not allow $ref, and inlining a cycle would never finish.`,
    );
    this.name = 'UnfittableSchemaError';
    this.path = path;
    Object.setPrototypeOf(this, UnfittableSchemaError.prototype);
  }
}
