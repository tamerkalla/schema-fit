# schema-fit

Rewrite a JSON Schema so a specific LLM provider will accept it — without ever
widening what the schema allows.

Zero runtime dependencies. TypeScript, ES2022, dual ESM/CJS. Draft 2020-12 only.

```bash
npm install schema-fit
```

## The guarantee

> If `fit(S, P).schema` accepts an instance, `S` accepts it too.

Formally, for every schema `S`, profile `P`, and instance `i`:

```
validate(fit(S, P).schema, i)  ⟹  validate(S, i)
```

**Soundness only. The converse does not hold and is not claimed.** A fitted
schema may reject instances the original accepted — that is exactly what
`narrowing: true` records on a change, and what `lossless: false` summarises.

The asymmetry is the point. Providers reject different, undocumented subsets of
JSON Schema, so *something* has to give. What must never give is the direction:
if the model returns a value your fitted schema accepts, your original schema
accepts it too, and the code behind your tool can trust its own types. Anything
the fitted schema turns away, you find out about in `changes` — before you ship,
not from a support ticket.

This is why `fit` sometimes hands back a schema that accepts nothing at all. When
a rewrite cannot be written any other way, "accepts nothing" is the only answer
that keeps the implication true, and it is always recorded as narrowing. See
[Where fit gives up](#where-fit-gives-up).

## Usage

```ts
import { check, fit, profiles } from 'schema-fit';

const schema = {
  type: 'object',
  properties: {
    query: { type: 'string', minLength: 1 },
    limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
  },
  required: ['query'],
};

check(schema, profiles.openaiStrict);
// {
//   ok: false,
//   violations: [
//     { path: '/additionalProperties', rule: 'additional-properties-must-be-false', message: '…' },
//     { path: '/properties/limit', rule: 'property-must-be-required', message: '…' },
//     { path: '/properties/limit/default', rule: 'no-defaults', message: '…' },
//   ],
// }

const { schema: fitted, changes, lossless } = fit(schema, profiles.openaiStrict);
// fitted:  { …, required: ['query', 'limit'], additionalProperties: false }
// lossless: false — `limit` is now required, which rejects calls that omitted it
```

`check` tells you what a provider will object to. `fit` rewrites it and tells you
what that cost. Neither mutates its input; both are pure and deterministic.

## API

Three functions, one error class, and the types.

```ts
function check(schema: JSONSchema, profile: Profile): CheckResult;
function fit(schema: JSONSchema, profile: Profile): FitResult;
const profiles: { openaiStrict: Profile; anthropic: Profile; gemini: Profile };
class UnfittableSchemaError extends Error { readonly path: string }
```

```ts
interface CheckResult {
  ok: boolean;
  violations: Violation[];  // sorted by path, then rule
}

interface Violation {
  path: string;     // RFC 6901 JSON Pointer into the schema
  rule: string;     // stable id, e.g. 'no-oneof'
  message: string;  // one sentence, plain English
}

interface FitResult {
  schema: JSONSchema;  // conforms to the profile
  changes: Change[];   // every rewrite performed, in order
  lossless: boolean;   // changes.every(c => !c.narrowing)
}

interface Change {
  path: string;
  rule: string;
  message: string;
  narrowing: boolean;  // true when this rewrite rejects instances the original accepted
}
```

### `UnfittableSchemaError`

The **only** condition under which either function throws: the profile forbids
`$ref`, and the schema references itself. Inlining a cycle never finishes, and
there is no sound stand-in, so `fit` refuses rather than guess.

```ts
try {
  fit(recursiveSchema, profiles.gemini);
} catch (error) {
  if (error instanceof UnfittableSchemaError) {
    console.error(`cannot inline the reference at ${error.path}`);
  }
}
```

Every other situation produces a schema and a change list. A profile that allows
internal `$ref` (OpenAI, Anthropic) never throws, because the cycle can stay.

## Profiles are data

A profile is a plain object. Adding a provider never means touching the rewrite
engine — copy the nearest one, change the fields, pass it in.

```ts
import { profiles, fit } from 'schema-fit';

const myProvider = {
  ...profiles.openaiStrict,
  id: 'my-provider',
  supports: { ...profiles.openaiStrict.supports, anyOf: false },
};

fit(schema, myProvider);
```

Every field on the shipped three is sourced from provider documentation, cited in
a comment above each profile in [`src/profiles.ts`](src/profiles.ts). Fields the
documentation does not state are marked `// unverified` and take the conservative
value — the one that cannot make `fit` hand back a schema wider than the original.

## Compatibility matrix

What the three shipped profiles accept. `—` means unsupported, so `fit` rewrites
it away.

| | `openaiStrict` | `anthropic` | `gemini` |
|---|---|---|---|
| Root must be an object | yes | yes | no |
| `additionalProperties: false` required | yes | no | no |
| Every property required | yes | no | no |
| `$ref` | internal | internal | — (inlined) |
| `oneOf` | — | yes | — |
| `anyOf` | yes | yes | yes |
| `allOf` | — | yes | — |
| `not` | — | yes | — |
| `enum` | yes | yes | yes |
| `const` | — | yes | — |
| `patternProperties` | — | yes | — |
| Tuple `prefixItems` | — | yes | — |
| `additionalItems` | — | yes | — |
| `format` | 9 values | all | 9 values |
| Number bounds | yes | yes | yes |
| String bounds | yes | yes | yes |
| Array bounds | yes | yes | yes |
| `default` | — | yes | yes |
| `type: ['string','null']` | yes | yes | — |
| Max nesting | 10 | none | none |
| Max properties per object | 5000 | none | none |
| Unknown keywords | stripped | kept | stripped |

## What the rules do

Applied in this order. Every rule records a `Change`; the ones that can reject
instances the original accepted are marked.

| # | Rule | Narrowing? |
|---|---|---|
| 1 | Strip keywords the profile does not know | no — draft 2020-12 ignores them anyway |
| 2 | Inline `$ref` as the profile requires | no, unless the inlined pieces cannot be merged |
| 3 | Force an object root | yes, unless the root was already objects-only |
| 4 | Replace unsupported combinators | see below |
| 5 | Drop or fold unsupported constraints | see below |
| 6 | Set `additionalProperties: false` | yes |
| 7 | Add every property to `required` | yes |
| 8 | Trim objects past the property limit | yes |
| 9 | Cut everything past the nesting limit | yes |
| 10 | Collapse a list of types to one type | yes, unless the list held one type |

Combinators, in order of preference:

- `oneOf` → `anyOf` when the options provably cannot overlap. Exact.
- `oneOf` → `anyOf` of each option ruling out the others, when the profile has
  `allOf` and `not`. Exact.
- `oneOf` → the one option that cannot overlap the others. Narrowing.
- `oneOf` → a schema accepting nothing, when no option is safe to keep.
- `anyOf` → its first option. Narrowing.
- `allOf` → the merge of its pieces. Exact when they can be merged.
- `not` → the types or values it left over. Exact when it negates only a type or
  a set of values; otherwise a schema accepting nothing.

Constraints:

- An unhonoured `format` is dropped — draft 2020-12 treats `format` as an
  annotation, so this changes nothing about which values are valid.
- `patternProperties` is folded into the properties it applied to, and the object
  is closed so the patterns cannot match anything else.
- Tuple `prefixItems` become one `items` schema that every item must satisfy.
- `enum` becomes `const` and back, whichever the profile has.
- `default` and `additionalItems` are dropped; neither decides which values are
  valid in draft 2020-12.

## Where `fit` gives up

Three situations have no sound rewrite, and all three produce a schema that
accepts nothing — recorded as narrowing, never as a silent widening:

1. **Overlapping `oneOf` options** with no `anyOf`, `allOf`, or `not` to express
   them. Keeping any single option would accept values matching two options,
   which `oneOf` rejects.
2. **`allOf` pieces that cannot be merged** — two different `pattern`s, say.
   Dropping either one would accept strings the original rejected.
3. **A rewrite needed inside a `not`, an `if`, or a `oneOf` option.** In those
   positions, making a subschema stricter makes the schema *around* it looser.
   Rather than apply the rewrite there, `fit` replaces the enclosing schema.

Nesting past the profile's limit does the same thing to the subtree below it.

If a fitted schema comes back accepting nothing, `changes` says exactly which
rule did it and where.

## Optional properties, and the null trick we do not use

OpenAI's documentation suggests emulating an optional field with a union type:
make the field required, and let the model send `null` to mean "absent".

`schema-fit` does not do that, because it is not sound. Given
`{ properties: { a: { type: 'string' } }, required: [] }`, the original accepts
`{}` and `{"a": "x"}` and rejects `{"a": null}`. Rewriting it to
`{ properties: { a: { type: ['string','null'] } }, required: ['a'] }` accepts
`{"a": null}` — a value the original turns away, which your code was never
written to receive.

So `fit` makes the property required and stops there. That rejects `{}`, which is
a real loss, and it is reported: `narrowing: true`, `lossless: false`. If the
null convention is what you want, it is a decision about your own schema, and the
place to make it is your schema — then `fit` will carry it through untouched.

## What a profile cannot say

A `Profile` has a field for every keyword group it can talk about, and no others.
Keywords outside that list — `if`/`then`/`else`, `contains`, `propertyNames`,
`dependentSchemas`, `dependentRequired`, `unevaluatedProperties`,
`unevaluatedItems`, `$schema`, `$id` — are carried through untouched, because
there is no field to consult and dropping them would widen the schema.

If your provider rejects one of those, `check` will not warn you and `fit` will
not remove it. `fit` still handles them correctly where they affect soundness:
a subschema under `if` is a position where rewrites are refused, exactly like one
under `not`.

## The one place a fitted schema can be wider

A profile that turns off `numericBounds`, `stringBounds`, or `arrayBounds` is
saying the provider ignores those keywords. `fit` drops them, because keeping
them means a rejected request. The fitted schema is then genuinely wider than the
original, and the guarantee holds only in the sense that matters — the provider
was never going to enforce them anyway.

**None of the three shipped profiles turns those groups off.** If you write a
profile that does, keep validating responses against your original schema, which
is the source of truth either way.

## Tests

The four properties that hold the guarantee up, in
[`test/property.test.ts`](test/property.test.ts), driven by `fast-check` over a
generator of draft 2020-12 schemas:

1. **Soundness** — instances from `json-schema-faker` and arbitrary JSON, run
   through `ajv` against both schemas: whatever the fitted schema accepts, the
   original accepts.
2. **Conformance** — `check(fit(S, P).schema, P).ok` is always `true`.
3. **Idempotence** — fitting a fitted schema changes nothing.
4. **Identity** — a schema that already conforms comes back untouched.

Plus purity (deep-frozen inputs) and determinism (stable ordering, repeatable
results). Every rule is table-tested per profile in
[`test/check.test.ts`](test/check.test.ts) and
[`test/fit.test.ts`](test/fit.test.ts), asserting whole arrays. The positions
where a rewrite would run the wrong way have their own file,
[`test/polarity.test.ts`](test/polarity.test.ts), and the merge engine has
[`test/intersect.test.ts`](test/intersect.test.ts) — what merges exactly, and
what cannot be written as one schema.

```bash
npm test
npm run typecheck
npm run build
npm run smoke      # loads both ESM and CJS builds
npm run mutation   # Stryker, threshold 85%
```

Property runs default to 200 per property; `SCHEMA_FIT_RUNS=25000 npm test`
turns it up.

## Out of scope

No other draft. No remote or file `$ref`. No runtime dependency. No code
generation. No instance validation — that is `ajv`'s job, and it stays a dev
dependency here. No CLI.

## License

MIT
