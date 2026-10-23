import { expectTypeOf } from 'vitest';
import {
  date,
  decimal,
  dynamicPivot,
  eq,
  integer,
  pivot,
  type RawQuery,
  select,
  snowflakeTable,
  text,
  unpivot,
  variant,
} from '../../src/index.js';
import type { SnowflakeClient } from '../../src/snowflake/index.js';

declare const db: SnowflakeClient;
const sales = snowflakeTable('SALES', {
  id: integer('ID').notNull(),
  region: text('REGION'),
  quarter: text('QUARTER').notNull(),
  amount: decimal('AMOUNT'),
  day: date('DAY').notNull(),
});
const totals = pivot(sales, 'P', {
  aggregate: 'sum',
  value: 'amount',
  for: 'quarter',
  in: { q1: 'Q1', q2: 'Q2' },
});
expectTypeOf(db.execute(select(totals)))
  .resolves.toHaveProperty('rows')
  .toEqualTypeOf<
    readonly {
      readonly id: bigint;
      readonly region: string | null;
      readonly day: string;
      readonly q1: string | null;
      readonly q2: string | null;
    }[]
  >();
const defaulted = pivot(sales, 'D', {
  aggregate: 'max',
  value: 'day',
  for: 'id',
  in: { first: 1n },
  default: '1970-01-01',
});
expectTypeOf(db.execute(select(defaulted, { first: defaulted.columns.first })))
  .resolves.toHaveProperty('rows')
  .toEqualTypeOf<readonly { readonly first: string }[]>();
const counts = pivot(sales, 'C', {
  aggregate: 'count',
  value: 'amount',
  for: 'region',
  in: { east: 'east' },
});
expectTypeOf(db.execute(select(counts, { east: counts.columns.east })))
  .resolves.toHaveProperty('rows')
  .toEqualTypeOf<readonly { readonly east: bigint }[]>();
select(sales).innerJoin(totals, eq(sales.columns.id, totals.columns.id));
const months = snowflakeTable('MONTHS', {
  id: integer('ID').notNull(),
  jan: integer('JAN').notNull(),
  feb: integer('FEB'),
});
const long = unpivot(months, 'U', { value: 'amount', for: 'month', in: ['jan', 'feb'] });
expectTypeOf(db.execute(select(long)))
  .resolves.toHaveProperty('rows')
  .toEqualTypeOf<
    readonly { readonly id: bigint; readonly amount: bigint; readonly month: 'jan' | 'feb' }[]
  >();
const withNulls = unpivot(months, 'N', {
  value: 'amount',
  for: 'month',
  in: ['jan', 'feb'],
  includeNulls: true,
});
expectTypeOf(db.execute(select(withNulls, { amount: withNulls.columns.amount })))
  .resolves.toHaveProperty('rows')
  .toEqualTypeOf<readonly { readonly amount: bigint | null }[]>();
const required = unpivot(months, 'R', {
  value: 'amount',
  for: 'month',
  in: ['jan'],
  includeNulls: true,
});
expectTypeOf(db.execute(select(required, { amount: required.columns.amount })))
  .resolves.toHaveProperty('rows')
  .toEqualTypeOf<readonly { readonly amount: bigint }[]>();
const dynamic = dynamicPivot(sales, 'Y', { aggregate: 'sum', value: 'amount', for: 'quarter' });
expectTypeOf(dynamic).toEqualTypeOf<RawQuery<unknown>>();
expectTypeOf(db.queryRaw(dynamic)).toEqualTypeOf<Promise<unknown>>();
// @ts-expect-error A pivot column cannot reuse a grouping column name.
pivot(sales, 'X', { aggregate: 'sum', value: 'amount', for: 'quarter', in: { id: 'Q1' } });
// @ts-expect-error Pivot values must match the `for` column domain.
pivot(sales, 'X', { aggregate: 'sum', value: 'amount', for: 'id', in: { one: 'Q1' } });
// @ts-expect-error The value and `for` columns must differ.
pivot(sales, 'X', { aggregate: 'sum', value: 'amount', for: 'amount', in: { one: '1' } });
pivot(sales, 'X', {
  aggregate: 'count',
  value: 'amount',
  for: 'quarter',
  in: { a: 'Q1' },
  // @ts-expect-error A default must match the aggregate result domain.
  default: '0',
});
// @ts-expect-error Unknown columns are rejected.
unpivot(months, 'X', { value: 'amount', for: 'month', in: ['mar'] });
// @ts-expect-error UNPIVOT needs at least one column.
unpivot(months, 'X', { value: 'amount', for: 'month', in: [] });
const events = snowflakeTable('EVENTS', { id: integer('ID').notNull(), data: variant('DATA') });
// @ts-expect-error Columns of the source scope do not belong to the pivoted scope.
select(totals).where(eq(events.columns.id, 1n));
