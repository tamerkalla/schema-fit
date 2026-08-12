# Outreach drafts

Two issues, written against the code as it stood on 2026-08-12 and ready to
post. Every claim below was checked against the files linked, at the commits
linked. Re-check the permalinks before posting if time has passed — these
modules move.

**Posting is not done.** This session can read public repositories but cannot be
given write credentials for them, so opening the issues is a step for someone
with a GitHub account. Post the issue; do not open a PR first.

---

## 1. Vercel AI SDK — `vercel/ai`

**Title:** Gemini schema conversion silently drops constraints, widening the
schema the model is held to

The Gemini converter destructures a fixed list of keywords and builds the
OpenAPI schema from scratch:

https://github.com/vercel/ai/blob/f9d847d90a6e13410534b8a00cdfd6c03f564075/packages/google/src/convert-json-schema-to-openapi-schema.ts#L34-L47

```ts
const {
  type, description, required, properties, items,
  allOf, anyOf, oneOf, format, const: constValue, minLength, enum: enumValues,
} = jsonSchema;
```

Everything outside that list is dropped on the floor. Among the casualties:
`minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `multipleOf`,
`maxLength`, `pattern`, `minItems`, `maxItems`, `uniqueItems`, `not`,
`additionalProperties`, `patternProperties`, `propertyNames`.

Each of those makes the schema the model is constrained by **wider** than the
schema the developer wrote. A tool declaring `{ type: 'integer', minimum: 1 }`
is sent to Gemini as `{ type: 'integer' }`, the model may return `0`, the
request succeeds, the JSON parses, and the tool implementation receives a value
its own schema rejects. Nothing fails on the way in — the mismatch surfaces
wherever that `0` eventually matters.

Worth noting separately: Gemini's `Schema` **does** document `minimum`,
`maximum`, `minLength`, `maxLength`, `pattern`, `minItems` and `maxItems`, so
most of these are being dropped without needing to be.

There is also a smaller one just above:

https://github.com/vercel/ai/blob/f9d847d90a6e13410534b8a00cdfd6c03f564075/packages/google/src/convert-json-schema-to-openapi-schema.ts#L30-L32

```ts
if (typeof jsonSchema === 'boolean') {
  return { type: 'boolean', properties: {} };
}
```

A boolean *schema* is not a schema of booleans. `false` accepts no instance at
all and comes out as "any boolean"; `true` accepts every instance and comes out
as "any boolean" too. The first widens, the second narrows.

### What I would suggest

The useful invariant is one-directional, and it is worth stating out loud
wherever a conversion like this happens:

```
validate(converted, i)  ⟹  validate(original, i)
```

Anything the converted schema accepts, the original accepts. The converse
cannot hold — providers reject different subsets of JSON Schema, so something
has to give — but the direction can, and it is the direction that keeps a tool's
implementation safe. Losing the other direction is loud: a request that would
have worked gets refused, in testing, with the value in hand.

I wrote [schema-fit](https://github.com/tamerkalla/schema-fit) around exactly
that: zero runtime dependencies, draft 2020-12, providers as plain data objects
so adding one never touches the rewrite engine. It returns a list of every
rewrite it made, with `narrowing: true` on the ones that cost something, so
nothing is dropped quietly.

Happy to send a PR wiring it into the provider packages, or to leave it as a
reference if you would rather fix the conversions in place. Either way, the part
worth stealing is the property test: generate schemas, generate instances from
the *converted* schema, and assert the implication through `ajv`. It found four
soundness bugs in my own rewriter, every one of which read as obviously correct
code — including that `oneOf` → `anyOf` is unsound whenever two options can
overlap, and that any rewrite inside a `not` runs in the opposite direction.

---

## 2. LangChain.js — `langchain-ai/langchainjs`

**Title:** `removeAdditionalProperties` turns a closed object into an open one
before sending it to Gemini

https://github.com/langchain-ai/langchainjs/blob/b0a61cf9853b0614c9b62faefc8615ca26399419/libs/providers/langchain-google-genai/src/utils/zod_to_genai_parameters.ts#L28-L52

```ts
if ("additionalProperties" in newObj) {
  delete newObj.additionalProperties;
}
```

Gemini's `Schema` has no `additionalProperties` field, so it does have to go —
but deleting it is not a neutral edit. A tool schema carrying
`additionalProperties: false` says "these properties and nothing else". After
the delete, the schema the model is constrained by accepts any extra property
at all, and the tool implementation is handed an object shape it was not written
for. The request succeeds; nothing rejects it.

The same function runs recursively, so every nested object in the tool's schema
loses the same guard.

Dropping it is the right call for a provider that cannot express it — what is
missing is that this is a *widening*, and that it is currently invisible to the
caller. Two things would help, in order of cost:

1. Say so. A one-line note in the docstring, or a debug log listing what was
   dropped, so someone debugging a surprise payload has a thread to pull.
2. Keep the original schema as the thing responses are validated against, rather
   than the converted one.

### The general shape

Every provider integration reshapes a tool's JSON Schema, and every reshape is
lossy in one of two directions. If the result is *stricter*, a call that would
have worked gets refused — annoying, and loud. If the result is *looser*, the
model can produce a value the tool's own schema rejects, and the failure is
silent and lands far from its cause. Only the first is safe to accept quietly.

[schema-fit](https://github.com/tamerkalla/schema-fit) does this conversion with
the direction pinned: whatever the converted schema accepts, the original
accepts, and every rewrite that costs something comes back in a `changes` list.
It also ships `check()`, which reports what a provider will object to without
rewriting anything — that alone might be useful as a test-time assertion over
the integration suite, independently of whether you adopt the rewriter.

I am not asking you to take a dependency. If the guarantee is useful I will send
a PR; if the right move is to fix the conversions in place, the case above is
the one to write a test for first.
