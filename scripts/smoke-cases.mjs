import assert from 'node:assert/strict';

const toolSchema = {
  type: 'object',
  properties: {
    query: { type: 'string', minLength: 1, description: 'what to search for' },
    limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
    filter: {
      oneOf: [
        { type: 'object', properties: { kind: { const: 'author' }, name: { type: 'string' } }, required: ['kind', 'name'] },
        { type: 'object', properties: { kind: { const: 'year' }, year: { type: 'integer' } }, required: ['kind', 'year'] },
      ],
    },
  },
  required: ['query'],
  'x-vendor-extension': true,
};

const recursive = {
  $defs: { node: { type: 'object', properties: { next: { $ref: '#/$defs/node' } } } },
  type: 'object',
  properties: { root: { $ref: '#/$defs/node' } },
};

export function run({ check, fit, profiles, UnfittableSchemaError }, flavour) {
  assert.deepEqual(Object.keys(profiles).sort(), ['anthropic', 'gemini', 'openaiStrict']);

  for (const [name, profile] of Object.entries(profiles)) {
    const before = check(toolSchema, profile);
    assert.equal(typeof before.ok, 'boolean');
    for (const violation of before.violations) {
      assert.equal(typeof violation.path, 'string');
      assert.equal(typeof violation.rule, 'string');
      assert.ok(violation.message.length > 0);
    }

    const result = fit(toolSchema, profile);
    assert.ok(check(result.schema, profile).ok, `${flavour}: ${name} did not conform after fitting`);
    assert.equal(result.lossless, result.changes.every((change) => !change.narrowing));
    assert.deepEqual(fit(result.schema, profile).changes, [], `${flavour}: ${name} is not idempotent`);

    // The input is untouched.
    assert.equal(toolSchema['x-vendor-extension'], true);

    console.log(
      `smoke: ${flavour} ${name}: ${before.violations.length} violations, ${result.changes.length} changes, lossless=${result.lossless}`,
    );
  }

  // The one documented throw.
  assert.throws(() => fit(recursive, profiles.gemini), UnfittableSchemaError);
  assert.ok(check(fit(recursive, profiles.openaiStrict).schema, profiles.openaiStrict).ok);
}
