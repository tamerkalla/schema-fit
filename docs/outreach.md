# Outreach drafts

Two issues, ready to send. **Before posting either one, open the repository and
replace the `<link>` placeholder with a permalink to the conversion code as it
stands today** — these modules get moved and renamed, and an issue pointing at a
stale path reads as noise. Post the issue; do not open a PR first.

The order matters: post, wait for a maintainer to say whether they want it, and
only then offer a patch.

---

## 1. Vercel AI SDK — `vercel/ai`

**Title:** Provider schema conversion has no soundness check — a rewritten tool
schema can accept values the original rejects

Each provider package converts a tool's JSON Schema into the shape that provider
accepts: dropping keywords, closing objects, flattening unions. <link>

The conversions are all reasonable in isolation, and a few of them can widen the
schema — accept values the author's original schema rejects. The one I would look
at first is any `oneOf` → `anyOf` rewrite: `oneOf` means *exactly* one branch
matches and `anyOf` means *at least* one, so the rename accepts every instance
matching two branches. Instances the author's schema turns away reach the code
behind the tool, and nothing rejected them on the way in.

The same shape shows up in a couple of other places worth auditing:

- Dropping a keyword under a `not` makes the negated schema looser, so the schema
  around it gets *stricter or looser depending on the nesting depth* — the
  direction flips.
- Making an optional property required with a `["string","null"]` union accepts
  `{"field": null}`, which the original schema rejects.

I wrote [schema-fit](https://github.com/tamerkalla/schema-fit) for this. It is a
zero-dependency TypeScript library with one guarantee: if the fitted schema
accepts an instance, the original accepts it too. Never the converse — every
rewrite that rejects something the original allowed is returned in a `changes`
list with `narrowing: true`, so nothing is lost quietly. Providers are plain data
objects, so adding one does not touch the rewrite engine.

Happy to send a PR wiring it into the provider packages, or to leave it as a
reference for a fix you would rather write yourselves — whichever is more useful.
Either way the property test in that repo is the part worth stealing: generate
schemas, generate instances from the *rewritten* schema, and assert the
implication through `ajv`. It found three bugs in my own rewriter that read as
obviously correct code.

---

## 2. LangChain.js — `langchain-ai/langchainjs`

**Title:** Tool schema conversion for provider-specific formats can widen the
schema

The provider integrations each reshape a tool's JSON Schema before sending it —
stripping `additionalProperties`, converting to the OpenAPI subset Gemini takes,
adjusting `required`. <link>

Those rewrites are lossy in both directions, and only one direction is safe. If a
rewrite makes the schema *stricter*, a call that would have worked gets refused —
annoying, and loud. If it makes the schema *looser*, the model can produce a value
the tool's own schema rejects, the request succeeds, and the tool implementation
receives a shape it was not written for. That failure is silent and lands far from
its cause.

Two concrete cases to check:

- `oneOf` rewritten as `anyOf` accepts instances matching more than one branch,
  which `oneOf` rejects.
- Optional properties made required with a null union accept `null` where the
  original accepted absence — different values.

[schema-fit](https://github.com/tamerkalla/schema-fit) does this conversion with
the one-directional guarantee attached: whatever the fitted schema accepts, the
original accepts. Zero runtime dependencies, draft 2020-12, providers as data. It
also ships `check()`, which reports what a provider will object to without
rewriting anything — that alone might be useful as a test-time assertion over the
integration suite, independently of whether you adopt the rewriter.

I am not asking you to take a dependency. If the guarantee is useful, I will send
a PR; if the right move is to fix the conversions in place, the counterexamples
above are the ones to write tests for first.
