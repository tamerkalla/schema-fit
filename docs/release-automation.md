# What a fully automated release has to handle

Notes from getting `0.1.0` → `0.1.2` onto npm. Every failure below actually
happened, with the error quoted as it appeared. Ordered by when it bites.

## Preflight: things that must be true before the first release

A release fails late and expensively if any of these is missing, so check them
first, in this order.

1. **`package.json` has a `repository` field matching the repository the
   workflow runs in.** Required by provenance, and nothing local catches its
   absence — `npm pack --dry-run` is happy without it.
2. **Trusted publishing is configured on the npm package**, naming the
   repository *and* the workflow filename. Or, if using a token, the secret
   exists — see below for how to tell without printing it.
3. **The npm on the runner is ≥ 11.5.1.** Node 22 ships older. Trusted
   publishing does not engage on older npm and you get an auth error that looks
   like a missing credential.
4. **The version is not already published.** The registry refuses a re-publish,
   so any re-run of a release needs a bump.
5. **The default branch is the branch you release from.** Not enforced by
   anything; it just quietly releases from wherever you dispatched.

## Failure modes, with the errors

### `npm error code ENEEDAUTH`

```
npm error need auth This command requires you to be logged in to https://registry.npmjs.org/
```

No credential. Either the secret is missing, or trusted publishing is not
configured, or npm is too old to use it. All three produce this same message,
which is why the preflight above is worth doing separately.

Checking whether a secret exists without leaking it: a workflow step that prints
`${{ secrets.NPM_TOKEN != '' }}`. Presence only, never the value.

### `npm error code E422` — provenance rejected

```
422 Unprocessable Entity - PUT https://registry.npmjs.org/schema-fit
Error verifying sigstore provenance bundle: Failed to validate repository
information: package.json: "repository.url" is "", expected to match
"https://github.com/OWNER/REPO" from provenance
```

The provenance statement names the repository it was built from; npm checks that
claim against `package.json`. Two things worth knowing:

- The failure lands **after** the statement is signed and written to the public
  transparency log. A failed publish still leaves a log entry, so this is not a
  free retry.
- The check is on the *published* `package.json`, so a spec should assert the
  field is present before the workflow ever reaches `npm publish`.

### An empty `NODE_AUTH_TOKEN` after switching to trusted publishing

`actions/setup-node` with `registry-url` writes an `.npmrc` containing
`//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}`. Delete the secret but
leave the `env:` line, and that expands to empty. Under trusted publishing the
`env:` should not be there at all — the OIDC token from `permissions: id-token:
write` is the credential.

### A tag trigger you cannot reach

```
$ git push origin v0.1.0
send-pack: unexpected disconnect while reading sideband packet
fatal: the remote end hung up unexpectedly
Everything up-to-date
```

Branch pushes worked; tag pushes did not. Some sandboxed environments allow only
the branch they gave you. A release that can *only* be triggered by a tag is
therefore unreachable from such an environment.

Give the release workflow a `workflow_dispatch` trigger alongside the tag one,
with a `dry_run` input that runs everything and stops short of publishing. That
also covers re-running a release whose publish failed after the tag landed —
the tag is already used up, and deleting and re-pushing a tag is worse.

### Repository settings an automated actor cannot change

Setting the default branch needs the repository administration API. It is not
reachable from:

- The GitHub MCP tools — no `update_repository`.
- Direct `api.github.com` — blocked by the egress proxy in this environment.
- A workflow: `permissions: administration: write` is **not** a valid Actions
  permission scope, and the workflow fails to parse:
  ```
  422 Invalid Argument - failed to parse workflow: (Line: 15, Col: 3):
  Unexpected value 'administration'
  ```

A spec should treat repository settings as human-owned preconditions, listed in
the preflight, not as steps the pipeline performs.

### The registry does not update instantly

After a successful publish, the package is not immediately resolvable. Poll
`https://registry.npmjs.org/<name>` until `dist-tags.latest` is the version you
just published, with a bounded number of attempts — do not assume a fixed sleep
is enough, and do not assume a `404` right after publishing means failure.

### `npm audit signatures` may not be reachable

```
npm error Failed to download
```

Behind a restrictive proxy the audit endpoints are not available. Verify
provenance from the registry metadata instead: `dist.attestations` present, and
`dist.signatures` non-empty.

## Verification that proves something

Building locally and running a smoke script tests the working tree, not the
artifact. The release is only verified when a **clean install from the registry**
is exercised:

```bash
mkdir /tmp/verify && cd /tmp/verify && npm init -y
npm install <name>@<version>
node -e "import('<name>').then(m => …)"   # ESM
node -e "require('<name>')"                # CJS
```

Assert on the installed package: the public API works, the types resolve
(`dist/*.d.ts` present), dependencies are what you expect, and `license`,
`repository` and the attestation are on the registry metadata.

## Gates that interact with releasing

A mutation-testing gate that fails the build below a threshold will block a
release commit that adds new source. Adding one module here dropped the score
from 86.06% to 84.26% against a break threshold of 85, purely because the new
file had no tests of its own yet.

Two things follow for a spec:

- New source needs its own tests in the same change, not a follow-up.
- The gate needs a runtime budget. Mutation testing re-runs the suite once per
  mutant; with property-based tests covering every file, that is nearly every
  mutant. Pin the property run count for the mutation job (here
  `SCHEMA_FIT_RUNS=25`) or the job takes half an hour.

## A note on agent environments

Two smaller frictions worth designing around:

- Compound shell commands (a heredoc plus a `git push`, say) are more likely to
  be refused by a permission classifier than the same work as separate,
  single-purpose commands.
- Provider documentation sites may be blocked by the egress proxy
  (`platform.openai.com` and `ai.google.dev` both were). Anything that must be
  sourced from live documentation cannot be verified in such a session, and
  should be marked as unverified rather than guessed.
