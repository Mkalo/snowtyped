# Versions and releases

Snowtyped uses MIT. Changesets manages versions and changelogs; the separate
release workflow stages alpha/beta packages for your npm approval with 2FA.
The [release contract](release-contract.md) defines stable guarantees and gates.

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
and lifecycle scripts disabled, and formats the manifest and changelog. A root version-only
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

For each release:
1. Merge the code PR with its changeset, then review and merge the generated
   version PR.
2. Successful main CI automatically starts **Release package**. Pending
   changesets and completed releases are skipped. CI builds and tests the
   exact tarball, then stages it with OIDC and provenance.
3. Review the CI stage's version, dist-tag, SHA-512, and provenance in npm's
   Staged Packages UI. Approve it with 2FA to publish the version.
4. The same workflow waits up to one hour for approval, verifies the public bytes
   and signatures, creates `v<version>` and the matching GitHub release, then
   deploys that tag's [documentation](docs-deployment.md).

There are no routine workflow dispatches. If approval takes longer than an hour,
approve the existing CI stage and rerun the original release workflow; identical
published bytes are reused. **Release package → release** also supports recovery,
defaulting to the current main commit/version. Optional **prepare** previews an
artifact without staging it.

### One-time bootstrap

Keep `NPM_RELEASES_ENABLED` unset or false until npm trust is configured. Prepare
and inspect a candidate first. With `NPM_CLI_JS` pointing to npm 12.2.1's
`bin/npm-cli.js`, run these with the candidate's version, SHA, and downloaded
artifact directory:

```sh
node scripts/release.mjs bootstrap-check <version> <sha> <artifact-directory>
node scripts/release.mjs bootstrap <version> <sha> <artifact-directory>
node scripts/release.mjs trust <version> <sha> <artifact-directory>
```

Bootstrap creates a **public `0.0.0-stage` placeholder** using a separate pending
`0.0.0-bootstrap.0` holding package. **Never approve or reject the holding stage
before the real CI release is public.** Rejecting the only stage unpublishes the
placeholder and triggers npm's 24-hour name cooldown. The commands detect the
unpublished record and block until its exact deadline, before npm authentication
or writes.

Trust requires 2FA, disallows tokens, and configures the stage-only publisher.
Check its output, set repository variable `NPM_RELEASES_ENABLED=true`, and run
**Release package → release** once for the initial candidate. Later releases
start automatically. After the real release is public, run
`node scripts/release.mjs cleanup-bootstrap <version> <sha> <artifact-directory>`.
It rejects only the saved holding-stage ID after verifying the public release's
bytes, provenance, and signatures. Retain the artifact directory and its receipt.

Alpha uses `alpha`, beta uses `beta`; neither advances `latest`. Stable uses
`latest` only with `NPM_STABLE_RELEASES_ENABLED=true` after the stable gates in
[CI](ci.md#release-gate) are met. The default **prepare** operation performs no
registry write. A running release cannot be cancelled by another release;
GitHub may replace an older queued dispatch.

If a real release stage already exists, inspect it and approve or reject it with 2FA. Conflicts
fail safely. Identical published versions are reused; different bytes or an
existing Git tag on another SHA fail. If publication succeeds but finalization
fails, rerun the original release workflow. Advanced dist-tags stay untouched; correct missing or
wrong tags deliberately with npm 2FA. Fix bad public releases with a new patch
and, when appropriate, `npm deprecate snowtyped@<version> "<reason and replacement>"`.
Never automatically unpublish or replace an immutable version.

Validation: `pnpm test:versioning` and `pnpm test:release` exercise disposable
versioning, release gates, staging conflicts, provenance identity, and retries.
Live OIDC staging, npm approval, and signature verification still need a real
release. See [npm staged publishing](https://docs.npmjs.com/staged-publishing/)
and [trusted publishers](https://docs.npmjs.com/trusted-publishers/).
