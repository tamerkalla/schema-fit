# Verifying schema-fit

This reproduces the README's guarantee — `validate(fit(S, P).schema, i) ⟹
validate(S, i)` — from the published package, in a clean directory. It does
not require this repository to be checked out.

```bash
mkdir -p schema-fit-verify && cd schema-fit-verify
npm init -y >/dev/null 2>&1
npm install schema-fit@latest ajv@8 >/dev/null 2>&1
cat > verify.mjs <<'JS'
import { check, fit, profiles } from "schema-fit";
import Ajv from "ajv";

const schema = {
  type: "object",
  properties: {
    query: { type: "string", minLength: 1 },
    limit: { type: "integer", minimum: 1, maximum: 50, default: 10 },
  },
  required: ["query"],
};

const before = check(schema, profiles.openaiStrict);
const { schema: fitted, lossless } = fit(schema, profiles.openaiStrict);
const after = check(fitted, profiles.openaiStrict);

const ajv = new Ajv({ allErrors: true });
const validateOriginal = ajv.compile(schema);
const validateFitted = ajv.compile(fitted);

const candidates = [
  { query: "x", limit: 10 },
  { query: "x" },
  { query: "", limit: 10 },
  { query: "x", limit: 999 },
  {},
];

let counterexamples = 0;
for (const instance of candidates) {
  if (validateFitted(instance) && !validateOriginal(instance)) counterexamples += 1;
}

console.log(`before: ok=${before.ok} violations=${before.violations.length}`);
console.log(`after:  ok=${after.ok} violations=${after.violations.length}`);
console.log(`lossless=${lossless}`);
console.log(`soundness counterexamples over ${candidates.length} candidates: ${counterexamples}`);
JS
node verify.mjs
```

Expected output:

```text
before: ok=false violations=3
after:  ok=true violations=0
lossless=false
soundness counterexamples over 5 candidates: 0
```

`before` is `check`'s report on the original schema against OpenAI's strict
profile: three violations (`additionalProperties`, `limit` not required,
`limit`'s `default`). `after` confirms `fit`'s rewrite satisfies that same
profile completely. `lossless=false` is truthful, not a bug: `limit` is now
required, so a caller that omitted it is rejected by the fitted schema — the
guarantee is about *widening*, never about losing nothing. The last line is
the guarantee itself, checked directly with `ajv`: every one of the five
candidate instances the fitted schema accepts is also accepted by the
original, so zero counterexamples.

Property-based verification of the same guarantee, over generated schemas
rather than five hand-picked instances, requires this repository checked out:

```bash
git clone https://github.com/tamerkalla/schema-fit.git && cd schema-fit
npm ci
npm test              # includes property.test.ts: soundness, conformance,
                       # idempotence and identity over fast-check-generated schemas
npm run typecheck
npm run build
npm run smoke          # loads both ESM and CJS builds
npm run mutation       # Stryker, threshold 85% (currently 85.92%)
```
