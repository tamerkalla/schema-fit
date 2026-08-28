# Releasing

Published on npm as [`schema-fit`](https://www.npmjs.com/package/schema-fit),
from `main`, through npm's **trusted publishing**. There is no token: the
registry accepts the release because GitHub attests that this workflow, in this
repository, built it — and the same attestation becomes the package's
provenance statement.

## To cut a release

Run the **Release** workflow from the Actions tab (`workflow_dispatch`), choosing
a `bump` (`patch`, `minor` or `major`) and an `auth` mode (`oidc`, unless this is
the very first publish and no trusted publisher is configured yet, in which case
`token` falls back to `NPM_TOKEN`).

That is the whole ceremony. The workflow runs typecheck, the full test suite,
the build and both smoke scripts, bumps `version` in `package.json`, publishes,
**tags the commit it just published**, pushes the version commit and tag back to
`main`, and cuts a GitHub release from the tag.

A plain push to `main` runs the same workflow but never bumps or publishes,
unless `package.json` still reads the `0.0.0` placeholder — that path exists
only to make the first release on a fresh repository need no human action.

There is deliberately no tag trigger: this workflow creates the tag itself, so a
tag push would race it and try to publish the same version twice.

## What a release needs from the repository

- **Trusted publishing** configured on the npm package, naming this repository
  and `.github/workflows/release.yml`.
- `permissions: id-token: write` on the publish job — this is the credential.
- npm 11.5.1 or newer. Node 22 ships something older, so the workflow installs
  the current npm first.
- A `repository` field in `package.json` matching the repository the workflow
  runs in. Provenance names the repository it was built from, and npm checks
  that claim against `package.json`; without it the publish is refused with
  `422 ... "repository.url" is ""` *after* the statement has been signed.

## What a release checks

- `npm run typecheck`, `npm test` (345 tests), `npm run build`
- `node scripts/smoke.mjs` and `node scripts/smoke.cjs` against the built dual
  ESM/CJS entry points
- CI additionally runs the matrix on Node 18, 20 and 22, and a mutation-testing
  job that fails below 85% (currently 85.92%)

## Verifying a published version

```bash
npm view schema-fit@latest
npm audit signatures            # in a project that installed it
```

`dist.attestations` on the registry metadata is the provenance; it is what
lets anyone check the package came from this repository's workflow rather than
from someone's laptop. See [VERIFY.md](VERIFY.md) to reproduce the README's
guarantee from the published package.
