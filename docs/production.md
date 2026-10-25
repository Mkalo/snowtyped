# Production behavior and baselines

## Scenario coverage

| Scenario                    | Unit                                          | Live (`tests/integration/hardening.test.ts`)                                                         |
| --------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Cancellation                | `execution.test.ts`                           | A running `SYSTEM$WAIT` is cancelled on the server; the connection is reused                         |
| Pool waits                  | `pool-hardening.test.ts`                      | Abort, `timeoutMs`, and `acquireTimeoutMillis` while waiting leak no lease                           |
| Streaming                   | `pool-hardening.test.ts`, `execution.test.ts` | 1M rows (300 MB of text) stream under a 200 MB live-memory bound; `break` releases the lease         |
| Pool pressure and `close()` | `pool-hardening.test.ts`                      | 24 requests on `max: 3` use at most 3 sessions; `close()` drains in-flight work                      |
| Transactions                | `execution.test.ts`, `pool.test.ts`           | A long-lived pooled transaction stays invisible to other connections until COMMIT; ROLLBACK discards |
| Failures                    | `pool-hardening.test.ts`                      | SDK errors release the lease; a terminated session is replaced                                       |
| No implicit retries         | `pool-hardening.test.ts`                      | A failed INSERT appears once in `QUERY_HISTORY_BY_SESSION`                                           |
| Sustained use               | `pool-hardening.test.ts`                      | 12 workers mix queries, streams, and transactions on `max: 4`; every connection closes               |

Set `SNOWTYPED_SOAK_SECONDS` to lengthen the sustained run (default 15).

## Operational boundaries

User-facing limits (pool waits, deadlines, session failures, streaming memory, and
type-checking cost) are in the [production use guide](../website/src/content/docs/guides/production.mdx).
Update it with this file when a measurement changes.

## Resource cleanup

Each live test file creates one `SFLIB_TEST_<uuid>` schema and drops only that schema.
Every pool a test opens is closed in `finally`, and the sustained run asserts that the SDK
pool ends with no open, borrowed, or pending connections. If a run is killed, drop leftover
`SFLIB_TEST_*` schemas in the test database by hand.

## Baselines

Measured on 2026-10-23 and 2026-10-24 on Linux x64 (cloud container), Node.js 22.22, TypeScript
6.0.3, and snowflake-sdk 3.4.0 against an X-Small warehouse. Treat them as orders of magnitude.

### Type inference and editor latency

`pnpm bench:types [--tables N] [--columns N] [--joins N] [--json]` generates a schema in which
each table has `columns + 2` mixed-type columns and four statements (filtered select, grouped
aggregate, insert, update), plus a deep query that joins `joins + 1` tables and is wrapped in
a derived table. It reports `tsc --extendedDiagnostics` metrics and TypeScript language
service latency: quick info on the deep query's rows, completions on a row, and quick info
again after an edit.

| Tables × columns, joins | Instantiations | Check time |  Memory | Quick info | After edit | Completions |
| ----------------------- | -------------: | ---------: | ------: | ---------: | ---------: | ----------: |
| 10 × 20, 4              |           220k |      1.7 s |  244 MB |     0.96 s |     0.83 s |       16 ms |
| 50 × 40, 12 (default)   |          1.13M |      5.6 s |  726 MB |      1.6 s |      1.8 s |       18 ms |
| 50 × 40, 24             |          1.14M |      5.3 s |  741 MB |      2.5 s |      2.6 s |       18 ms |
| 50 × 80, 12             |          2.10M |      9.4 s | 1.12 GB |      2.7 s |      3.5 s |       19 ms |
| 100 × 40, 12            |          2.13M |     11.8 s | 1.21 GB |      1.8 s |      2.8 s |       20 ms |

Checking cost grows linearly with tables × columns; join depth mainly affects editor latency
on the joined query. `pnpm test:bench` fails if the 10 × 20 case exceeds 340k instantiations.
Checking the deprecated flat type aliases costs a fixed 11k of them until 2.0 removes them.

### Client-side cost

`pnpm bench:runtime` times statement building and result mapping against a connection that
completes instantly, so only snowtyped's own work is measured. Measured on 2026-10-24:

| Case                                           | Time (p50) |
| ---------------------------------------------- | ---------: |
| Compile a prebuilt `select`                    |      15 µs |
| Build and compile a two-table join with filter |      77 µs |
| Build and compile an insert of 1,000 rows      |     2.1 ms |
| Map a typed row, 8 columns (`execute(select)`) |     0.6 µs |
| Map a raw row, 8 columns (`queryRaw`)          |     0.2 µs |
| Map a raw row, 100 columns                     |     2.6 µs |

Before #82, raw-row NULL normalization was quadratic in the column count (32 µs per
100-column row) and typed rows cost 1.8 µs each.

### Live load

`pnpm bench:load` runs against Snowflake with the integration credentials, creates one
`SFLIB_TEST_<uuid>` schema with a 1M-row table, and drops it afterwards. Set
`SNOWTYPED_LOAD_SECONDS` (pool step length, default 15), `SNOWTYPED_LOAD_SOAK_SECONDS` (default
120), and `SNOWTYPED_LOAD_ROWS` (default 1,000,000). A default run takes about 7 minutes on an
X-Small warehouse and writes `reports/load.md` and `reports/load.json`.

Measured on 2026-10-24 from AWS us-east-2:
- **Round trips.** A point query takes about 130 ms at p50 through the SDK, `execute`, and
  `queryRaw` alike; client-side work is below the noise.
- **Pool throughput.** Each pooled connection runs one statement at a time, so throughput
  follows `max`: 7.5 point queries/s on `max: 1`, 29/s on 4, and 53-67/s on 8. With 16 or 32
  workers on `max: 8`, extra workers only queue (p50 234 ms and 460 ms).
- **Large results (1M rows × 5 columns, one connection).** Typed `stream` reads about 110k rows/s
  with a 220-260 MB peak, and typed `execute` reads about 135-155k rows/s. Raw reads of a
  `TIMESTAMP` column run at 14-27k rows/s and peak at 790-850 MB, because the SDK formats each
  timestamp on the client; the plain SDK behaves the same. Selecting `TO_VARCHAR(column)` instead
  brings a raw stream to about 110k rows/s and 300 MB. Typed queries already format temporal
  values on the server.
- **Soak.** For 120 s, 16 workers on `max: 8` mixed point queries, raw queries, 2,000-row streams,
  single-insert transactions, and 300 ms timeouts on `SYSTEM$WAIT(5)` (about 1,700-1,900
  operations). There were no unexpected errors, every inserted row was present, retained heap
  stayed flat, and the pool ended with no open, borrowed, or pending connections. A transaction
  costs three statements and took about 2 s at p50 under this contention.

The shorter sustained run in `hardening.test.ts` completed 116 operations in 17.1 s with 12
workers on `max: 4`.
