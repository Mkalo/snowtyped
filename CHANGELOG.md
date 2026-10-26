# Changelog

## 1.1.0

### Minor Changes

- 2dd87b5: Add `Snowtyped.InferRow`, `Snowtyped.InferInsert`, and `Snowtyped.InferUpdate` helper types. `Snowtyped.InferRow<typeof query>` is the row type of a SELECT, set operation, query with relations, or table without executing it, including outer-join nullability. `Snowtyped.InferInsert<typeof table>` and `Snowtyped.InferUpdate<typeof table>` are the values `insert()` and `update()` accept.
- 80bb0df: Export every public type under the type-only `Snowtyped` namespace: `import type { Snowtyped } from 'snowtyped'`, then `Snowtyped.InferRow<typeof query>`, `Snowtyped.Table`, `Snowtyped.SnowflakeClient`, or `Snowtyped.Migration`. It covers the types of `snowtyped`, `snowtyped/snowflake`, and `snowtyped/ddl`.

  The individual type exports still work but are deprecated, so editors strike them through; they will be removed in 2.0. To migrate, replace `import { type InferSelection } from 'snowtyped'` with `import { type Snowtyped } from 'snowtyped'` and write `Snowtyped.InferSelection`. Runtime exports are unchanged.

### Patch Changes

- b226ace: `update()`, `updateFrom()`, and MERGE `whenMatchedUpdate()` now leave out keys whose value is `undefined`, as `insert()` already did, instead of throwing a `ZodError`. A patch whose values are all `undefined` is rejected with `A mutation needs at least one column value.`

## 1.0.1

### Patch Changes

- e18d77f: Document the public API with TSDoc, so editor hovers and the API reference describe every export, its parameters, and runnable examples.

## 1.0.0

### Major Changes

- 948a358: First stable release. The public API, compatibility range, and data representations described in the [release contract](https://github.com/Mkalo/snowtyped/blob/main/docs/release-contract.md) are now covered by semantic versioning: incompatible changes to stable APIs need a major release. The AST layer and the `snowtyped/ddl` entry point stay experimental and may change in a minor release. Upgrading from `0.1.0-alpha.2` needs no code changes.

### Minor Changes

- 79c024b: Declare NUMBER precision/scale, VARCHAR and BINARY length, and TIME/TIMESTAMP fractional precision on columns. Writes and decoded results that do not fit are rejected instead of being silently rounded or truncated, and introspection generates the matching declarations.
- f5a0d33: Add `.serverDefault()`, `.identity()`, and `.virtual()` column metadata, carried through introspection and code generation. Inserts now omit unspecified columns so Snowflake applies their defaults instead of NULL, mixed row shapes compile to a single `INSERT ALL`, and writes to virtual columns are rejected.
- 1e989c5: Add the `snowtyped/ddl` entry point: physical column types and table definitions derived from declared tables, their size options, and their server values (DEFAULT, AUTOINCREMENT, AS), schema and table DDL builders, schema inspection and deterministic diffs, drift checks, a direct `pushSchema`, and a migration runner with per-statement history, a lease lock, destructive-change acknowledgement, and explicit resume after partially applied migrations.
- 8f88d62: Add typed `cast`, `avg`, `add`/`sub`/`mul`/`div`, `coalesce`, `caseWhen`, `concat`/`trim`/`length`/`substring`, `dateTrunc`/`dateAdd`/`dateDiff`/`datePart`, and `rank`/`denseRank`/`lag`/`lead` expressions with Snowflake result domains and nullability.
- 2f70384: Add typed `matchRecognize` table sources with a composable `rowPattern` API, variable-scoped `define` and `measures`, and schema-derived output columns for every rows-per-match mode. Comparisons against literal-typed expressions now keep their source scope.
- 3d7855a: Add `insertFrom`, `updateFrom`, and `deleteUsing` for typed INSERT … SELECT, UPDATE … FROM, and DELETE … USING mutations; the sourced UPDATE and DELETE forms require a join predicate. MERGE now accepts ordered conditional branches through an optional condition on `whenMatchedUpdate`, `whenMatchedDelete`, and `whenNotMatchedInsert`, rejects unreachable branches, and limits NOT MATCHED values and conditions to the source scope.
- f622a29: Add nested object projections. Plain objects in `select` and `.select()` projections decode into nested result objects with schema-derived types and validation, and an object over an outer-joined source becomes `null` when its NOT NULL keys show the joined row is absent.
- 81a7543: Add typed `pivot` and `unpivot` table sources with schema-derived output columns, plus `dynamicPivot` for `IN (ANY)` pivots as unvalidated raw queries.
- d8298ce: Buffered `queryRaw` now accepts `{ signal, timeoutMs }` for reusable `sql` queries, matching `execute`, `stream`, and `streamRaw` cancellation on single-connection and pooled clients.
  Pooled calls now reject an already-aborted signal before leasing a connection.
- e6acfc6: Add `recursiveCte` for typed `WITH RECURSIVE` queries: the anchor defines the row contract, the self-reference is scoped to its recursive branch, nullable widening is declared explicitly, and unsupported Snowflake recursion forms are rejected before execution.
- d9e873a: Add relation loading. `one` and `many` declare related tables by key, and `withRelations` loads them with one parent query plus one query per relation and batch of parent keys, keeping parent pagination, exact wire types, streaming batches, and transactions. `db.execute()` reports every statement's ID in `queryIds`.
- b41ba3a: Declare GEOGRAPHY, GEOMETRY, and VECTOR columns with `geography(name)`, `geometry(name, { srid })`, and `vector(name, 'int' | 'float', dimension)`. Spatial values are typed GeoJSON geometries decoded with exact coordinates, GEOMETRY results are checked against the declared SRID, VECTOR writes and results are checked against the declared dimension and element type, and code generation emits these declarations.
- ea9a350: Track SQL types on expressions and reject incompatible comparisons, functions, expression helpers, predicates, and assignments, including spatial comparisons and keys, comparisons between structured types and VARIANT, and MIN or MAX over ARRAY, OBJECT, VECTOR, structured, and spatial values; validate GROUP BY, aggregate, and window placement before execution; bind literals compared with JSON paths as JSON.
- 9cf5c7f: Declare semi-structured ARRAY and OBJECT columns with `array(name, elementSchema?)` and `object(name, schema?)`. Results and writes are validated against the declared schema, writes are cast to the column type (including NULL in multi-row inserts), and code generation emits these declarations while rejecting structured `ARRAY(type)` and `OBJECT(...)` columns.

  VARIANT, ARRAY, OBJECT, and `jsonPath()` reads now reject JSON numbers that a JavaScript number cannot hold exactly instead of silently rounding them. SQL NULL array elements, which `TO_JSON` prints as `undefined`, now decode as `null` instead of failing the read.
- 3521073: Declare structured `ARRAY(type)`, `OBJECT(...)`, and `MAP(key, value)` columns with `structured(name, type)` and `structuredType` descriptors. NUMBER elements decode exactly, SQL NULL elements decode as `null`, OBJECT values require exactly the declared fields, MAP values are `Map`s, writes cast to the declared type, and code generation reads exact field names from `SHOW COLUMNS`.
- e87dcf9: Add typed `union`, `unionAll`, `intersect`, and `except` query composition with alias-aligned projection checks, operator-specific nullability, ordering, pagination, CTE hoisting, and derived-table support.
- 17bdeef: Add `exists`, `notExists`, `scalar`, and `inSubquery` subquery expressions with `.correlate()` for correlated outer scopes.
- 225f54d: Add explicit ROWS and RANGE window frames via `rowsBetween` and `rangeBetween`, with validated boundaries, ORDER BY requirements, and numeric or interval RANGE offsets.

### Patch Changes

- 7cdcf26: Raw query rows now treat SQL NULL correctly when a result repeats a column name. The type of the last column with that name decides, matching the SDK's object rows. NULL normalization for `queryRaw` and `streamRaw` rows also costs the same per row whatever the column count (it used to grow quadratically), and typed rows are built with less allocation.
- 70fc744: A `signal` or `timeoutMs` abort that reaches Snowflake before the statement is executing (error `000605`, common on a session's first statement) now retries the cancel instead of rejecting with `Query cancellation failed.` while the statement runs on. When the statement finishes before a cancel takes effect, the request settles with its real result or error, so a caller is never told a committed write failed.
- 2e8a72a: `diffSchema`, `checkDrift`, and `pushSchema` now recognize every constant default spelling Snowflake accepts when adding a column to an existing table: numbers such as `.5`, `-.25`, and `5.`, strings with backslash escapes such as `'it\'s'`, and dollar-quoted strings such as `$$it's$$`. These columns used to be listed under `unsupported`; they are now added with `ADD COLUMN` and compared by value against the stored default.
- 1f0f8f0: Read `float()` columns exactly. Values past 15 significant digits no longer lose precision, and the largest finite DOUBLE no longer decodes to `Infinity`.
- 38bfb9e: License Snowtyped under MIT, include the license in installed packages, and
  prepare public alpha/beta releases with reviewed npm staging and provenance.
- ac70e4e: CTE sources (`query.asCte('SRC')`) now work in `mergeInto()`, `updateFrom()`, and `deleteUsing()`. DML has no WITH clause, so the CTE's query is inlined as a derived source instead of referencing an undefined name (MERGE) or being rejected (UPDATE FROM / DELETE USING).
- 13f1b27: Order by projection aliases when an ORDER BY expression is also selected, so grouped queries can order by a window function over an aggregate.
- b5a9281: Qualify unprojected ORDER BY columns so a projection alias with the same name no longer captures them and silently changes the sort order.
- 4a85853: Pooled requests stop waiting for a connection when their `signal` aborts or `timeoutMs` elapses, connections whose Snowflake session terminated are destroyed instead of reused, and concurrent `close()` calls wait for the same drain.
- 155e53c: `createPool` accepts `testOnBorrow` to heartbeat each connection before lending it.
- 3627288: When a transaction's ROLLBACK fails, pools now destroy the connection instead of returning it for reuse, and a single-connection client rejects further operations on it.
- 7f177e2: Honor the UTC offset in `timeTravel(table, { timestamp })`. The selector is now cast to `TIMESTAMP_TZ`, so `'2026-10-22T15:00:00-07:00'` selects that instant instead of being read as 15:00 UTC.

  Timestamps without an offset are now read in the session `TIMEZONE` instead of as UTC. Snowflake's default session time zone is `America/Los_Angeles`, so unless your sessions set `TIMEZONE = 'UTC'`, an offset-less string now points several hours later than before (which can fail with "Future data is not yet available" or select a different snapshot). To keep the old meaning, append `Z` or `+00:00` to UTC timestamps.
- 626e0d3: Fix inserts that write NULL to VARIANT or BINARY columns. NULL is now wrapped like non-null values (`PARSE_JSON(?)`, `TO_BINARY(?, 'HEX')`), so single-row and multi-row inserts no longer fail with VARCHAR type mismatches.

## 0.1.0-alpha.2

### Minor Changes

- 79c024b: Declare NUMBER precision/scale, VARCHAR and BINARY length, and TIME/TIMESTAMP fractional precision on columns. Writes and decoded results that do not fit are rejected instead of being silently rounded or truncated, and introspection generates the matching declarations.
- f5a0d33: Add `.serverDefault()`, `.identity()`, and `.virtual()` column metadata, carried through introspection and code generation. Inserts now omit unspecified columns so Snowflake applies their defaults instead of NULL, mixed row shapes compile to a single `INSERT ALL`, and writes to virtual columns are rejected.
- 1e989c5: Add the `snowtyped/ddl` entry point: physical column types and table definitions derived from declared tables, their size options, and their server values (DEFAULT, AUTOINCREMENT, AS), schema and table DDL builders, schema inspection and deterministic diffs, drift checks, a direct `pushSchema`, and a migration runner with per-statement history, a lease lock, destructive-change acknowledgement, and explicit resume after partially applied migrations.
- 8f88d62: Add typed `cast`, `avg`, `add`/`sub`/`mul`/`div`, `coalesce`, `caseWhen`, `concat`/`trim`/`length`/`substring`, `dateTrunc`/`dateAdd`/`dateDiff`/`datePart`, and `rank`/`denseRank`/`lag`/`lead` expressions with Snowflake result domains and nullability.
- 2f70384: Add typed `matchRecognize` table sources with a composable `rowPattern` API, variable-scoped `define` and `measures`, and schema-derived output columns for every rows-per-match mode. Comparisons against literal-typed expressions now keep their source scope.
- 3d7855a: Add `insertFrom`, `updateFrom`, and `deleteUsing` for typed INSERT … SELECT, UPDATE … FROM, and DELETE … USING mutations; the sourced UPDATE and DELETE forms require a join predicate. MERGE now accepts ordered conditional branches through an optional condition on `whenMatchedUpdate`, `whenMatchedDelete`, and `whenNotMatchedInsert`, rejects unreachable branches, and limits NOT MATCHED values and conditions to the source scope.
- f622a29: Add nested object projections. Plain objects in `select` and `.select()` projections decode into nested result objects with schema-derived types and validation, and an object over an outer-joined source becomes `null` when its NOT NULL keys show the joined row is absent.
- 81a7543: Add typed `pivot` and `unpivot` table sources with schema-derived output columns, plus `dynamicPivot` for `IN (ANY)` pivots as unvalidated raw queries.
- d8298ce: Buffered `queryRaw` now accepts `{ signal, timeoutMs }` for reusable `sql` queries, matching `execute`, `stream`, and `streamRaw` cancellation on single-connection and pooled clients.
  Pooled calls now reject an already-aborted signal before leasing a connection.
- e6acfc6: Add `recursiveCte` for typed `WITH RECURSIVE` queries: the anchor defines the row contract, the self-reference is scoped to its recursive branch, nullable widening is declared explicitly, and unsupported Snowflake recursion forms are rejected before execution.
- d9e873a: Add relation loading. `one` and `many` declare related tables by key, and `withRelations` loads them with one parent query plus one query per relation and batch of parent keys, keeping parent pagination, exact wire types, streaming batches, and transactions. `db.execute()` reports every statement's ID in `queryIds`.
- b41ba3a: Declare GEOGRAPHY, GEOMETRY, and VECTOR columns with `geography(name)`, `geometry(name, { srid })`, and `vector(name, 'int' | 'float', dimension)`. Spatial values are typed GeoJSON geometries decoded with exact coordinates, GEOMETRY results are checked against the declared SRID, VECTOR writes and results are checked against the declared dimension and element type, and code generation emits these declarations.
- ea9a350: Track SQL types on expressions and reject incompatible comparisons, functions, expression helpers, predicates, and assignments, including spatial comparisons and keys, comparisons between structured types and VARIANT, and MIN or MAX over ARRAY, OBJECT, VECTOR, structured, and spatial values; validate GROUP BY, aggregate, and window placement before execution; bind literals compared with JSON paths as JSON.
- 9cf5c7f: Declare semi-structured ARRAY and OBJECT columns with `array(name, elementSchema?)` and `object(name, schema?)`. Results and writes are validated against the declared schema, writes are cast to the column type (including NULL in multi-row inserts), and code generation emits these declarations while rejecting structured `ARRAY(type)` and `OBJECT(...)` columns.

  VARIANT, ARRAY, OBJECT, and `jsonPath()` reads now reject JSON numbers that a JavaScript number cannot hold exactly instead of silently rounding them. SQL NULL array elements, which `TO_JSON` prints as `undefined`, now decode as `null` instead of failing the read.
- 3521073: Declare structured `ARRAY(type)`, `OBJECT(...)`, and `MAP(key, value)` columns with `structured(name, type)` and `structuredType` descriptors. NUMBER elements decode exactly, SQL NULL elements decode as `null`, OBJECT values require exactly the declared fields, MAP values are `Map`s, writes cast to the declared type, and code generation reads exact field names from `SHOW COLUMNS`.
- e87dcf9: Add typed `union`, `unionAll`, `intersect`, and `except` query composition with alias-aligned projection checks, operator-specific nullability, ordering, pagination, CTE hoisting, and derived-table support.
- 17bdeef: Add `exists`, `notExists`, `scalar`, and `inSubquery` subquery expressions with `.correlate()` for correlated outer scopes.
- 225f54d: Add explicit ROWS and RANGE window frames via `rowsBetween` and `rangeBetween`, with validated boundaries, ORDER BY requirements, and numeric or interval RANGE offsets.

### Patch Changes

- 70fc744: A `signal` or `timeoutMs` abort that reaches Snowflake before the statement is executing (error `000605`, common on a session's first statement) now retries the cancel instead of rejecting with `Query cancellation failed.` while the statement runs on. When the statement finishes before a cancel takes effect, the request settles with its real result or error, so a caller is never told a committed write failed.
- 2e8a72a: `diffSchema`, `checkDrift`, and `pushSchema` now recognize every constant default spelling Snowflake accepts when adding a column to an existing table: numbers such as `.5`, `-.25`, and `5.`, strings with backslash escapes such as `'it\'s'`, and dollar-quoted strings such as `$$it's$$`. These columns used to be listed under `unsupported`; they are now added with `ADD COLUMN` and compared by value against the stored default.
- 1f0f8f0: Read `float()` columns exactly. Values past 15 significant digits no longer lose precision, and the largest finite DOUBLE no longer decodes to `Infinity`.
- ac70e4e: CTE sources (`query.asCte('SRC')`) now work in `mergeInto()`, `updateFrom()`, and `deleteUsing()`. DML has no WITH clause, so the CTE's query is inlined as a derived source instead of referencing an undefined name (MERGE) or being rejected (UPDATE FROM / DELETE USING).
- 13f1b27: Order by projection aliases when an ORDER BY expression is also selected, so grouped queries can order by a window function over an aggregate.
- b5a9281: Qualify unprojected ORDER BY columns so a projection alias with the same name no longer captures them and silently changes the sort order.
- 4a85853: Pooled requests stop waiting for a connection when their `signal` aborts or `timeoutMs` elapses, connections whose Snowflake session terminated are destroyed instead of reused, and concurrent `close()` calls wait for the same drain.
- 155e53c: `createPool` accepts `testOnBorrow` to heartbeat each connection before lending it.
- 3627288: When a transaction's ROLLBACK fails, pools now destroy the connection instead of returning it for reuse, and a single-connection client rejects further operations on it.
- 7f177e2: Honor the UTC offset in `timeTravel(table, { timestamp })`. The selector is now cast to `TIMESTAMP_TZ`, so `'2026-10-22T15:00:00-07:00'` selects that instant instead of being read as 15:00 UTC.

  Timestamps without an offset are now read in the session `TIMEZONE` instead of as UTC. Snowflake's default session time zone is `America/Los_Angeles`, so unless your sessions set `TIMEZONE = 'UTC'`, an offset-less string now points several hours later than before (which can fail with "Future data is not yet available" or select a different snapshot). To keep the old meaning, append `Z` or `+00:00` to UTC timestamps.
- 626e0d3: Fix inserts that write NULL to VARIANT or BINARY columns. NULL is now wrapped like non-null values (`PARSE_JSON(?)`, `TO_BINARY(?, 'HEX')`), so single-row and multi-row inserts no longer fail with VARCHAR type mismatches.

## 0.1.0-alpha.1

### Patch Changes

- 38bfb9e: License Snowtyped under MIT, include the license in installed packages, and
  prepare public alpha/beta releases with reviewed npm staging and provenance.

## 0.1.0-alpha.0 — 2026-10-22

- Added schema-derived TypeScript inference and compiled Zod 4 validation.
- Added typed expressions, aliases, inner/outer/cross joins, grouping, aggregates, ordering, pagination, derived tables, and CTEs.
- Added window expressions, QUALIFY, correlated FLATTEN, ASOF JOIN, and time-travel source modifiers.
- Added INSERT, UPDATE, DELETE, and MERGE.
- Added parameterized raw tags with query-time result assertions and unknown defaults.
- Added SDK execution, validated streams, raw streams, AbortSignal/deadline cancellation, transactions, and connection pooling.
- Added exact numeric and temporal wire serialization, binary/VARIANT schemas, database introspection, and declaration generation.
- Added dual ESM/CJS distributions, declaration and tarball checks, tree-shaking checks, and seeded Snowflake integration tests.

This alpha remains private while licensing and API review are finalized. Unmodeled Snowflake syntax is available through raw SQL; this release does not promise exhaustive typed coverage of Snowflake's grammar.
