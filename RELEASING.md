# Releasing

Published on npm as [`schema-fit`](https://www.npmjs.com/package/schema-fit),
from `main`, through npm's **trusted publishing**. There is no token: the
registry accepts the release because GitHub attests that this workflow, in this
repository, built it — and the same attestation becomes the package's
provenance statement.

## To cut a release

1. Bump `version` in `package.json` and add a `CHANGELOG.md` entry.
2. Push to `main`.
3. Either push the tag — `git tag -a v0.1.1 -m "schema-fit 0.1.1" && git push
   origin v0.1.1` — or run the **Release** workflow from the Actions tab.

The workflow runs typecheck, the full test suite, the build and both smoke
scripts before publishing. Its `dry_run` input does all of that and stops short
of publishing, if you want to watch it go green first.

The registry rejects a version that already exists, so the version bump in step
1 is the whole ceremony.

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
from someone's laptop.
