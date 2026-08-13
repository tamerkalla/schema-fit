# Changelog

## 0.1.3

- The release workflow now tags the commit it published and cuts a GitHub
  release from the changelog entry, instead of only being *triggered* by a tag
  someone pushed by hand. Releases 0.1.0 through 0.1.2 are untagged for that
  reason; they were published from `50bd734` (0.1.1) and `6aba240` (0.1.2).
- It also checks its own preconditions before signing anything — the
  `repository` field provenance validates against, an npm new enough for
  trusted publishing, and a version that is not already on the registry — and
  afterwards installs the published package from the registry and loads both
  entry points.

No change to the library itself.

## 0.1.2

- **Fixed:** a profile that requires every property turned a self-referential
  schema into one that accepts nothing. Requiring `next` at every level of
  `{"next": {"$ref": "#"}}` leaves no finite instance, so `fit` now drops the
  property instead — it was optional, so an object without it is one the
  original accepts. Recursion that ends in an empty array is untouched.
  Reported as the new `unreachable-property` rule.
- Soundness could not catch this: a schema that accepts nothing accepts nothing
  the original rejects. Two properties now cover the other direction — a
  lossless fit loses no instance, and a fit of a satisfiable schema still
  accepts something.
- The README now names the assumption the guarantee rests on: `format` is an
  annotation in draft 2020-12, so dropping one changes nothing *unless* you
  validate with the format-assertion vocabulary, as `ajv-formats` does.

## 0.1.1

- `package.json` now points at the repository, which npm requires before it will
  accept a provenance statement. Without it the 0.1.0 publish was refused with
  `422 ... "repository.url" is ""` after the statement had already been signed.
- Releases publish through npm's trusted publishing rather than a token.

No change to the library itself.

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
