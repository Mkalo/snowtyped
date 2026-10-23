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

| Declaration                             | Non-null output | Notes                                       |
| --------------------------------------- | --------------- | ------------------------------------------- |
| `text('NAME')`                          | `string`        | Text                                        |
| `integer('ID')`                         | `bigint`        | Exact integral NUMBER                       |
| `decimal('BALANCE')`                    | `string`        | Exact fixed-point decimal text              |
| `float('VALUE')`                        | `number`        | Finite floating-point values                |
| `boolean('ACTIVE')`                     | `boolean`       | No truthiness coercion                      |
| `date('DAY')`                           | `string`        | Calendar date                               |
| `time('CLOCK')`                         | `string`        | Time with up to nine fractional digits      |
| `timestamp('AT', 'ntz' / 'ltz' / 'tz')` | `string`        | Nanoseconds retained; LTZ/TZ include offset |
| `binary('DATA')`                        | `Uint8Array`    | SDK Buffers are accepted                    |
| `variant('PAYLOAD')`                    | `unknown`       | JSON without an assumed shape               |

Declare a structured JSON shape at the column, for example `variant('PAYLOAD', z.object({ items: z.array(z.number()) }))`. A type parameter alone cannot establish a VARIANT shape. The declaration is checked at runtime, and read/write types are inferred from it. Numeric precision/scale and other database constraints remain database-enforced; declarations should match the physical schema.

## Query composition

`select(table)` selects all declared columns. `select(table, projection)` or `.select(projection)` selects specific columns and expressions. Builders are immutable; a later call to a clause such as `.where()` replaces that clause on the new query.

Supported helpers include `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `and`, `or`, `not`, `isNull`, `isNotNull`, `inArray`, `like`, `ilike`, `lower`, `upper`, `count`, `sum`, `min`, and `max`. `asc`/`desc` accept optional `FIRST`/`LAST` null ordering. Empty membership lists compile to a constant false (or true for negated membership).

```ts
const query = select(customers)
  .leftJoin(orders, eq(customers.columns.id, orders.columns.customerId))
  .select({ name: customers.columns.name, orderId: orders.columns.id });
// orderId is nullable even if ORDERS.ID is declared .notNull().
```

Project joined columns after joining so they are in scope. Inner, left, right, full, and cross joins are supported. Use `alias(table, 'c')` for repeated table names. Table/alias scopes are checked statically and at runtime; dynamic identities that share a static name are distinguished at runtime.

Use `.groupBy(...)`, `.having(predicate)`, `.orderBy(...)`, `.distinct()`, `.limit(n)`, and `.offset(n)`. Counts decode as `bigint`; sums decode as exact decimal strings, with nullability for empty groups. Grouping legality beyond supported expression/scope checks is enforced by Snowflake. DISTINCT order expressions must be projected.

`.as('name')` turns a query into a derived table; `.asCte('name')` makes a CTE source. Its `.columns` retain inferred output types and outer-join nullability. Selecting or joining a CTE includes its definition automatically.

## Snowflake syntax

```ts
const rank = rowNumber({
  partitionBy: [orders.columns.customerId],
  orderBy: [desc(orders.columns.amount)],
});
const latest = select(orders, { id: orders.columns.id, rank }).qualify(eq(rank, 1n));

const items = flatten(jsonPath(events.columns.payload, 'items'), 'items');
const expanded = select(events)
  .lateralJoin(items)
  .select({ eventId: events.columns.id, value: items.columns.value });

const prices = select(trades)
  .asofJoin(quotes, gte(trades.columns.at, quotes.columns.at))
  .select({ at: trades.columns.at, price: quotes.columns.price });
```

`over(aggregate, options)` supports aggregate windows. QUALIFY requires a window in the projection or predicate. FLATTEN exposes its fixed output columns and supports `path`, `outer`, `recursive`, and `mode`. Its input can refer only to preceding sources. ASOF's right side is nullable and supports an optional key-match predicate.

### MATCH_RECOGNIZE

```ts
const { variable, sequence, oneOrMore } = rowPattern;
const vShapes = matchRecognize(stocks, 'V', {
  partitionBy: ['company'],
  orderBy: (row) => [asc(row.day)],
  pattern: sequence(variable('start'), oneOrMore(variable('down')), oneOrMore(variable('up'))),
  define: ({ row, lag }) => ({
    down: lt(row.price, lag(row.price)),
    up: gt(row.price, lag(row.price)),
  }),
  measures: ({ row, vars, first, last, matchNumber, classifier }) => ({
    match: matchNumber(),
    startDay: first(row.day),
    bottomDay: last(vars.down.day),
    kind: classifier(),
  }),
});
const rows = await db.execute(select(vShapes).where(eq(vShapes.columns.kind, 'up')));
```

`matchRecognize` returns a table source that can be selected, joined, or derived further. Pattern variables come from the pattern, so `define`, `vars`, `count(variable)`, `classifier()`, and `afterMatch` only accept those names. `define` sees the classified row with `lag`, `lead`, `next`, and `last`; `measures` also get variable-qualified columns, `prev`, `first`, `final`, `running`, `matchNumber`, and `matchSequenceNumber`. Inside the clause, columns are named by their source keys. `rowsPerMatch` is `'one'` (partition keys plus measures), `'all'`, `'all-omit-empty'`, or `'all-with-unmatched'` (all source keys plus measures). Measures become nullable when unmatched rows or empty matches can appear. In ALL ROWS PER MATCH, wrap `first`/`last` of variable columns in `final`.

`timeTravel(table, { offset: -60 })`, `{ timestamp: '...' }`, or `{ statement: '...' }` adds a bound AT selector. Pass `'BEFORE'` as the third argument for BEFORE semantics. Database retention and supported selector rules still apply.

## Writes

```ts
await db.execute(insert(customers, { id: 1n, name: 'Ada', email: null }));
await db.execute(update(customers, { name: 'Grace' }).where(eq(customers.columns.id, 1n)));
await db.execute(deleteFrom(customers).where(eq(customers.columns.id, 1n)));

await db.execute(
  mergeInto(target, staged, eq(target.columns.id, staged.columns.id))
    .whenMatchedUpdate({ name: staged.columns.name })
    .whenNotMatchedInsert({ id: staged.columns.id, name: staged.columns.name }),
);
```

INSERT accepts one row or an array of rows. Required columns must be present; omitted nullable columns become SQL NULL. UPDATE accepts typed literal values and expressions from its table. MERGE supports matched update/delete and unmatched insert. Statements return `{ affectedRows, queryId }`. UPDATE and DELETE without `.where()` affect all rows. There is no emulated RETURNING clause.

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

Import `createClient` and `createPool` from `snowtyped/snowflake`. The pool delegates to the official SDK and pins a connection through an entire transaction or streamed iteration. `createClient` leaves connect/destroy to the caller. No implicit query retries are performed.

Abort/deadline cancellation waits for the SDK's cancellation callback before releasing a request. Stopping consumption after a query has completed destroys the row stream; it does not attempt to cancel an already-completed server statement.

Await running operations and close cursors before starting a transaction on a single client. Use the callback's client, await its queries, and consume/close streams within that callback. An expired client cannot join a later transaction. Nested transactions are unsupported. Transactions provide rollback for DML; Snowflake DDL can auto-commit and must not be used as rollback-protected work. Other callers using the original SDK connection directly are outside this client's coordination.

## Introspection

`await introspect(db, { database: 'APP_DB', schema: 'PUBLIC' })` reads visible columns through INFORMATION_SCHEMA. `generateSchema(tables)` returns TypeScript source using exact names and stable `table0`, `table1`, ... exports. Review and save generated declarations in your project. Unsupported data types fail explicitly; the tool does not silently invent codecs or schemas for them. Access is limited by the connection's role.

## Scope and distribution

The first-class API covers the operations above; the AST layer (`compileAst`, `identifier`, `quoteIdentifier`, and `*Node` types) is experimental. PIVOT/UNPIVOT, recursive CTEs, set operations, complex nested relation projections, advanced frames, default/generated columns, migrations, DDL builders, and ORM relation loading are not first-class APIs in this alpha. Raw SQL can execute Snowflake syntax beyond the modeled builder surface. A public third-party AST registration protocol is not implemented.

ESM/CJS conditional exports have matching `.d.mts`/`.d.cts` files. Sources and source maps are shipped for debugging; tests, credentials, and development scripts are excluded. `sideEffects: false` enables tree shaking. Zod is a runtime dependency; `snowflake-sdk` is an optional peer loaded only when creating an SDK pool, or by your application's connection setup. Pure compiler imports do not load the driver or retain unused validation code.

See [CONTRIBUTING.md](CONTRIBUTING.md), [CHANGELOG.md](CHANGELOG.md), and [PLANNING.md](PLANNING.md). Use GitHub issues for bugs and questions, and report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).
