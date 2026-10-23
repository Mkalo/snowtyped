// Checked by tsc, not executed. Keep this as .ts so skipLibCheck cannot hide failures.
import { expectTypeOf } from 'vitest';
import type { InferSelection } from '../../src/index.js';
import { eq, integer, select, snowflakeTable, sql, text } from '../../src/index.js';
import type { PooledClient, SnowflakeClient } from '../../src/snowflake/index.js';

const customers = snowflakeTable('CUSTOMERS', {
  id: integer('ID').notNull(),
  email: text('EMAIL'),
});
const query = select(customers, {
  customerId: customers.columns.id,
  email: customers.columns.email,
});
expectTypeOf<InferSelection<typeof query.selection>>().toEqualTypeOf<{
  readonly customerId: bigint;
  readonly email: string | null;
}>();

declare const client: SnowflakeClient;
declare const pool: PooledClient;
const result = client.execute(query);
expectTypeOf(result).resolves.toHaveProperty('rows').toEqualTypeOf<
  readonly {
    readonly customerId: bigint;
    readonly email: string | null;
  }[]
>();

eq(customers.columns.id, 1n);
eq(customers.columns.email, null);
// @ts-expect-error Integer parameters must be bigint, not strings.
eq(customers.columns.id, '1');
// @ts-expect-error A required column does not accept null.
eq(customers.columns.id, null);
// @ts-expect-error Unknown columns must fail compilation.
select(customers, { missing: customers.columns.missing });
// @ts-expect-error The client accepts no caller-supplied decoder.
client.execute(query, { parse: (value: unknown) => value });

expectTypeOf(client.queryRaw`SELECT 1`).toEqualTypeOf<Promise<unknown>>();
expectTypeOf(client.queryRaw<{ ID: string }[]>`SELECT 1 AS ID`).toEqualTypeOf<
  Promise<{ ID: string }[]>
>();
expectTypeOf(client.queryRaw(sql<{ ID: string }[]>`SELECT 1 AS ID`)).toEqualTypeOf<
  Promise<{ ID: string }[]>
>();
declare const signal: AbortSignal;
expectTypeOf(client.queryRaw(sql`SELECT 1`, { signal, timeoutMs: 1_000 })).toEqualTypeOf<
  Promise<unknown>
>();
expectTypeOf(client.queryRaw(sql<{ ID: string }[]>`SELECT 1 AS ID`, { signal })).toEqualTypeOf<
  Promise<{ ID: string }[]>
>();
expectTypeOf(
  client.queryRaw<{ ID: string }[]>(sql`SELECT 1 AS ID`, { timeoutMs: 1_000 }),
).toEqualTypeOf<Promise<{ ID: string }[]>>();
expectTypeOf(pool.queryRaw(sql<{ ID: string }[]>`SELECT 1 AS ID`, { signal })).toEqualTypeOf<
  Promise<{ ID: string }[]>
>();
expectTypeOf(pool.queryRaw`SELECT 1`).toEqualTypeOf<Promise<unknown>>();
// @ts-expect-error Raw query options accept only execution controls.
client.queryRaw(sql`SELECT 1`, { parse: (value: unknown) => value });
// @ts-expect-error A raw query takes one options object, not interpolated values.
client.queryRaw(sql`SELECT 1`, {}, 1);
declare const strings: TemplateStringsArray;
// @ts-expect-error Execution options are not SQL interpolations of a tagged template.
client.queryRaw(strings, { timeoutMs: 1_000 });
// @ts-expect-error Arbitrary objects are not implicitly encoded as SQL parameters.
sql`SELECT ${{ unsafe: true }}`;
