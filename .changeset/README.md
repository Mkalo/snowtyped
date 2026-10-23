# Changesets

Run `pnpm changeset` for changes to the shipped package. Select `snowtyped`, a
patch/minor/major bump, and write a user-facing summary. Commit the generated file
with the change; do not run versioning in a feature PR.

Docs, tests, and CI-only changes need no release. When they also touch
`package.json` or the lockfile (for example, a dev-tool update), add an empty
changeset with `pnpm changeset --empty` and explain the exemption in the PR.
Reviewers must reject empty changesets for package behavior or public API changes.

See [the versioning policy](../docs/versioning.md) for prereleases, stable
transitions, and the separate version PR workflow. The package remains private.
