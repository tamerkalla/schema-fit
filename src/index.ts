export { check } from './check.js';
export { fit } from './fit.js';
export { profiles } from './profiles.js';

/**
 * `UnfittableSchemaError` is exported so you can catch it by identity. It is the
 * only error either function throws.
 */
export { UnfittableSchemaError } from './types.js';

export type {
  Change,
  CheckResult,
  FitResult,
  JSONSchema,
  JSONSchemaObject,
  Profile,
  Violation,
} from './types.js';
