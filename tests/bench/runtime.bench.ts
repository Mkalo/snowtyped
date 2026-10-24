import type { Column, RowStatement, StatementOption } from 'snowflake-sdk';
import { afterAll, describe, it } from 'vitest';
import {
  and,
  asc,
  boolean,
  count,
  date,
  decimal,
  eq,
  float,
  gt,
  insert,
  integer,
  isNotNull,
  select,
  snowflakeTable,
  sql,
  sum,
  text,
  timestamp,
} from '../../src/index.js';
import { createClient } from '../../src/snowflake/index.js';
import { fixed, sample, table } from '../support/measure.js';

const orders = snowflakeTable(
  'ORDERS',
  {
    id: integer('ID').notNull(),
    customerId: integer('CUSTOMER_ID').notNull(),
    status: text('STATUS').notNull(),
    total: decimal('TOTAL').notNull(),
    weight: float('WEIGHT'),
    paid: boolean('PAID').notNull(),
    placed: date('PLACED').notNull(),
    updated: timestamp('UPDATED', 'ntz'),
  },
  { database: 'APP', schema: 'PUBLIC' },
);
const customers = snowflakeTable(
  'CUSTOMERS',
  { id: integer('ID').notNull(), name: text('NAME').notNull(), email: text('EMAIL') },
  { database: 'APP', schema: 'PUBLIC' },
);
const wide = snowflakeTable(
  'WIDE',
  Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`c${i}`, text(`C${i}`)])),
);

const report: Record<string, string | number>[] = [];
afterAll(() => {
  process.stdout.write(`\n${table(report)}\n`);
});
async function record(name: string, fn: () => unknown, perCall = 1, batch = 1) {
  const result = await sample(fn, { batch });
  report.push({
    case: name,
    'µs p50': fixed(result.p50 * 1000),
    'µs p99': fixed(result.p99 * 1000),
    'µs/row': perCall > 1 ? fixed((result.p50 * 1000) / perCall) : '',
  });
}

/** A connection that completes synchronously with canned rows, so only client work is timed. */
function connection(names: readonly string[], rows: unknown[]) {
  const columns = names.map(
    (name) =>
      ({
        getName: () => name,
        isString: () => name === 'STATUS' || name.startsWith('C'),
        isBinary: () => false,
      }) as unknown as Column,
  );
  const statement = {
    getQueryId: () => 'q',
    getColumns: () => columns,
    getNumUpdatedRows: () => 0,
  } as unknown as RowStatement;
  return {
    execute(options: StatementOption) {
      options.complete?.(undefined, statement, rows);
      return statement;
    },
  };
}

describe('client-side cost', () => {
  it('builds and compiles statements', async () => {
    const prebuilt = select(orders).where(eq(orders.columns.id, 1n));
    await record('raw sql template', () => sql`SELECT * FROM T WHERE ID = ${1}`.compile(), 1, 100);
    await record('compile a prebuilt select', () => prebuilt.compile(), 1, 100);
    await record(
      'build + compile select where',
      () => select(orders).where(eq(orders.columns.id, 1n)).compile(),
      1,
      100,
    );
    await record(
      'build + compile join, where, order, limit',
      () =>
        select(orders)
          .leftJoin(customers, eq(orders.columns.customerId, customers.columns.id))
          .select({
            id: orders.columns.id,
            total: orders.columns.total,
            name: customers.columns.name,
          })
          .where(and(gt(orders.columns.id, 10n), isNotNull(orders.columns.status)))
          .orderBy(asc(orders.columns.id))
          .limit(100)
          .compile(),
      1,
      100,
    );
    await record(
      'build + compile grouped aggregate',
      () =>
        select(orders, {
          status: orders.columns.status,
          n: count(),
          total: sum(orders.columns.total),
        })
          .groupBy(orders.columns.status)
          .compile(),
      1,
      100,
    );
    for (const size of [100, 1000]) {
      const rows = Array.from({ length: size }, (_, i) => ({
        id: BigInt(i),
        customerId: 1n,
        status: 'new',
        total: '1.00',
        paid: true,
        placed: '2024-01-01',
      }));
      await record(
        `build + compile insert of ${size} rows`,
        () => insert(orders, rows).compile(),
        size,
      );
    }
  });

  it('maps result rows', async () => {
    const names = ['ID', 'CUSTOMER_ID', 'STATUS', 'TOTAL', 'WEIGHT', 'PAID', 'PLACED', 'UPDATED'];
    const wire = (i: number) => [
      String(i),
      '42',
      'shipped',
      '123.4500',
      '1.5',
      true,
      '2024-01-01',
      '2024-01-01 10:00:00.000000000',
    ];
    const objects = (arrays: unknown[][], keys: readonly string[]) =>
      arrays.map((row) => Object.fromEntries(keys.map((key, i) => [key, row[i]])));
    for (const size of [1, 10_000]) {
      const arrays = Array.from({ length: size }, (_, i) => wire(i));
      const typed = createClient(connection(names, arrays));
      const raw = createClient(connection(names, objects(arrays, names)));
      const query = select(orders);
      await record(`execute(select), ${size} × 8 columns`, () => typed.execute(query), size);
      await record(`queryRaw, ${size} × 8 columns`, () => raw.queryRaw(sql`SELECT 1`), size);
    }
    const wideNames = Array.from({ length: 100 }, (_, i) => `C${i}`);
    const wideRows = Array.from({ length: 1000 }, (_, r) => wideNames.map(() => String(r)));
    const typedWide = createClient(connection(wideNames, wideRows));
    const rawWide = createClient(connection(wideNames, objects(wideRows, wideNames)));
    const wideQuery = select(wide);
    await record('execute(select), 1000 × 100 columns', () => typedWide.execute(wideQuery), 1000);
    await record('queryRaw, 1000 × 100 columns', () => rawWide.queryRaw(sql`SELECT 1`), 1000);
  });
});
