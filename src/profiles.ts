import type { Profile } from './types.js';

/*
 * Every field below is sourced from the provider's published documentation, and
 * the documentation URL is cited above each profile. Fields the documentation
 * does not state outright carry a `// unverified` comment and take the
 * conservative value — conservative meaning "the choice that cannot make `fit`
 * hand back a schema that accepts more than the original", which is what the
 * soundness guarantee is made of.
 *
 * Provider docs move. If a profile is wrong for the version of the API you are
 * calling, a Profile is a plain object: copy one, change the field, pass it in.
 */

/**
 * OpenAI — Structured Outputs / strict function calling.
 * https://platform.openai.com/docs/guides/structured-outputs#supported-schemas
 * https://platform.openai.com/docs/guides/function-calling#strict-mode
 */
export const openaiStrict: Profile = {
  id: 'openai-strict',
  // "The root level object of a schema must be an object."
  rootMustBeObject: true,
  // "additionalProperties: false must always be set in objects."
  additionalPropertiesMustBeFalse: true,
  // "All fields must be required."
  allPropertiesMustBeRequired: true,
  // "$defs" and "$ref" (including recursive schemas) are documented as supported.
  refs: 'internal',
  supports: {
    oneOf: false, // documented supported composition keyword is anyOf only
    anyOf: true,
    allOf: false, // not listed among supported keywords
    not: false, // not listed among supported keywords
    enum: true,
    const: false, // unverified — not listed among supported keywords
    patternProperties: false, // not listed among supported keywords
    additionalItems: false, // not listed among supported keywords
    tupleItems: false, // prefixItems is not listed among supported keywords
    // Documented supported string formats.
    formats: ['date-time', 'time', 'date', 'duration', 'email', 'hostname', 'ipv4', 'ipv6', 'uuid'],
    // Documented: multipleOf, maximum, minimum, exclusiveMaximum, exclusiveMinimum.
    numericBounds: true,
    // Documented: pattern, format, minLength, maxLength.
    stringBounds: true,
    // Documented: minItems, maxItems. uniqueItems is not documented, but this
    // profile field covers all three at once and dropping a bound is the one
    // rewrite that can widen a schema, so the group stays on. See README.
    arrayBounds: true,
    defaults: false, // unverified — "default" is not listed among supported keywords
    // "To denote an optional field, use a union type with null."
    nullableViaType: true,
  },
  // "A schema may have up to 5000 object properties total, with up to 10 levels
  // of nesting." Applied here per object schema, which is the strictest reading.
  maxDepth: 10,
  maxProperties: 5000,
  unknownKeywords: 'strip',
};

/**
 * Anthropic — tool `input_schema`.
 * https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/overview
 * https://docs.anthropic.com/en/api/messages#body-tools
 *
 * The documentation describes `input_schema` as a JSON Schema object and does
 * not name a rejected subset, so nearly everything stays on. This profile is
 * mostly a lint: it enforces the one documented requirement (object root) and
 * otherwise leaves your schema alone.
 */
export const anthropic: Profile = {
  id: 'anthropic',
  // "input_schema: [JSON schema] for this tool's input... type must be 'object'."
  rootMustBeObject: true,
  additionalPropertiesMustBeFalse: false,
  allPropertiesMustBeRequired: false,
  refs: 'internal', // unverified — internal $ref is not documented as rejected
  supports: {
    oneOf: true, // unverified
    anyOf: true, // unverified
    allOf: true, // unverified
    not: true, // unverified
    enum: true,
    const: true, // unverified
    patternProperties: true, // unverified
    additionalItems: true, // unverified
    tupleItems: true, // unverified
    formats: 'all', // unverified
    numericBounds: true, // unverified
    stringBounds: true, // unverified
    arrayBounds: true, // unverified
    defaults: true, // unverified
    nullableViaType: true, // unverified
  },
  maxDepth: null, // unverified — no documented nesting limit
  maxProperties: null, // unverified — no documented property-count limit
  unknownKeywords: 'keep',
};

/**
 * Google Gemini — `responseSchema` and function-declaration parameters, which
 * take an OpenAPI 3.0 Schema object rather than JSON Schema.
 * https://ai.google.dev/gemini-api/docs/structured-output
 * https://ai.google.dev/api/caching#Schema
 */
export const gemini: Profile = {
  id: 'gemini',
  // Non-object response schemas (arrays, strings, enums) are documented.
  rootMustBeObject: false,
  // The Schema object has no additionalProperties field.
  additionalPropertiesMustBeFalse: false,
  allPropertiesMustBeRequired: false,
  refs: 'none', // unverified — the documented Schema fields do not include $ref
  supports: {
    oneOf: false, // the Schema object documents anyOf only
    anyOf: true,
    allOf: false, // not a documented Schema field
    not: false, // not a documented Schema field
    enum: true,
    const: false, // not a documented Schema field
    patternProperties: false, // not a documented Schema field
    additionalItems: false, // not a documented Schema field
    tupleItems: false, // items is a single Schema, not a list
    // Documented format values: string date-time/date/time/duration/enum,
    // number float/double, integer int32/int64.
    formats: ['date-time', 'date', 'time', 'duration', 'enum', 'float', 'double', 'int32', 'int64'],
    // Documented Schema fields: minimum, maximum.
    numericBounds: true,
    // Documented Schema fields: minLength, maxLength, pattern.
    stringBounds: true,
    // Documented Schema fields: minItems, maxItems. uniqueItems is not a Schema
    // field; see the note on the OpenAI profile for why the group stays on.
    arrayBounds: true,
    // "default" is a documented Schema field.
    defaults: true,
    // type is a single enum value; nullability is expressed with `nullable`.
    nullableViaType: false,
  },
  maxDepth: null, // unverified — no documented nesting limit
  maxProperties: null, // unverified — no documented property-count limit
  unknownKeywords: 'strip',
};

export const profiles = {
  openaiStrict,
  anthropic,
  gemini,
} as const;
