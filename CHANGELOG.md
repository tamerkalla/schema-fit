# Changelog

## 0.1.0

First release.

- `check(schema, profile)` reports every place a schema steps outside a
  provider's accepted subset of JSON Schema, as sorted RFC 6901 pointers with
  stable rule ids.
- `fit(schema, profile)` rewrites the schema to conform, and returns the list of
  what that cost. The guarantee is one-directional: if the fitted schema accepts
  an instance, the original accepts it too. Every rewrite that rejects instances
  the original accepted is recorded with `narrowing: true`.
- Three profiles — `openaiStrict`, `anthropic`, `gemini` — as plain data, each
  field cited to provider documentation or marked unverified.
- `UnfittableSchemaError` for the single case that cannot be rewritten at all: a
  recursive `$ref` under a profile that forbids references.
- Draft 2020-12 only. Zero runtime dependencies. Dual ESM/CJS with types.
