<p align="center">
  <img src="https://raw.githubusercontent.com/Mkalo/snowtyped/main/website/src/assets/logo.svg" width="160" height="160" alt="Snowtyped logo">
</p>

<h1 align="center">Snowtyped</h1>

<p align="center">
  Strongly typed Snowflake queries for TypeScript.<br>
  Declare your tables once and get inferred result types, validated rows, and real Snowflake SQL.
</p>

<p align="center">
  <a href="https://github.com/Mkalo/snowtyped/actions/workflows/ci.yml?query=branch%3Amain"><img src="https://img.shields.io/github/actions/workflow/status/Mkalo/snowtyped/ci.yml?branch=main&label=CI&logo=github" alt="CI status"></a>
  <a href="https://www.npmjs.com/package/snowtyped"><img src="https://img.shields.io/npm/v/snowtyped?logo=npm" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/snowtyped"><img src="https://img.shields.io/node/v/snowtyped" alt="Node.js version"></a>
  <a href="https://mkalo.github.io/snowtyped/"><img src="https://img.shields.io/badge/docs-mkalo.github.io-29b5e8" alt="Documentation"></a>
  <a href="https://github.com/Mkalo/snowtyped/blob/main/LICENSE"><img src="https://img.shields.io/github/license/Mkalo/snowtyped" alt="MIT license"></a>
</p>

<p align="center">
  <a href="https://mkalo.github.io/snowtyped/">Docs</a>
  &bull;
  <a href="https://mkalo.github.io/snowtyped/getting-started/">Getting started</a>
  &bull;
  <a href="https://mkalo.github.io/snowtyped/api/readme/">API reference</a>
  &bull;
  <a href="https://mkalo.github.io/snowtyped/project/changelog/">Changelog</a>
</p>

<br>

## Install

```sh
pnpm add snowtyped snowflake-sdk
```

Snowtyped needs Node.js 22.18+ or 24.11+. [`snowflake-sdk`](https://www.npmjs.com/package/snowflake-sdk) is an optional peer: you only need it to connect, not to compile queries.

## Declare a table

```ts
import { integer, snowflakeTable, text } from 'snowtyped';

export const customers = snowflakeTable(
  'CUSTOMERS',
  {
    id: integer('ID').notNull(),
    name: text('NAME').notNull(),
    email: text('EMAIL'),
  },
  { database: 'APP_DB', schema: 'PUBLIC' },
);
```

## Query it

```ts
import { eq, select } from 'snowtyped';
import { createClient } from 'snowtyped/snowflake';
import { customers } from './schema.js';

// connection is an already-connected snowflake-sdk Connection.
declare const connection: Connection;
const db = createClient(connection);

const { rows, queryId } = await db.execute(
  select(customers, {
    id: customers.columns.id,
    email: customers.columns.email,
  }).where(eq(customers.columns.name, 'Ada')),
);
// rows: readonly { readonly id: bigint; readonly email: string | null }[]
```

There are no result interfaces to write and no decoders to keep in sync. The declaration drives both the inferred type and the runtime validation, so a row that does not match is rejected instead of leaking into your app.

## Load nested relations

```ts
import { asc, many, select, withRelations } from 'snowtyped';

const customerOrders = many(
  orders,
  { from: customers.columns.id, to: orders.columns.customerId },
  (rows) =>
    rows
      .select({ id: orders.columns.id, amount: orders.columns.amount })
      .orderBy(asc(orders.columns.id)),
);
const page = withRelations(select(customers).orderBy(asc(customers.columns.id)).limit(20), {
  orders: customerOrders,
});
const { rows, queryIds } = await db.execute(page);
// rows: { id: bigint; name: string; email: string | null; orders: { id: bigint; amount: string }[] }[]
// queryIds: one for the 20 customers, one for all of their orders
```

## Write Snowflake, not lowest-common-denominator SQL

```ts
import { desc, eq, rowNumber, select } from 'snowtyped';

const rank = rowNumber({
  partitionBy: [orders.columns.customerId],
  orderBy: [desc(orders.columns.amount)],
});
const latest = select(orders, { id: orders.columns.id, rank }).qualify(eq(rank, 1n));
```

## What else it does

- **[Exact values](https://mkalo.github.io/snowtyped/guides/validation/):** integers decode as `bigint`, decimals as exact strings, and timestamps keep nanoseconds.
- **[Composable queries](https://mkalo.github.io/snowtyped/guides/queries/):** joins, CTEs, recursive CTEs, set operations, and correlated subqueries, all immutable and fully typed.
- **[Snowflake syntax](https://mkalo.github.io/snowtyped/guides/snowflake-syntax/):** windows and `QUALIFY`, `FLATTEN`, `ASOF JOIN`, `PIVOT`, `MATCH_RECOGNIZE`, and time travel.
- **[Mutations](https://mkalo.github.io/snowtyped/guides/mutations/):** `INSERT`, `UPDATE`, `DELETE`, and `MERGE` checked against the table declaration.
- **[Raw SQL](https://mkalo.github.io/snowtyped/guides/raw-sql/):** parameterized tagged templates for anything the builder does not model.
- **[Execution](https://mkalo.github.io/snowtyped/guides/execution/):** connection pools, transactions, streaming, and cancellation.
- **[Introspection](https://mkalo.github.io/snowtyped/guides/introspection/):** generate table declarations from an existing schema.
- **[Migrations](https://mkalo.github.io/snowtyped/guides/migrations/):** DDL builders, schema diffs, drift checks, and versioned migrations in `snowtyped/ddl`.
- **Small footprint:** ESM and CommonJS builds, tree shaking, and query compilation that never loads the driver.

Read the [documentation](https://mkalo.github.io/snowtyped/) for the full guides and API reference.

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](https://github.com/Mkalo/snowtyped/blob/main/CONTRIBUTING.md) for local setup and checks, and [SECURITY.md](https://github.com/Mkalo/snowtyped/blob/main/SECURITY.md) for reporting vulnerabilities.

## License

[MIT](https://github.com/Mkalo/snowtyped/blob/main/LICENSE)
