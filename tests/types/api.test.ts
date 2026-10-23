// Checked by tsc, not executed. Keep this as .ts so skipLibCheck cannot hide failures.
import { expectTypeOf } from 'vitest';
import type { InferSelection } from '../../src/index.js';
import { eq, integer, select, snowflakeTable, sql, text } from '../../src/index.js';
import type { PoolOptions, SnowflakeClient } from '../../src/snowflake/index.js';

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
// @ts-expect-error Arbitrary objects are not implicitly encoded as SQL parameters.
sql`SELECT ${{ unsafe: true }}`;

expectTypeOf<{ max: 1; testOnBorrow: true }>().toExtend<PoolOptions>();
expectTypeOf<{ testOnBorrow: 'yes' }>().not.toExtend<PoolOptions>();
