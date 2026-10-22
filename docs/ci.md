# CI and release checks

The offline workflow runs `pnpm check` on Ubuntu and Windows with Node 22 and 24.
Every combination runs lint, strict TypeScript fixtures, unit tests with 100%
per-file source coverage, builds, publint/Are the Types Wrong, installed ESM/CJS
tarball consumers, declaration resolution, and tree shaking. Snowflake credentials
are unnecessary for these checks.

## Checks and diagnostics

Matrix checks have explicit names such as `Check (ubuntu-latest, Node 22)`.
`CI required` is the fixed check to require on `main`. It runs even after a
dependency fails and accepts only a successful matrix result; failure,
cancellation, and skipped jobs cannot satisfy the gate. Keep this name unique
across workflows. Add future docs and Changesets jobs to its `needs` list and
require each result to succeed when #21 and #19 land.

Pushes, pull requests, and merge queues run the workflow without path filters.
A new commit cancels superseded runs for the same pull request. Push runs are
preserved, including runs on release candidate commits. Matrix jobs have a
20-minute deadline and continue independently after another combination fails.

Each combination uploads `ci-<os>-node-<version>-attempt-<attempt>` for 14 days,
including install/check logs, JUnit results when tests ran, and HTML/lcov coverage
when available. Coverage is also generated after test failures. An earlier failure
can leave some reports absent; inspect the failing step and retained logs. Bash
uses `-eo pipefail`, so saving output through `tee` preserves a failed command's
exit status.

The workflow has only `contents: read` permission; its final gate has no token
permissions and checks out no source. Checkout does not persist credentials.
There are no repository secrets, deployment environments, npm authentication, or
publication/deployment commands in offline CI. Keep live tests in the separate
manually dispatched `snowflake-integration` environment workflow. Never introduce
`pull_request_target` to execute contribution code with trusted credentials.

## Required checks on main

GitHub reported this repository as public on 2026-10-22. Check visibility and the
effective rules again when changing repository ownership, visibility, or plan:

```sh
gh api repos/Mkalo/snowtyped --jq .visibility
gh api repos/Mkalo/snowtyped/rules/branches/main
```

The configuration in [main.json](../.github/rulesets/main.json) protects
`refs/heads/main` with an active ruleset that requires pull requests and
the `CI required` status from the GitHub Actions app. Require the branch to be
up to date before merging, resolve review conversations, prohibit deletion and
force pushes, and leave the bypass list empty. A review approval count of zero
allows the sole maintainer to merge their own reviewed changes after CI passes.
The rule's effectiveness must be checked through the API and a failing pull
request; a successful workflow alone does not establish enforcement.

To validate the gate, use a disposable pull request with a deliberate TypeScript
error in `tests/types/`. Confirm that the matrix and `CI required` fail and that
GitHub reports merging blocked. Remove the error, push again, and confirm all
four combinations and `CI required` succeed. Record both run URLs and the tested
commit. Never merge the deliberately failing revision. Recheck PR cancellation
by pushing while a previous PR run is active.

Until these rules are verified effective, use a manual merge/release gate: inspect
all four checks on the current candidate, require all of them to pass, and record
the SHA and workflow URL in the review or release record. Missing, pending,
cancelled, or skipped checks do not count as passes. Keep this fallback if a plan
or visibility change makes enforcement unavailable.

## Action updates

Actions are pinned to full commit SHAs with human-readable release comments in
both workflows. Dependabot proposes grouped GitHub Actions updates weekly.
Before merging, review upstream release notes, confirm each SHA belongs to the
intended upstream release, check action runtime/runner compatibility and changed
permissions/inputs, and require the full matrix. Update the release comments
alongside the pins. Major upgrades require the same review; updates never merge
automatically. Hosted runners must support the pinned actions' Node 24 runtime,
independently of the project's Node test matrix.

## Release gate

Offline CI cannot authorize publication. Keep `package.json` private until the
owner settles licensing and the release contract (#24), Changesets/version
review (#19), and npm ownership/trusted publishing (#20). Record passing offline
checks and an installed-tarball check for the exact release candidate SHA.

A release additionally needs a successful protected hosted Snowflake run on that
same SHA (#23), production-critical hardening evidence (#17/#24), and checked
documentation and deployment/version agreement (#21/#22). These follow-ups are
still release requirements even though their jobs are not yet part of
`CI required`. First npm publication and production documentation deployment need
the owner's authorization. Do not infer release readiness from a green PR.
