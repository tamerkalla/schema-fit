# Releasing

`0.1.0` is built, tested and tagged-ready. It is **not** on npm: the repository
has no publishing credential, so the release workflow gets as far as `npm
publish` and stops at `ENEEDAUTH`.

Verified on 2026-08-12, by running a workflow that reported presence only,
never values: none of `NPM_TOKEN`, `NPM_ACCESS_TOKEN`, `NPM_AUTH_TOKEN`,
`NPM_PUBLISH_TOKEN`, `NPMJS_TOKEN`, `NODE_AUTH_TOKEN` or `NPM_TOKEN_PUBLISH`
is configured on this repository. The package name `schema-fit` is unclaimed on
the registry.

## To publish

1. Add an npm automation token as the repository secret `NPM_TOKEN`
   (Settings → Secrets and variables → Actions).
2. Either push the tag — `git tag -a v0.1.0 -m "schema-fit 0.1.0" && git push
   origin v0.1.0` — or run the **Release** workflow from the Actions tab.

Either path runs typecheck, the full test suite, the build and both smoke
scripts before publishing, and publishes with provenance. The workflow's
`dry_run` input does everything except the publish, if you want to watch it go
green first.

## What a release checks

- `npm run typecheck`, `npm test` (314 tests), `npm run build`
- `node scripts/smoke.mjs` and `node scripts/smoke.cjs` against the built dual
  ESM/CJS entry points
- CI additionally runs the matrix on Node 18, 20 and 22, and a mutation-testing
  job that fails below 85% (currently 86.06%)
