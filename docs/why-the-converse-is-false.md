# The interesting half of a schema rewriter is the half it refuses to do

Every LLM provider takes a JSON Schema for your tools. Every one of them rejects
a different subset of JSON Schema, and none of them documents the subset
completely. So everyone writes the same function: walk the schema, delete the
parts OpenAI hates, set `additionalProperties: false` everywhere, ship it.

That function is easy to write and almost impossible to write correctly, because
the correctness condition is not the obvious one.

## The obvious condition is the wrong one

The tempting way to state the goal: *the rewritten schema should mean the same
thing as the original.* Sound, tidy, and unachievable. If the provider does not
support `oneOf`, no schema in the provider's subset means the same thing as
`oneOf`. Something has to be lost. The question is what, and in which direction.

There are two directions, and they are not symmetric.

```
validate(fitted, i)  ⟹  validate(original, i)     — soundness
validate(original, i)  ⟹  validate(fitted, i)     — completeness
```

Soundness says: anything the fitted schema lets through, the original would have
let through too. Completeness says the fitted schema turns nothing away that the
original allowed.

`schema-fit` guarantees the first and explicitly refuses to claim the second.

## Why that asymmetry is the whole product

The fitted schema is what the model is constrained by. The original is what your
code was written against — the types, the switch statements, the field accesses
that assume `filter.kind` is either `'author'` or `'year'`.

Under soundness, a failure mode disappears. The model cannot produce a value that
satisfies the provider's constrained decoding and then surprises your code,
because everything the fitted schema admits, the original admits. Your parsing
layer never sees a shape it was not written for.

Under completeness-without-soundness — which is what "delete the parts the
provider hates" gives you — the failure mode is exactly the opposite, and it is
silent. Drop `minimum: 1` because the provider ignores it; now the model can
return `0`, the request succeeds, the JSON parses, and something three functions
away divides by it. Nothing rejected the value. There was no 400 to read.

Losing completeness, by contrast, is loud. The fitted schema rejects something the
original allowed — a request that would have been fine is refused. You find out
immediately, in testing, from the provider, with the offending value in hand. It
is a worse product and a better failure.

Given a choice between a silent wrong answer and a noisy refusal, take the noise.
That is the entire design.

## What it costs, concretely

Take `oneOf: [A, B]` for a provider that supports `anyOf` but not `oneOf`. The
natural rewrite is to rename the keyword, and it is wrong in a way that is easy to
miss: `oneOf` means *exactly* one branch matches, `anyOf` means *at least* one.
The rename accepts every instance matching both branches — instances the original
rejects. It is unsound, and it looks completely reasonable in a diff.

It is sound exactly when the branches cannot overlap. So:

- Branches provably disjoint — different types, different `const`s, a shared
  discriminator property? Rename. Nothing is lost.
- Profile has `not` and `allOf`? Write each branch as itself-and-not-the-others.
  Exact, and ugly, and correct.
- Otherwise, keep the single branch that cannot overlap the rest. Narrowing:
  recorded, reported, loud.
- No such branch? The only sound answer left is a schema that accepts nothing.

That last case looks like a bug the first time you see it. It is the guarantee
working. A schema accepting nothing is a subset of every schema, so substituting
it can never break the implication — and `changes` names the rule and the pointer
that did it, so you can go and simplify your `oneOf` instead of discovering the
problem in production.

## The part that surprised me

Soundness is not a property you can check rule by rule. It depends on *where* in
the schema the rule is applied.

Making a subschema stricter usually makes the whole schema stricter. Under `not`
it does the opposite. `{ not: { enum: ['x', 'y'] } }` rejects two values; replace
that `enum` with something stricter and the `not` rejects *fewer* values, so the
schema around it accepts more. A rewrite that is sound everywhere else becomes
unsound there, and it does so silently.

`oneOf` branches have the same problem for a different reason: narrowing one
branch can turn an instance that matched two branches — and was therefore
rejected — into one that matches exactly one, and is now accepted. `if` has it
too, since the subschema only chooses which of `then` and `else` applies.

So the rewriter tracks the position of every subschema, flipping under `not`,
going invariant under `if` and inside `oneOf` options — and, because a `$ref` can
carry a definition into one of those positions, it works out where each `$defs`
entry is used before touching it. A rewrite that would invert is not applied;
instead the nearest enclosing schema in an ordinary position becomes a schema
that accepts nothing.

I did not design that. A property test found it: 3,467 generated schemas in, a
counterexample where an `enum` under a `not` under a property made the fitted
schema accept `{"a": false}` while the original rejected it. The next run found
the `oneOf` case — a nested `oneOf` whose inner rewrite changed how many branches
of the outer one matched. The `$defs` case never came back as a counterexample;
it is the same argument applied to a definition that a reference carries into a
negated position, and it was cheaper to handle than to argue my way out of. Every
one of the three is a rewrite that reads as obviously correct in isolation.

## Test the implication, not the output

The property that matters is one line:

```ts
if (validate(fitted, instance)) expect(validate(original, instance)).toBe(true);
```

Generate schemas covering every keyword the profiles talk about. Generate
instances two ways — from the *fitted* schema, where the implication actually
bites, and arbitrary JSON, which catches the cases the faker will not think of.
Run both through `ajv`. Then let it run for a few thousand iterations and read the
counterexamples, because they will be about positions and interactions you did not
have in mind while writing the rules.

Everything else in the library — the profiles, the lint, the change log — is
bookkeeping around that one implication.

---

`schema-fit` is MIT, zero runtime dependencies, draft 2020-12 only.
`npm install schema-fit`.
