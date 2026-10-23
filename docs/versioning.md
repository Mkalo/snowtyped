# Versions and releases

Snowtyped uses MIT. Changesets manages versions and changelogs; the separate
release workflow stages alpha/beta packages for your npm approval with 2FA.
Stable support guarantees remain tracked in #24.

## Changesets

Run `pnpm changeset` for changes to the shipped package. Select `snowtyped` and
write a consumer-facing summary, including migration steps for breaking changes.
Commit it with the implementation; leave version generation to the version PR.

| Bump  | Use for                                                 | Stable example |
| ----- | ------------------------------------------------------- | -------------- |
| patch | Compatible fixes to behavior, SQL, validation, or types | 1.2.3 -> 1.2.4 |
| minor | Compatible new APIs and operations                      | 1.2.3 -> 1.3.0 |
| major | Incompatible APIs/types/defaults, or dropped runtimes   | 1.2.3 -> 2.0.0 |

Use `major` for breaking changes even during 0.x development. From the current
alpha, that plans `1.0.0-alpha.1`; it does not grant stable-release approval.

Docs, tests, and CI-only changes are exempt. Checks watch `src/**`, `package.json`,
`pnpm-lock.yaml`, and `tsdown.config.ts`. Tooling-only manifest/lockfile edits need
`pnpm changeset --empty` and an exemption explanation in the PR. Runtime dependency,
export, engine, and public type changes need a real changeset. Update the watched
paths when packaging inputs change.

After `git fetch origin main`, run `pnpm check:changesets` against `origin/main`
(or pass another base ref). Stage or commit the changeset first. CI compares PRs
with their exact base SHA and includes Changesets in `CI required`.

Keep YAML frontmatter intact: Changesets Markdown is excluded from Biome because
its Markdown formatter rewrites that frontmatter.

## Alpha, beta, and stable

Main starts in alpha mode through `.changeset/pre.json`. A patch changes
`0.1.0-alpha.0` to `0.1.0-alpha.1`; a subsequent minor becomes `0.1.0-alpha.2`.
Changesets applies prerelease SemVer rules to the current target. Consumed files
move to `.changeset/pre/`; retain them for the consolidated stable changelog.

To switch alpha to beta, run these together in a channel-control PR, add a real
changeset for the beta changes, and commit the final state:

```sh
pnpm changeset pre exit
pnpm changeset pre enter beta
```

Do not run versioning between those commands. The example above then becomes
`0.1.0-beta.3`: Changesets continues the counter across channels.

To finish prereleases, commit `pnpm changeset pre exit` in a PR. The next version
PR removes the suffix and consumes the archived changesets, yielding `0.1.0` in
this example. Use a major changeset to select a 1.0 target. After stable releases
exist, decide how stable fixes will continue before starting another prerelease
campaign; the current automation only supports main.

## Version PRs

`Version packages` runs on main and maintains one `changeset-release/main` PR.
Empty changesets alone do not create a PR. Runs regenerate the branch from main,
so keep it free of manual edits. Nothing auto-merges or publishes from that PR.

`pnpm version:packages` runs Changesets, refreshes the lockfile with pinned pnpm
and lifecycle scripts disabled, and formats the manifest. A root version-only
change can leave this lockfile unchanged. Review the version, changelog, consumed
changesets, and frozen-install result together. Rehearse locally in disposable state.

The version bot uses `CHANGESETS_APP_CLIENT_ID` (repository variable) and
`CHANGESETS_APP_PRIVATE_KEY` (repository secret). Install its GitHub App only on
this repository with Contents/Pull requests read/write. Its App token triggers
CI automatically; the built-in token remains read-only. Keep the main ruleset's
bypass list empty. Missing App configuration fails when versions are pending.

## npm publication

Use npm account `mkalodev` with 2FA. The GitHub `npm` environment permits only main
and contains no npm secret. Configure npm trusted publishing for **Mkalo /
snowtyped / release.yml / npm**, allowing **npm stage publish only**, and select
**Require two-factor authentication and disallow tokens** in package settings.
Complete the first trusted publish within two days of configuring it.

For a new package, npm requires a one-time bootstrap before trusted publishing
can be configured. First run **Release package → prepare** on main with a reviewed
version and its full commit SHA; inspect the downloaded tarball and `release.json`.
After explicitly approving the bootstrap, stage that exact tarball locally:

```sh
npm exec --yes --package=npm@12.2.1 -- npm stage publish ./snowtyped-<version>.tgz --access public --tag alpha --ignore-scripts --provenance=false --registry https://registry.npmjs.org
```

This creates a **public `0.0.0-stage` placeholder** and a pending alpha stage.
Reject the local stage with `npm stage reject <stage-id>` and 2FA; do not approve
it because it lacks CI provenance. Configure trusted publishing, then use CI to
stage the real alpha with provenance.

For each release:
1. Merge the reviewed Changesets version PR and wait for its exact main commit's
   latest push CI to pass all four matrix jobs, Changesets, and `CI required`.
2. Dispatch **Release package → stage** on main with that version and SHA. Stage
   the workflow run's own commit so OIDC identifies the actual source. If main
   advances, rerun the original stage run rather than dispatching an older SHA.
   CI rebuilds, tests, inspects, and stages the same tarball with provenance.
3. Inspect `npm stage list snowtyped` and `npm stage view <stage-id>` against the
   artifact's version, dist-tag, SHA-512, and provenance. Publish it with
   `npm stage approve <stage-id>` and 2FA, or approve it on npm's Staged Packages UI.
4. Dispatch **Release package → finalize** with the same SHA/version. It verifies
   registry bytes, provenance identity, and signatures before creating `v<version>`
   and GitHub release notes from the matching changelog section, then deploys that
   tag's [documentation](docs-deployment.md).

Alpha uses `alpha`, beta uses `beta`; neither advances `latest`. Stable uses
`latest` only with `NPM_STABLE_RELEASES_ENABLED=true` after the stable gates in
[CI](ci.md#release-gate) are met. The default **prepare** operation performs no
registry write. A running release cannot be cancelled by another release;
GitHub may replace an older queued dispatch.

If a stage already exists, inspect it and approve or reject it with 2FA. Conflicts
fail safely. Identical published versions are reused; different bytes or an
existing Git tag on another SHA fail. If publication succeeds but finalization
fails, rerun **finalize**. Advanced dist-tags stay untouched; correct missing or
wrong tags deliberately with npm 2FA. Fix bad public releases with a new patch
and, when appropriate, `npm deprecate snowtyped@<version> "<reason and replacement>"`.
Never automatically unpublish or replace an immutable version.

Validation: `pnpm test:versioning` and `pnpm test:release` exercise disposable
versioning, release gates, staging conflicts, provenance identity, and retries.
Live OIDC staging, npm approval, and signature verification still need a real
release. See [npm staged publishing](https://docs.npmjs.com/staged-publishing/)
and [trusted publishers](https://docs.npmjs.com/trusted-publishers/).
