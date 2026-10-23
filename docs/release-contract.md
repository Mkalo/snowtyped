# First supported release contract

Snowtyped is alpha software. This document defines what the first supported
release, `1.0.0`, guarantees and what must be true before it is published. Until
then, breaking changes remain possible through reviewed changesets
([versioning policy](versioning.md)). Update this document in the same PR as
any change to the guarantees below.

## Public API

The package has two entry points, `snowtyped` and `snowtyped/snowflake`.
`tests/unit/public-api.test.ts` records the exact value and type exports of
both; adding, removing, or reclassifying an export must update that list and
this section.

**Stable** from `1.0.0`; incompatible changes need a major release:
- Schema declarations: `snowflakeTable`, `alias`, `timeTravel`, the column
  builders (`text`, `integer`, `decimal`, `float`, `boolean`, `date`, `time`,
  `timestamp`, `binary`, `variant`), and `.notNull()`.
- Query construction: `select` and the `SelectQuery` methods documented in the
  README, `flatten`, the expression, aggregate, window, and ordering helpers,
  `insert`, `insertFrom`, `update`, `updateFrom`, `deleteFrom`, `deleteUsing`,
  and `mergeInto` with its conditional branches.
- `.compile()` results (`CompiledQuery`, `BindValue`); the bound values and SQL
  semantics are stable, the exact SQL text is not.
- Raw SQL: `sql`, `sql.identifier`, `sql.join`, `sql.json`, `sql.unsafe`,
  `RawQuery`, `SqlParameter`, and `SqlInterpolation`.
- Introspection: `introspect` and `generateSchema`. Generated source is
  reviewable output; its formatting is not stable.
- `snowtyped/snowflake`: `createClient`, `createPool`, and their option and
  result types.
- Inference types: `InferSelection`, `InferColumn`, `InferExpression`,
  `InsertValues`, `UpdateValues`, and the other exported type names. The value
  types they produce are stable; their internal generic parameters are not.

Inferred result types and runtime representations of existing declarations are
part of the stable API. Correcting a type that contradicted runtime behavior is
a patch, called out in its changeset. New exports, operations, and `DataType`
members are minor; code that switches exhaustively over `DataType` may need a
new case.

**Experimental**; may change in a minor release, always with a changeset:
- The AST layer: `compileAst`, `identifier`, `quoteIdentifier`, the `*Node`
  types, `SourceReference`, and `WireType`.
- Members of columns, tables, expressions, and queries other than their builder
  methods, `columns`, `selection`, and `compile()`; for example `ast`, `node`,
  `expression`, `readSchema`, `refs`, and the phantom `*ScopeType` fields. Use
  builders rather than constructing or inspecting these values.

A public extension protocol for third-party AST nodes is deferred (#13).

**Not yet part of the contract:** error classes and messages. Invalid results,
rejected inputs, and SDK failures always reject; the error types that represent
them may change in a minor release.

## Compatibility

| Dependency    | Supported                                | Tested                                    |
| ------------- | ---------------------------------------- | ----------------------------------------- |
| Node.js       | `^22.18.0 \|\| >=24.11.0` (`engines`)    | 22 and 24 on Ubuntu and Windows           |
| TypeScript    | 6.x, with `strict`                       | 6.0 with NodeNext and Bundler resolution  |
| Zod           | 4.x, a runtime dependency of the package | The pinned 4.x dependency                 |
| snowflake-sdk | `^3.4.0`, an optional peer               | 3.4.0, offline and against live Snowflake |

Dropping a Node.js major line or raising the minimum TypeScript, Zod, or
snowflake-sdk version is a major change. Supporting a new major version, such
as TypeScript 7, is a minor change once CI covers it. Platforms and versions
outside CI, such as macOS or older TypeScript releases, may work but are not
supported.
- `variant(name, schema)` accepts Zod 4 schemas. Result validation uses
  Snowtyped's own Zod dependency.
- `createClient` accepts any connected snowflake-sdk connection in the
  supported range. `createPool` loads the SDK only when called.

## Data representations

Structured queries return the representations in the README's
[declaration table](../README.md#declared-schemas-and-typed-queries):
integers as `bigint`, fixed-point decimals as exact strings, temporal values as
strings that keep nanoseconds and offsets, binary as `Uint8Array`, and VARIANT
as `unknown` or the declared Zod shape. Every structured result row is validated
against its declarations; a mismatch rejects execution. Mutations return
`{ affectedRows, queryId }` with `affectedRows` as a `number`.

Raw queries (`queryRaw`, `streamRaw`, and `sql` fragments) have weaker
guarantees:
- The type argument is a caller assertion about the entire result. It defaults
  to `unknown` and adds no runtime validation.
- Numbers, temporal values, and semi-structured values are fetched as strings
  by the SDK. Their text follows Snowflake session formats, which Snowtyped does
  not control; cast or format in SQL when the exact text matters.
- Row keys follow SQL aliases and SDK object rows; duplicate names collide.
- Interpolated scalars are always bindings; identifiers need `sql.identifier`.
  `sql.unsafe` text is trusted and sent as written.

## Required production scenarios

These scenarios from #17 must pass on the release commit. Unit tests cover
SDK-independent behavior; live tests run in the protected integration workflow.
[Production behavior](production.md#scenario-coverage) maps each scenario to its
tests.
1. **Cancellation:** pre-aborted requests never execute; abort and timeout wait
   for SDK cancellation; late completions are ignored; a long-running live
   statement is cancelled.
2. **Pool waits:** cancellation or `acquireTimeoutMillis` while waiting for a
   connection rejects without leaking a lease.
3. **Streaming:** early `break`, `return`, or a consumer error destroys the row
   stream and releases its lease; a large live result streams with bounded
   memory.
4. **Pool pressure:** concurrent work above `max` never exceeds `max`
   connections and completes; `close()` with work in flight has defined
   behavior and leaves no open connections.
5. **Transactions:** commit, rollback, preserved errors, and rejected nested or
   expired use; a pooled connection whose rollback failed is destroyed instead
   of released for reuse.
6. **Failures:** synchronous, callback, network, and mid-stream SDK errors
   reject with the original error, return no partial result, and release the
   lease.
7. **Retries:** no statement is retried implicitly.
8. **Sustained use:** a live run mixes concurrent queries, streams, and
   transactions above pool `max` and ends with every connection closed.

Inference and editor benchmarks (`pnpm bench:types`) and baselines are in
[production behavior](production.md#baselines). Longer soak and throughput suites
remain #17 work but do not block the first supported release.

## Release gates

Record the candidate SHA and evidence for every gate in the GitHub release or a
comment on #1. Missing, pending, skipped, or cancelled runs do not count.
1. **Contract:** this document, the README, and the public API snapshot match
   the candidate; deferred and experimental features are listed accurately.
2. **Offline CI:** `CI required`, the four matrix jobs, and Changesets pass on
   the candidate's main push ([CI](ci.md#release-gate)).
3. **Live tests:** the protected Snowflake workflow passes on the same SHA
   (#23), including the supported-feature matrix (#26) and the live scenarios
   above.
4. **Packed consumer:** the release workflow builds the tarball once and runs
   the package tests against those bytes; its contents, `LICENSE`, and `license`
   metadata are inspected.
5. **Docs:** the documentation site builds with checked examples (#21) and its
   production deployment matches the version (#22).
6. **Version review:** a reviewed `pnpm changeset pre exit` PR and version PR
   produce `1.0.0` with a consolidated changelog and a frozen install.
7. **npm:** `npm owner ls snowtyped` lists the maintainer account `mkalodev`;
   npm 2FA and trusted publishing are configured as in
   [npm publication](versioning.md#npm-publication).
   `NPM_STABLE_RELEASES_ENABLED=true` is set only after gates 1-6 pass, and the
   maintainer approves the stage with 2FA.
8. **Finalize:** registry bytes, provenance, the Git tag, the GitHub release,
   the `latest` dist-tag, and the docs version agree.

## Roadmap status

Not required for `1.0.0`; each can ship later as a minor release unless it
changes stable behavior:
- Scalar, EXISTS, and correlated subqueries (#9)
- PIVOT and UNPIVOT (#10)
- Stronger SQL semantic validation (#11)
- Recursive CTEs (#12)
- A public AST extension protocol (#13)
- Nested selections and relation loading (#14)
- MATCH_RECOGNIZE (#15)
- DDL builders and migrations (#16)

In progress and not yet part of this contract: raw-query cancellation (#2),
expression and function helpers (#3), constraints and additional type codecs (#5), window frames (#6), and set
operations (#7). Each joins the stable API when it merges and this document and
the export snapshot are updated.

Raw SQL remains available for Snowflake syntax beyond the modeled builders.

## Support

Snowtyped is maintained by [Mkalo](https://github.com/Mkalo) on a best-effort
basis; there is no dedicated support service or response-time commitment. Use
[GitHub issues](https://github.com/Mkalo/snowtyped/issues) for bugs and
questions. Report vulnerabilities privately as described in
[SECURITY.md](../SECURITY.md). Fixes target the latest release; before
`1.0.0`, that is the latest alpha or beta.
