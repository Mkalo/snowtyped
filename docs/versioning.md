# Versions and changelogs

Versioning is separate from publication. `snowtyped` stays `private: true` and
`UNLICENSED` until the owner resolves #20/#24. Public source visibility does not
change either setting. This workflow never publishes to npm, creates Git tags, or
creates GitHub releases. There is no npm token or trusted-publishing permission.

## Contributor policy

Use the `pnpm@11.22.0` pinned in `packageManager`. For a shipped package change,
run `pnpm changeset`, select `snowtyped`, choose a bump, and describe the behavior
and migration steps from a consumer's perspective. Commit the Markdown file with
the implementation. Multiple reviewed changesets combine into one version using
the highest bump. Do not edit package versions/changelogs in feature PRs.

| Bump  | Use for                                                                                                               | Stable example |
| ----- | --------------------------------------------------------------------------------------------------------------------- | -------------- |
| patch | Compatible fixes to SQL generation, validation, decoding, runtime behavior, or declarations                           | 1.2.3 -> 1.2.4 |
| minor | Additive, compatible APIs and supported operations                                                                    | 1.2.3 -> 1.3.0 |
| major | Removed/renamed APIs, incompatible types, changed defaults or SQL/validation semantics, or dropped supported runtimes | 1.2.3 -> 2.0.0 |

Use `major` for incompatible changes even during 0.x development; do not disguise
them as fixes. A major changeset from the current alpha plans `1.0.0-alpha.1`.
The numeric version does not grant release approval: stable 1.0 still needs #24's
API/release review. Explain every breaking change and migration in its summary.

Docs, tests, coverage, and CI-only changes are exempt when they do not change the
shipped package. Changesets checks watch `src/**`, `package.json`, the lockfile,
and `tsdown.config.ts`. A dev-tool or scripts-only edit to the manifest/lockfile
therefore needs `pnpm changeset --empty` and an exemption explanation in the PR.
Empty changesets never justify runtime dependency, export, engine, public type,
or package behavior changes. Reviewers decide the exemption; path detection
cannot infer compatibility. Update the watched paths when packaging inputs change.

Run `git fetch origin main` and `pnpm check:changesets` to check new changesets
against `origin/main` (or pass another base ref as its argument). Commit or stage
the changeset first so Git includes it in the comparison. CI compares PRs with
their exact base SHA. A missing changeset for a watched file fails `CI required`.
Push and merge-queue runs check the resulting state; PRs enforce the per-change
policy. The full OS/Node matrix still runs for every PR, including exemptions.

Changeset Markdown, including `.changeset/pre/`, must retain its YAML frontmatter.
Biome's Markdown formatter rewrites that frontmatter, so these files are excluded
from Biome. Changesets parses them during versioning/checks instead.

## Alpha, beta, and stable

Main starts in alpha mode via the committed `.changeset/pre.json`. Normal
changesets produce alpha versions, not stable versions. From `0.1.0-alpha.0`, a
patch produces `0.1.0-alpha.1`; a subsequent minor produces `0.1.0-alpha.2`.
Changesets applies prerelease SemVer rules to the current target; a minor during
an existing `0.1.0` prerelease does not automatically select `0.2.0`.

Consumed prerelease changesets move into `.changeset/pre/` in Changesets v3.
Keep that history: it supplies the consolidated stable changelog. A repeated
version operation without new changesets must leave the version unchanged.

To move alpha to beta, make a channel-control PR with these commands in sequence:

```sh
pnpm changeset pre exit
pnpm changeset pre enter beta
```

Do not run versioning between those commands. Commit the final `pre.json` and a
real changeset for the beta changes; after it reaches main, the version PR plans
the next beta version. In the example above it is `0.1.0-beta.3`: Changesets v3
continues the existing prerelease counter when switching tags. This sequence
changes channels without generating an intermediate stable release. Use only
`alpha` and `beta` as prerelease channels.

To finish the current prerelease, review the API and release gates, then create a
PR running `pnpm changeset pre exit`. Commit the `mode: "exit"` state; the next
version PR removes the prerelease suffix, consumes the archived changesets, and
removes `pre.json`. For the example above it produces stable `0.1.0`, not `1.0.0`.
A major changeset explicitly selects a 1.0 target. Review the generated plan and
changelog before merging; do not hand-edit version numbers to select a target.

After stable releases exist, future prerelease campaigns must first decide how
stable fixes will continue (for example, a stable maintenance branch). Main's
current version bot only handles main; a second release line needs a separately
reviewed workflow/base-branch change. Never casually re-enter prerelease mode on
the only maintained stable line.

Future npm publication in #20 must map alpha versions to the `alpha` dist-tag,
beta versions to `beta`, and approved stable versions to `latest`. Prereleases
must never advance `latest`. Removing a suffix or moving a dist-tag does not
publish an immutable version or change an already published artifact. Review
registry state and exact version/tag agreement as part of that separate work.
No dist-tags are changed by this implementation.

## Version PR automation and owner setup

On pushes to main (or manual dispatch on main), `Version packages` inspects the
release plan and runs only when a package version is pending, including a
prerelease exit. Empty changesets alone do not create a version PR. The pinned
`changesets/action/version` action creates or updates `changeset-release/main`
and its one open PR. Runs are serialized and never auto-merge. Keep that branch
bot-owned; updates regenerate it from the current main and can overwrite edits.
An already merged/closed version PR can be replaced by a new PR for a later batch.

The shared command is:

```sh
pnpm version:packages
```

It runs Changesets, refreshes `pnpm-lock.yaml` with pinned pnpm and lifecycle
scripts disabled, and formats the manifest. Review the version, changelog,
changeset consumption, and lockfile together. Root package version-only changes
may leave this single-package lockfile byte-for-byte unchanged; do not add a
synthetic lockfile edit. Frozen installs must still pass. Local rehearsals belong
in a disposable checkout; contributors should leave generation to the version PR.

Before the first real pending version, the owner must:
1. Create a GitHub App and install it only on `Mkalo/snowtyped`, granting repository
   **Contents: read/write** and **Pull requests: read/write** (Metadata read is
   implicit). It needs no Actions write, administration, workflows write, or
   branch-rule bypass. No webhook subscription is needed for token generation.
2. Set repository variable `CHANGESETS_APP_CLIENT_ID` to its client ID and
   repository secret `CHANGESETS_APP_PRIVATE_KEY` to its PEM private key. The
   token action further restricts each short-lived token to this repository and
   those two permissions, and revokes it at job completion.
3. Dispatch `Version packages` on main with a reviewed pending changeset. Confirm
   that its App-created/updated PR automatically gets all four matrix jobs,
   `Changesets`, and the existing `CI required` gate on its current revision.
   Review and merge versions through the same protected PR process.

Credentials are intentionally required only when versions are pending. Missing
configuration fails visibly; there is no fallback to `GITHUB_TOKEN`. GitHub's
App tokens trigger PR workflows automatically. Using `GITHUB_TOKEN` can require
manual workflow approval (and suppresses push runs), which does not meet this
automation's unattended CI requirement. See [GitHub's trigger documentation](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow#triggering-a-workflow-from-a-workflow).
The workflow's built-in token stays read-only, and checkout persists no credentials.
The App is not added to the main ruleset's bypass list.

The action's generic generated PR introduction currently implies publication;
the final step replaces it with the repository's version-only contract while
retaining version notes. Do not remove that correction without checking upstream.
CI exempts only same-repository `changeset-release/<base>` PRs with changes limited
to version/changelog/lockfile/prerelease bookkeeping and only a version change in
the manifest. Source edits under a release branch name fail the check.

If bot credentials are unavailable, maintainers can generate versions in a
disposable checkout and open the same narrowly scoped version PR using their
own credentials, then require normal CI and review. Do not store personal tokens
in the workflow or weaken branch protection to unblock automation.

## Rehearsal and references

`pnpm test:versioning` creates temporary Git repositories, runs the real installed
CLI and `version:packages`, and checks patch/minor/major bumps, alpha/beta/stable
transitions, changelog summaries, repeat versioning, private/unlicensed state,
frozen lockfiles, missing changesets, docs/CI exemptions, and version-PR boundaries.
It never calls a publish command. Hosted version-PR create/update behavior also
needs an integration rehearsal with the pinned action and the configured App;
record both PR/run URLs and confirm a second changeset updates the same PR.

Upstream: [configuration](https://changesets.dev/guide/config),
[prereleases](https://changesets.dev/guide/prereleases),
[version action](https://github.com/changesets/action/tree/v2.1.2/version).
