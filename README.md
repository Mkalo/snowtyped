# Snowtyped

A Snowflake-first TypeScript query library built on `snowflake-sdk`, with an owned AST, declared schemas, inferred results, and compiled Zod 4 runtime validation. Parameterized raw SQL is also supported, with a query-time return type or `unknown` by default.

Alpha software under the [MIT license](LICENSE); the public API may change before a stable release. The [release contract](docs/release-contract.md) defines the stable API, supported versions, and release gates.

## Development and verification

Use Node.js 22.18+ or 24.11+ and the pnpm version pinned in `package.json`.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test:integration
```

`pnpm check` runs Biome, strict TypeScript checks and type fixtures, offline unit tests with 100% per-file coverage thresholds, ESM/CJS builds, publint, Are the Types Wrong, and tests against an installed tarball. Those package tests check `import`, `require`, mixed-format interoperability, NodeNext/Bundler declaration resolution, and tree shaking. CI targets Windows/Linux and Node 22/24.

See [CI and release checks](docs/ci.md) for the required matrix gate, retained diagnostics, and release prerequisites.

Live tests require your test account configuration. See [Snowflake setup](docs/snowflake-setup.md). Each run creates a unique schema, seeds fixtures, and drops only its own schema. The manual integration workflow uses a dedicated GitHub environment. Tests consume real Snowflake credits.

## Declared schemas and typed queries

```ts
import { eq, integer, select, snowflakeTable, text } from 'snowtyped';
import { createClient } from 'snowtyped/snowflake';

const customers = snowflakeTable(
  'CUSTOMERS',
  {
    id: integer('ID').notNull(),
    name: text('NAME').notNull(),
    email: text('EMAIL'),
  },
  { database: 'APP_DB', schema: 'PUBLIC' },
);

// connection is an already-connected snowflake-sdk Connection.
const db = createClient(connection);
const { rows, queryId } = await db.execute(
  select(customers, {
    id: customers.columns.id,
    email: customers.columns.email,
  }).where(eq(customers.columns.name, 'Ada')),
);
// rows: readonly { readonly id: bigint; readonly email: string | null }[]
```

Schema declarations determine both result types and runtime validation. Users do not supply result interfaces or decoders for structured queries. Invalid returned values reject execution. Columns default to nullable; `.notNull()` removes SQL nullability. Identifiers preserve exact physical names, including case, punctuation, and qualification. Projection keys become exact output aliases.

The compiler serializes exact numeric and temporal outputs after the native query's joins, grouping, window filtering, DISTINCT, ordering, and pagination. Nested sources retain their native SQL types; numeric sorting remains numeric. SDK NULL sentinels are normalized using result-column metadata, preserving a text value that happens to equal `NULL`.

| Declaration                             | Non-null output           | Notes                                       |
| --------------------------------------- | ------------------------- | ------------------------------------------- |
| `text('NAME')`                          | `string`                  | Text                                        |
| `integer('ID')`                         | `bigint`                  | Exact integral NUMBER                       |
| `decimal('BALANCE')`                    | `string`                  | Exact fixed-point decimal text              |
| `float('VALUE')`                        | `number`                  | Finite floating-point values                |
| `boolean('ACTIVE')`                     | `boolean`                 | No truthiness coercion                      |
| `date('DAY')`                           | `string`                  | Calendar date                               |
| `time('CLOCK')`                         | `string`                  | Time with up to nine fractional digits      |
| `timestamp('AT', 'ntz' / 'ltz' / 'tz')` | `string`                  | Nanoseconds retained; LTZ/TZ include offset |
| `binary('DATA')`                        | `Uint8Array`              | SDK Buffers are accepted                    |
| `variant('PAYLOAD')`                    | `unknown`                 | JSON without an assumed shape               |
| `array('TAGS')`                         | `unknown[]`               | Semi-structured ARRAY                       |
| `object('META')`                        | `Record<string, unknown>` | Semi-structured OBJECT                      |
| `geography('LOCATION')`                 | `GeoJsonGeometry`         | GeoJSON geometry, exact coordinates         |
| `geometry('SHAPE', { srid: 4326 })`     | `GeoJsonGeometry`         | Exact coordinates; SRID checked (default 0) |
| `vector('EMBEDDING', 'float', 768)`     | `number[]`                | FLOAT32 or INT32 elements, fixed dimension  |

Declare a structured JSON shape at the column, for example `variant('PAYLOAD', z.object({ items: z.array(z.number()) }))`. Likewise `array('TAGS', z.string())` declares element values and `object('META', z.object({ ok: z.boolean() }))` declares an OBJECT shape. A type parameter alone cannot establish a JSON shape. The declaration is checked at runtime, and read/write types are inferred from it. JSON numbers that a JavaScript number cannot hold exactly, such as integers beyond 2^53, reject the result instead of being rounded. Structured `ARRAY(type)`, `OBJECT(...)`, and `MAP` columns are not supported yet, and code generation rejects them.

Spatial values are GeoJSON geometry objects; Features, `bbox`, and `crs` members are rejected. GEOMETRY results must carry the declared SRID. Snowflake does not support `=` on spatial values. VECTOR writes must match the declared dimension; FLOAT elements are stored as FLOAT32, so results return the nearest FLOAT32 value.

Declare physical constraints with `integer('QTY', { precision: 9 })`, `decimal('BALANCE', { precision: 12, scale: 2 })`, `text('CODE', { length: 3 })`, `binary('HASH', { length: 32 })`, `time('CLOCK', { precision: 3 })`, or `timestamp('AT', 'ltz', { precision: 6 })`. INSERT, UPDATE, and MERGE values and decoded results are rejected when they do not fit, including extra scale or fractional seconds that Snowflake would silently round or truncate; zeros that do not change the value are accepted. VARCHAR length counts code points and BINARY length counts bytes. Predicate literals are not constrained. Other database constraints remain database-enforced; declarations should match the physical schema.

## Query composition

`select(table)` selects all declared columns. `select(table, projection)` or `.select(projection)` selects specific columns and expressions. Builders are immutable; a later call to a clause such as `.where()` replaces that clause on the new query.

Supported helpers include `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `and`, `or`, `not`, `isNull`, `isNotNull`, `inArray`, `like`, `ilike`, `lower`, `upper`, `concat`, `trim`, `length`, `substring`, `count`, `sum`, `avg`, `min`, `max`, `add`, `sub`, `mul`, `div`, `coalesce`, and `caseWhen`. `asc`/`desc` accept optional `FIRST`/`LAST` null ordering. Empty membership lists compile to a constant false (or true for negated membership). `cast(value, type)` converts to any declared scalar domain except VARIANT and BINARY (`'decimal'` takes precision and scale) and keeps the input's nullability.

Arithmetic keeps integer operands as `bigint`, except that integer division yields an exact decimal; any FLOAT operand yields `number`. Literal operands are bound and cast to the left operand's domain. `coalesce(value, ...fallbacks)` is non-null when any argument is non-null. `caseWhen(predicate, value).when(predicate, value).else(value)` is nullable without `.else()`. COALESCE and CASE values share one domain, and literal values are cast to it. `dateTrunc`, `dateAdd`, `dateDiff`, and `datePart` take a lowercase date part and reject parts that do not apply to DATE or TIME inputs; adding a time part to a DATE yields TIMESTAMP_NTZ.

```ts
const query = select(customers)
  .leftJoin(orders, eq(customers.columns.id, orders.columns.customerId))
  .select({ name: customers.columns.name, orderId: orders.columns.id });
// orderId is nullable even if ORDERS.ID is declared .notNull().
```

Project joined columns after joining so they are in scope. Inner, left, right, full, and cross joins are supported. Use `alias(table, 'c')` for repeated table names. Table/alias scopes are checked statically and at runtime; dynamic identities that share a static name are distinguished at runtime.

Use `.groupBy(...)`, `.having(predicate)`, `.orderBy(...)`, `.distinct()`, `.limit(n)`, and `.offset(n)`. Counts decode as `bigint`; sums decode as exact decimal strings, with nullability for empty groups. Averages of fixed-point values decode as exact decimal strings (Snowflake adds six fractional digits); FLOAT averages decode as `number`. Grouping legality beyond supported expression/scope checks is enforced by Snowflake. DISTINCT order expressions must be projected.

`.as('name')` turns a query into a derived table; `.asCte('name')` makes a CTE source. Its `.columns` retain inferred output types and outer-join nullability. Selecting or joining a CTE includes its definition automatically.

```ts
const active = select(customers, { id: customers.columns.id, email: customers.columns.email });
const legacy = select(archived, { email: archived.columns.email, id: archived.columns.id });
const all = active.union(legacy);
const page = all.orderBy(asc(all.columns.id)).limit(50);
```

`.union()`, `.unionAll()`, `.intersect()`, and `.except()` combine queries whose projections have the same aliases and domains; branches are aligned by alias. UNION results are nullable when either branch is, INTERSECT only when both are, and EXCEPT keeps the left branch's types. Mixed numeric families (integer, decimal, float) or temporal kinds are rejected; same-family precision and scale widen in Snowflake. Chained calls apply to the whole preceding query, and nesting groups explicitly: every operand is parenthesized, so INTERSECT's higher keyword precedence never regroups a query. Order and paginate a combined query with its own `.columns`; branch CTEs are hoisted into one leading WITH, and serialization happens only after the set operation. Combined queries also support `.as()` and `.asCte()`.

## Snowflake syntax

```ts
const rank = rowNumber({
  partitionBy: [orders.columns.customerId],
  orderBy: [desc(orders.columns.amount)],
});
const latest = select(orders, { id: orders.columns.id, rank }).qualify(eq(rank, 1n));
const running = over(sum(orders.columns.amount), {
  partitionBy: [orders.columns.customerId],
  orderBy: [asc(orders.columns.id)],
  frame: rowsBetween('UNBOUNDED PRECEDING', 'CURRENT ROW'),
});

const items = flatten(jsonPath(events.columns.payload, 'items'), 'items');
const expanded = select(events)
  .lateralJoin(items)
  .select({ eventId: events.columns.id, value: items.columns.value });

const prices = select(trades)
  .asofJoin(quotes, gte(trades.columns.at, quotes.columns.at))
  .select({ at: trades.columns.at, price: quotes.columns.price });
```

`over(aggregate, options)` supports aggregate windows. An explicit `frame` (`rowsBetween(start, end)` or `rangeBetween(start, end)`) requires ORDER BY and an aggregate; ranking functions such as `rowNumber` reject frames. `rank` and `denseRank` take the same options with a required `orderBy`. `lag(value, options)` and `lead` also accept `offset` and a `default` in the value's domain; they are nullable unless both the value and the default are non-null. Boundaries are `'UNBOUNDED PRECEDING'`, `'CURRENT ROW'`, `'UNBOUNDED FOLLOWING'`, `{ preceding: n }`, or `{ following: n }`, and the start cannot follow the end. ROWS offsets are nonnegative integers. RANGE offsets need exactly one ORDER BY expression: numeric offsets for a numeric or date key, or `{ preceding: n, unit: 'DAY' }` intervals for a date or timestamp key. Empty frames yield NULL aggregates and zero counts. Snowflake's frame-size limits remain database-enforced. QUALIFY requires a window in the projection or predicate. FLATTEN exposes its fixed output columns and supports `path`, `outer`, `recursive`, and `mode`. Its input can refer only to preceding sources. ASOF's right side is nullable and supports an optional key-match predicate.

```ts
const quarterly = pivot(sales, 'quarterly', {
  aggregate: 'sum',
  value: 'amount',
  for: 'quarter',
  in: { q1: 'Q1', q2: 'Q2' },
  default: '0',
});
const monthly = unpivot(budget, 'monthly', { value: 'amount', for: 'month', in: ['jan', 'feb'] });
```

`pivot` groups by every other source column; narrow the source with `.as()` first. Pivoted columns are nullable unless `aggregate` is `count` or a `default` is given, and `in` values are rendered as escaped literals because Snowflake does not accept binds there. `unpivot` requires same-typed columns (Snowflake also rejects differing NUMBER scale or timestamp precision), types `for` as the union of their keys, and drops nulls unless `includeNulls` is set. `dynamicPivot` compiles `IN (ANY)` to a raw query with `unknown` rows, since its columns are only known at execution.

`timeTravel(table, { offset: -60 })`, `{ timestamp: '...' }`, or `{ statement: '...' }` adds a bound AT selector. Pass `'BEFORE'` as the third argument for BEFORE semantics. Timestamps are cast to `TIMESTAMP_TZ`, so an explicit offset (`2026-10-22T15:00:00-07:00`) is honored and a string without one is read in the session `TIMEZONE`. Database retention and supported selector rules still apply.

## Writes

```ts
await db.execute(insert(customers, { id: 1n, name: 'Ada', email: null }));
await db.execute(update(customers, { name: 'Grace' }).where(eq(customers.columns.id, 1n)));
await db.execute(deleteFrom(customers).where(eq(customers.columns.id, 1n)));

const byId = eq(target.columns.id, staged.columns.id);
await db.execute(insertFrom(target, select(staged, { id: staged.columns.id })));
await db.execute(updateFrom(target, staged, byId, { name: staged.columns.name }));
await db.execute(deleteUsing(target, staged, byId).where(eq(staged.columns.name, 'gone')));

await db.execute(
  mergeInto(target, staged, byId)
    .whenMatchedDelete(eq(staged.columns.name, 'gone'))
    .whenMatchedUpdate({ name: staged.columns.name })
    .whenNotMatchedInsert({ id: staged.columns.id, name: staged.columns.name }),
);
```

INSERT accepts one row or an array of rows. Required columns must be present. Omitted columns are left out of the statement, so Snowflake applies their DEFAULT, identity, or NULL; explicit `null` stays NULL. Rows that omit different columns compile to one conditional `INSERT ALL` that uses DEFAULT per row; Snowflake consumes identity and sequence values for every branch, so such inserts leave gaps. Declare server-populated columns with `.serverDefault(sql?)` or `.identity({ start, increment, order }?)` to make them optional on insert even when `.notNull()`. `.virtual(sql?)` marks a computed `AS (expr)` column, which is read-only: insert, update, and MERGE types exclude it and reject it at runtime. Query builders do not emit DDL for these modifiers; `snowtyped/ddl` renders them as `DEFAULT`, `AUTOINCREMENT`, and `AS (expr)`. `insertFrom` maps selected names to target columns, and the selected row type must fit the target. UPDATE accepts typed literal values and expressions from its table. `updateFrom` and `deleteUsing` take one table or derived source and a required join predicate; `.where()` adds to it. MERGE branches run in the order added, and each takes an optional condition. An unconditional branch must be the last of its kind, and NOT MATCHED branches may only reference the source. Statements return `{ affectedRows, queryId }`. UPDATE and DELETE without `.where()` affect all rows. There is no emulated RETURNING clause.

## Raw tagged queries

```ts
const rows = await db.queryRaw<Array<{ id: string; name: string }>>`
  SELECT ID AS "id", NAME AS "name"
  FROM APP_DB.PUBLIC.CUSTOMERS
  WHERE NAME = ${name}
`;

const result = await db.queryRaw`SELECT CURRENT_VERSION()`;
// result: unknown
```

The generic describes the **entire returned result**, like Prisma's queryRaw. It is a caller-supplied assertion; arbitrary SQL is not parsed into a runtime result schema. Raw numeric values use exact SDK string fetching. Raw field names follow SQL aliases/SDK object-row behavior. Alias duplicate names explicitly to avoid object-key collisions. Use explicit casts/formatting when raw temporal or semi-structured representations matter.

Build reusable query abstractions with the standalone `sql` tag:

```ts
const byName = (name: string) => sql<Array<{ ID: string }>>`
  SELECT ID FROM ${sql.identifier('APP_DB', 'PUBLIC', 'CUSTOMERS')}
  WHERE NAME = ${name}
`;
const rows = await db.queryRaw(byName('Ada'));
// Also supported: db.queryRaw<Result>(sql`...`).
```

Interpolated scalars become bindings. Nested fragments compose with bindings in order. Use `sql.identifier(...)` for identifiers, `sql.join(...)` for lists or predicates, and `sql.json(value)` for a bound PARSE_JSON value. `sql.unsafe(text)` is an explicit escape hatch for trusted SQL text. Plain objects, arrays, undefined, non-finite numbers, and unsafe integer numbers are rejected as ordinary interpolations; use explicit helpers, bigint, or decimal text.

## Execution controls

```ts
await db.execute(query, { signal: controller.signal, timeoutMs: 5_000 });
await db.queryRaw<Row[]>(sql`SELECT ...`, { signal: controller.signal, timeoutMs: 5_000 });
for await (const row of db.stream(query)) {
  /* typed and validated per row */
}
for await (const row of db.streamRaw<Row>(sql`SELECT ...`)) {
  /* asserted row type */
}

await db.transaction(async (tx) => {
  await tx.execute(insert(table, values));
  await tx.execute(update(table, changes).where(condition));
});

const pool = await createPool(connectionOptions, { min: 0, max: 5 });
try {
  await pool.execute(query);
} finally {
  await pool.close();
}
```

Import `createClient` and `createPool` from `snowtyped/snowflake`. The pool delegates to the official SDK and pins a connection through an entire transaction or streamed iteration. Set `testOnBorrow: true` to heartbeat each connection before lending it, so a terminated session is replaced before a request runs on it. `createClient` leaves connect/destroy to the caller. No implicit query retries are performed.

A pooled request's `signal` and `timeoutMs` also cover the wait for a connection, so a request that stops waiting never runs; `acquireTimeoutMillis` bounds that wait for every request. A connection whose session has terminated is destroyed instead of returned to the pool, though the request that found it still rejects. `close()` rejects new work, waits for running and queued operations, including unfinished streams, and then closes every connection. See [production behavior](docs/production.md) for operational limits, cleanup, and benchmark baselines.

Raw options require a `sql` query value; direct tagged templates take no options. Abort/deadline cancellation waits for Snowflake to accept the cancel before releasing a request. A cancel that arrives before Snowflake registers the statement is retried; if the statement finishes first, the request settles with its real outcome, so a committed write resolves rather than rejecting. Stopping consumption after a query has completed destroys the row stream; it does not attempt to cancel an already-completed server statement.

Await running operations and close cursors before starting a transaction on a single client. Use the callback's client, await its queries, and consume/close streams within that callback. An expired client cannot join a later transaction. Nested transactions are unsupported. Transactions provide rollback for DML; Snowflake DDL can auto-commit and must not be used as rollback-protected work. Other callers using the original SDK connection directly are outside this client's coordination. If ROLLBACK itself fails, the transaction rejects with an `AggregateError` holding both failures and the connection's session state is unknown: a pool destroys that connection, and a single client rejects every later operation on it, so the caller should destroy and replace the SDK connection.

## Introspection

`await introspect(db, { database: 'APP_DB', schema: 'PUBLIC' })` reads visible columns through INFORMATION_SCHEMA. `generateSchema(tables)` returns TypeScript source using exact names and stable `table0`, `table1`, ... exports. Generated declarations carry NUMBER precision/scale, VARCHAR length, and TIME/TIMESTAMP precision when they differ from Snowflake's defaults; INFORMATION_SCHEMA does not report BINARY length. Column defaults, identity settings, and virtual column expressions become `.serverDefault()`, `.identity()`, and `.virtual()` modifiers. Review and save generated declarations in your project. Unsupported data types fail explicitly; the tool does not silently invent codecs or schemas for them. Access is limited by the connection's role.

## Schema management

DDL builders, schema diffs, and migrations live in the separate `snowtyped/ddl` entry point, so query-only code never loads them.

```ts
import { createTable, defineSchema, defineTable, migrate, sqlType } from 'snowtyped/ddl';

const accountsTable = defineTable(accounts, {
  types: { balance: sqlType.number(18, 2) },
  comments: { email: 'Primary contact' },
});
const result = await migrate(
  db,
  [{ id: '0001_accounts', statements: [createTable(accountsTable)] }],
  {
    database: 'APP_DB',
    schema: 'PUBLIC',
    verify: defineSchema({ database: 'APP_DB', schema: 'PUBLIC' }, [accountsTable]),
  },
);
// result.applied: ['0001_accounts']; result.drift lists remaining differences
```

`defineTable` derives physical columns from a declared table: length, precision, and scale options, VECTOR element types and dimensions, and server values carry into the DDL. It rejects physical types its codecs cannot read or that conflict with declared options; `decimal()` without a precision needs an explicit `sqlType.number(precision, scale)`. Default and virtual columns need their expression, identity columns must be NUMBER or FLOAT, and virtual columns cannot be NOT NULL. `createSchema`, `dropSchema`, `createTable`, `dropTable`, and `alterTable(table)` (rename, comments, add/drop/rename columns, type changes, NOT NULL) build quoted statements. Comments compile to escaped literals.

`migrate` applies migrations in array order and records each statement in a `SNOWTYPED_MIGRATIONS` history table. A lease lock in `SNOWTYPED_MIGRATIONS_LOCK` makes concurrent runs fail with `LOCKED`; the lease is renewed before every statement and must exceed the longest one (`leaseSeconds`, default 900). Applied migrations must not change or be reordered (`HISTORY_DRIFT`). Destructive DDL needs `destructive: true` on its migration; raw SQL statements are not classified.

Snowflake commits each DDL statement on its own, so a failed migration keeps its earlier statements. The run stops with `FAILED`, and later runs refuse to continue until you fix the remaining statements and pass `resumeFailed: true`, which skips the committed ones. If a connection drops after Snowflake committed a statement but before it was recorded, that statement runs again on resume; prefer `IF NOT EXISTS` forms for such steps.

`inspectSchema` reads base tables through INFORMATION_SCHEMA, and `diffSchema`/`checkDrift` compare them with `defineSchema(...)`. Diffs widen VARCHAR, change NUMBER precision, toggle NOT NULL, add nullable columns, drop columns and tables, and set comments. Narrowing NUMBER precision and setting NOT NULL fail if existing data does not fit. Adding a NOT NULL column to an existing table and other type changes (scale, timestamp precision, type family, unmodeled types) are reported as `unsupported` rather than rebuilt. Renames are never inferred. Column order, defaults, identity, clustering, and BINARY length (not reported by INFORMATION_SCHEMA) are not compared. `pushSchema` applies a diff directly without history or locking, refusing destructive changes unless `allowDestructive` is set; rerunning it continues a partial push.

## Scope and distribution

The first-class API covers the operations above; the AST layer (`compileAst`, `identifier`, `quoteIdentifier`, and `*Node` types) is experimental. MATCH_RECOGNIZE, complex nested relation projections, DDL for objects other than schemas and tables, and ORM relation loading are not first-class APIs in this alpha. Raw SQL can execute Snowflake syntax beyond the modeled builder surface. A public third-party AST registration protocol is not implemented.

ESM/CJS conditional exports have matching `.d.mts`/`.d.cts` files. Sources and source maps are shipped for debugging; tests, credentials, and development scripts are excluded. `sideEffects: false` enables tree shaking. Zod is a runtime dependency; `snowflake-sdk` is an optional peer loaded only when creating an SDK pool, or by your application's connection setup. Pure compiler imports do not load the driver or retain unused validation code.

See [CONTRIBUTING.md](CONTRIBUTING.md), [CHANGELOG.md](CHANGELOG.md), and [PLANNING.md](PLANNING.md). Use GitHub issues for bugs and questions, and report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).
