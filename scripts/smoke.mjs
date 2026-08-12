// Loads the built ESM entry point and exercises the whole public API.
import assert from 'node:assert/strict';
import { check, fit, profiles, UnfittableSchemaError } from '../dist/index.js';

import { run } from './smoke-cases.mjs';

run({ check, fit, profiles, UnfittableSchemaError }, 'esm');
assert.equal(typeof check, 'function');
console.log('smoke: esm ok');
