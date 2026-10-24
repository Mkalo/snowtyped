# Contributing

Use the pinned pnpm version and a supported Node.js release. Install with `pnpm install --frozen-lockfile`, then run `pnpm check`. All local checks are offline with respect to Snowflake; package tests may need the npm registry for dependencies.

Keep changes aligned with these boundaries:
- `ast.ts` models Snowflake syntax independently of the SDK and runtime schemas.
- `schema.ts` owns column domains, wire decoding, and schema-derived validation.
- `query.ts` owns immutable query construction and scope rules.
- `snowflake/` adapts an existing `snowflake-sdk` connection.

For a new operation, define its AST representation, input types, scope, inferred output, SQL compilation, and runtime validation together. Prefer semantic nodes over raw SQL fragments. Structured queries derive validation from declared schemas. Raw tagged queries explicitly allow caller-supplied result assertions, as requested by the user; these default to unknown and do not establish runtime validation. Do not require callers to provide decoders.

Add behavioral unit tests and compile-time fixtures for new public typing contracts. Export changes must update the snapshot in `tests/unit/public-api.test.ts` and the [release contract](docs/release-contract.md#public-api). Coverage thresholds are 100% per implemented source file for statements, branches, functions, and lines; maintain meaningful assertions instead of excluding uncovered behavior. Unit tests must never require Snowflake credentials.

New Snowflake semantics need opt-in integration coverage using `tests/support/snowflake.ts`. Fixtures must own uniquely generated schemas and clean up only the schemas they created. Live test files run in parallel, so a file must not depend on objects or session state another file creates. Use a dedicated test account role and database; see `docs/snowflake-setup.md`.

Every supported server-facing feature has live tests listed in [live coverage](docs/live-coverage.md). A new public export, builder method, or semantic variant updates that document and adds live assertions of SQL behavior and returned values, including NULL, empty, and unmatched cases where they apply. Type-only contracts, invalid construction, client-side guards, and unreproducible races go under its exclusions with the unit or type test that covers them. A live test that would expose a bug is filed as an issue and listed under known gaps rather than asserting the wrong behavior. `tests/unit/live-coverage.test.ts` fails when a runtime export or builder method is missing from the document.

Package checks install the actual tarball in a temporary consumer and verify ESM/CJS loading, declaration resolution, and tree shaking. Keep these checks working when exports or dependencies change. Never commit environment files, private keys, generated bootstrap SQL, build artifacts, or coverage output.

The documentation site in `website/` is the authoritative user documentation. Changes to
public APIs, behavior, or feature boundaries update the matching pages in
`website/src/content/docs/`. Its examples are type-checked snippets under
`website/src/snippets/`, and its tests require every runtime export to appear in a guide or
snippet. The README is a short showcase that links to the site; its examples are copies of
snippets, which the site's tests enforce. It is a separate pnpm project (Node.js 22.23.4+); run `pnpm check` in `website/`.
Write internal links root-relative, such as `/guides/queries/`; the build adds the deployment
base path. See [documentation deployment](docs/docs-deployment.md).

See [CI and release checks](docs/ci.md) for required-check configuration, diagnostics,
action updates, and the manual gate when hosted enforcement is unavailable.

Package changes need a reviewed `pnpm changeset` file. Docs, tests, and CI-only
changes are exempt; manifest/lockfile tooling edits need an empty changeset and
an exemption explanation. See [versioning policy](docs/versioning.md) for bump
choices, alpha/beta/stable transitions, and version PRs. Do not hand-edit package
versions or publish from contribution PRs. Run `pnpm test:versioning` when changing
this tooling.

The project uses MIT. Report vulnerabilities through [SECURITY.md](SECURITY.md),
not public issues. Follow [npm publication](docs/versioning.md#npm-publication)
to release alpha/beta versions; approve staged packages with npm 2FA. The
[release contract](docs/release-contract.md) lists the gates for a stable
release. Run `pnpm test:release` when changing release policy or automation.
