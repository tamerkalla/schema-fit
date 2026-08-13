/** Stable rule ids, shared by `check` (as violations) and `fit` (as changes). */
export const RULES = {
  unknownKeyword: 'unknown-keyword',
  noRef: 'no-ref',
  refSiblings: 'ref-siblings',
  unresolvableRef: 'unresolvable-ref',
  externalRef: 'external-ref',
  noDefs: 'no-defs',
  rootMustBeObject: 'root-must-be-object',
  noOneOf: 'no-oneof',
  noAnyOf: 'no-anyof',
  noAllOf: 'no-allof',
  noNot: 'no-not',
  noEnum: 'no-enum',
  noConst: 'no-const',
  noPatternProperties: 'no-pattern-properties',
  noTupleItems: 'no-tuple-items',
  noAdditionalItems: 'no-additional-items',
  noFormat: 'no-format',
  noNumericBounds: 'no-numeric-bounds',
  noStringBounds: 'no-string-bounds',
  noArrayBounds: 'no-array-bounds',
  noDefaults: 'no-defaults',
  noNullableViaType: 'no-nullable-via-type',
  additionalPropertiesMustBeFalse: 'additional-properties-must-be-false',
  propertyMustBeRequired: 'property-must-be-required',
  maxProperties: 'max-properties',
  maxDepth: 'max-depth',
  /** Only `fit` reports these two: they are ways out, not profile violations. */
  refInFlippedPosition: 'ref-in-flipped-position',
  unreachableProperty: 'unreachable-property',
} as const;

export type RuleId = (typeof RULES)[keyof typeof RULES];

export const NUMERIC_BOUND_KEYWORDS = [
  'multipleOf',
  'maximum',
  'exclusiveMaximum',
  'minimum',
  'exclusiveMinimum',
] as const;

export const STRING_BOUND_KEYWORDS = ['maxLength', 'minLength', 'pattern'] as const;

export const ARRAY_BOUND_KEYWORDS = ['maxItems', 'minItems', 'uniqueItems'] as const;
