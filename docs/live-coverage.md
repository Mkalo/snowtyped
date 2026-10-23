# Live Snowflake coverage

Maps each supported runtime feature to the live tests that assert its SQL behavior
and returned values against Snowflake. Files are under `tests/integration/`. Every
file creates its own `SFLIB_TEST_<uuid>` schema through `tests/support/snowflake.ts`
and drops it afterwards.

Every public runtime export and builder method must appear in backticks in the
first column of a table below; `tests/unit/live-coverage.test.ts` enforces that.
A feature with server semantics needs a live row. Type-only contracts, invalid construction, client-side guards,
and packaging stay in type, unit, and package tests and are listed under
exclusions with the reason.

## Queries

| Feature                                                            | Live tests                         | Scenarios                                                                                                                                                       |
| ------------------------------------------------------------------ | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `select`, `.select`, `.where`, `snowflakeTable`                    | `queries`, `snowflake`             | Full and partial projections, schema-qualified tables, unordered population checks                                                                              |
| `eq`, `ne`, `gt`, `gte`, `lt`, `lte`                               | `queries`                          | Integers above 2^53 (and the neighbor that must not match), exact decimals, column-to-column                                                                    |
| NULL comparisons, `isNull`, `isNotNull`                            | `queries`, `snowflake`, `features` | `eq(x, null)`/`ne(x, null)` as IS [NOT] NULL, three-valued `ne`/`not` excluding NULLs, IS NULL on a required column                                             |
| `and`, `or`, `not`                                                 | `queries`                          | Nested combinations, single-operand AND, NOT over OR                                                                                                            |
| `inArray`                                                          | `queries`                          | Matches with unknown values, negated, empty (FALSE), empty negated (TRUE), injection-like text                                                                  |
| `like`, `ilike`, `lower`, `upper`                                  | `queries`                          | `%` and `_` wildcards, case sensitivity, nullable inputs, functions in projections and predicates                                                               |
| `asc`, `desc`, `.orderBy`                                          | `queries`, `features`              | Multiple keys, NULLS FIRST/LAST both directions, ordering by unprojected expressions through the wire wrapper, native numeric order of serialized integers      |
| `.limit`, `.offset`                                                | `queries`, `features`              | First page, middle page, LIMIT 0, offset past the end                                                                                                           |
| `.distinct`                                                        | `queries`, `features`              | Boolean domain, DISTINCT with ORDER BY and LIMIT                                                                                                                |
| `count`, `sum`, `min`, `max`                                       | `queries`, `types`                 | COUNT(*), COUNT(column) skipping NULLs, COUNT DISTINCT, typed MIN/MAX for integer/decimal/text/date/time/timestamp, exact decimal SUM, empty input (0 and NULL) |
| `.groupBy`, `.having`                                              | `queries`, `features`              | Single and composite keys including a predicate key, HAVING with AND over aggregates, empty grouped input                                                       |
| `over`, `rowNumber`, `.qualify`                                    | `queries`, `features`              | Partitioned totals, ordered running sums, unpartitioned windows, QUALIFY on unprojected windows, ranking grouped aggregates                                     |
| `alias`                                                            | `queries`, `features`              | Self-join with case-sensitive aliases containing spaces                                                                                                         |
| Projection aliases                                                 | `queries`                          | Output keys with spaces, quotes, and mixed case                                                                                                                 |
| `.innerJoin`, `.leftJoin`, `.rightJoin`, `.fullJoin`, `.crossJoin` | `queries`, `features`              | Unmatched rows on either side become NULL, anti-join via IS NULL, cross product                                                                                 |
| `.as` (derived tables)                                             | `queries`, `features`              | Joined to base tables, nested derived tables, outer-join nullability carried through, DISTINCT/LIMIT inside                                                     |
| `.asCte`                                                           | `queries`, `features`              | Single CTE, two CTEs joined (each defined once), left-joined CTE                                                                                                |
| `jsonPath`                                                         | `queries`, `features`              | Keys, array indexes, literal dotted keys, nested keys, JSON null, missing paths, injection-like keys, IS NULL on paths                                          |
| `flatten`, `.lateralJoin`                                          | `queries`, `features`              | `path`, `outer` on empty arrays, `mode: 'OBJECT'`, `recursive`, all output columns                                                                              |
| `.asofJoin`                                                        | `queries`, `features`              | `>=`, `<=`, `<` match conditions, with and without the key predicate, unmatched rows                                                                            |
| `timeTravel`                                                       | `queries`, `features`              | AT/BEFORE by statement, offset, UTC timestamp, aliased snapshot diffed against current data                                                                     |

## Column families and wire representations

| Feature                          | Live tests           | Scenarios                                                                                                           |
| -------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `integer`                        | `types`, `snowflake` | ±(10^38 − 1), 0, 2^53 + 1, NULL, filters and ordering                                                               |
| `decimal`                        | `types`, `snowflake` | 38-digit precision at scale 4, scale padding (`0.10`), negative fractions, SUM                                      |
| `float`                          | `types`, `features`  | Fractions, negative exponents, zero, NULL, NaN/Infinity rejected                                                    |
| `boolean`                        | `types`, `snowflake` | TRUE, FALSE, NULL, boolean filter bindings                                                                          |
| `text`                           | `types`, `writes`    | Empty string, the literal text `NULL`, quotes, backslashes, newlines, emoji                                         |
| `binary`                         | `types`, `features`  | All 256 byte values, empty, single zero byte, NULL, equality filters                                                |
| `date`                           | `types`, `features`  | 0001-01-01, 9999-12-31, leap day, NULL                                                                              |
| `time`                           | `types`, `features`  | Midnight, 23:59:59.999999999, fractional padding, NULL                                                              |
| `timestamp` (`ntz`, `ltz`, `tz`) | `types`, `features`  | Nanoseconds, offsets including `Z` and `-11:00`, LTZ rendered in two session time zones, instant comparison filters |
| `variant`                        | `types`, `features`  | Objects, arrays, JSON scalars, JSON null and SQL NULL, unicode, declared Zod shapes accepted and rejected           |
| Declaration conflicts            | `types`, `snowflake` | Required over NULL, integer over scale>0, boolean/binary/date over text, VARIANT shape mismatch                     |
| Raw wire values                  | `types`, `execution` | Numbers and dates as exact text, JSON text, Buffers, NULL sentinels vs the text `NULL`                              |

## Writes

| Feature                                                                          | Live tests                        | Scenarios                                                                                           |
| -------------------------------------------------------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------- |
| `insert`                                                                         | `writes`, `features`              | Single and multi-row, omitted nullable columns, `affectedRows`                                      |
| `update`, `.where`                                                               | `writes`, `features`              | Literals, NULL, same-table expressions, unfiltered, unmatched (0 rows)                              |
| `deleteFrom`                                                                     | `writes`, `features`              | Filtered, unmatched, unfiltered                                                                     |
| `mergeInto`, `.whenMatchedUpdate`, `.whenMatchedDelete`, `.whenNotMatchedInsert` | `writes`, `features`              | Table, aliased, and derived sources, repeated MERGE, unmatched predicate, `affectedRows`            |
| Quoted identifiers                                                               | `writes`                          | Table and columns that differ only by case, names with spaces and quotes                            |
| Injection-like data                                                              | `writes`, `snowflake`, `features` | Quotes, comments, placeholders, dollar quoting, reused in `eq` and `like`                           |
| Rejected writes                                                                  | `writes`                          | VARCHAR length and NUMBER overflow, NOT NULL violation, multi-row atomicity, nondeterministic MERGE |

## Raw SQL and execution

| Feature                                                | Live tests                  | Scenarios                                                                                                                                                          |
| ------------------------------------------------------ | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sql`, `.queryRaw`                                     | `execution`, `features`     | Typed and unknown results, nested fragments keep bind order, string/number/bigint/boolean/null/Date bindings, reusable typed builders                              |
| `sql.identifier`, `sql.join`, `sql.json`, `sql.unsafe` | `execution`                 | Quoted names, IN lists and AND-joined predicates, bound PARSE_JSON queried by path, trusted ORDER BY text                                                          |
| `.stream`, `.streamRaw`                                | `execution`, `features`     | 20,000-row multi-chunk results in order, early `break`, validation failure mid-stream, recovery afterwards                                                         |
| `.execute` options (`signal`, `timeoutMs`)             | `execution`, `features`     | Abort during execution, deadline, pre-aborted signal, abort after rows arrive; connection reused afterwards                                                        |
| `.transaction`                                         | `execution`, `features`     | Commit of several statements with a return value, streaming inside, rollback after callback and server errors, read-your-writes                                    |
| `createClient`                                         | all files                   | The fixture client on a caller-owned connection                                                                                                                    |
| `createPool`, `.close`                                 | `execution`, `features`     | Session bound by `max`, concurrent work, pooled transaction isolation and rollback, release after failure, cancellation, and early stream closure, use after close |
| `introspect`                                           | `introspection`, `features` | Every supported type, precision/scale, nullability, case-sensitive names, schema and database scope                                                                |
| `generateSchema`                                       | `introspection`, `features` | Generated code type-checks with the expected inferred row types, then reads and writes the live tables; unsupported types fail                                     |

## Exclusions

| Feature                                                                                        | Covered by                                                | Reason                                                                            |
| ---------------------------------------------------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `compileAst`, `.compile`, `identifier`, `quoteIdentifier`                                      | unit tests                                                | Exercised by every live statement; direct calls have no separate server semantics |
| Builder validation (scope, phase, QUALIFY, ASOF operator, identifier limits, empty mutations)  | unit and type tests                                       | Rejected before SQL reaches Snowflake                                             |
| Transaction guards (reserved connection, expired client, nested transactions, running queries) | `tests/unit/execution.test.ts`                            | Client-side state; races cannot be reproduced reliably against a server           |
| Cancellation races (abort before/after completion, cancel failures)                            | `tests/unit/execution.test.ts`, `tests/unit/pool.test.ts` | Timing-dependent; live tests cover the deterministic paths                        |
| Packaging, exports, tree shaking                                                               | package tests                                             | No server semantics                                                               |

## Known gaps

Open bugs on main whose live tests would fail today. Each issue asks for its live
test, and the fix adds it instead of this suite asserting the wrong behavior:
- NULL into VARIANT/BINARY and mixed NULL rows in multi-row inserts: #40 (PR #47).
- Pooled connection reused after a failed transaction ROLLBACK: #41 (PR #45).
- FLOAT values needing more than 15 significant digits: #50 (PR #59).
- `timeTravel` timestamps with a non-UTC offset: #51 (PR #61).
- MERGE from a CTE source: #52 (PR #62).
- VARIANT and JSON path numbers beyond double precision are rounded: #53 (PR #43).
- ORDER BY a projected window over an aggregate: #56 (PR #65).
- Pool keeps handing out terminated connections: #57 (PR #64).
