// Loads the built CJS entry point and exercises the whole public API.
const assert = require('node:assert/strict');
const { check, fit, profiles, UnfittableSchemaError } = require('../dist/index.cjs');

(async () => {
  const { run } = await import('./smoke-cases.mjs');
  run({ check, fit, profiles, UnfittableSchemaError }, 'cjs');
  assert.equal(typeof fit, 'function');
  console.log('smoke: cjs ok');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
