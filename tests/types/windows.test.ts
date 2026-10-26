// Checked by tsc, not executed. Keep this as .ts so skipLibCheck cannot hide failures.
import { expectTypeOf } from 'vitest';
import {
  asc,
  count,
  date,
  decimal,
  desc,
  integer,
  over,
  rangeBetween,
  rowNumber,
  rowsBetween,
  type Snowtyped,
  select,
  snowflakeTable,
  sum,
  text,
} from '../../src/index.js';

const orders = snowflakeTable('ORDERS', {
  id: integer('ID').notNull(),
  customer: text('CUSTOMER').notNull(),
  amount: decimal('AMOUNT').notNull(),
  day: date('DAY').notNull(),
});
const other = snowflakeTable('OTHER', { id: integer('ID').notNull() });
declare const db: Snowtyped.SnowflakeClient;

const running = over(sum(orders.columns.amount), {
  partitionBy: [orders.columns.customer],
  orderBy: [asc(orders.columns.id)],
  frame: rowsBetween('UNBOUNDED PRECEDING', 'CURRENT ROW'),
});
const previous = over(count(orders.columns.id), {
  orderBy: [asc(orders.columns.id), desc(orders.columns.day)],
  frame: rowsBetween({ preceding: 2 }, { preceding: 1 }),
});
const recent = over(sum(orders.columns.amount), {
  orderBy: [asc(orders.columns.day)],
  frame: rangeBetween({ preceding: 7, unit: 'DAY' }, 'CURRENT ROW'),
});
const cumulative = over(sum(orders.columns.amount), {
  orderBy: [asc(orders.columns.customer), asc(orders.columns.id)],
  frame: rangeBetween('UNBOUNDED PRECEDING', 'UNBOUNDED FOLLOWING'),
});
expectTypeOf(db.execute(select(orders, { running, previous, recent, cumulative })))
  .resolves.toHaveProperty('rows')
  .toEqualTypeOf<
    readonly {
      readonly running: string | null;
      readonly previous: bigint;
      readonly recent: string | null;
      readonly cumulative: string | null;
    }[]
  >();
rowsBetween({ following: 1 }, 'UNBOUNDED FOLLOWING');
rowsBetween('CURRENT ROW', { following: 3 });
rangeBetween({ preceding: 1.5 }, { following: 1.5 });

// @ts-expect-error Explicit frames require ORDER BY.
over(sum(orders.columns.amount), { frame: rowsBetween('UNBOUNDED PRECEDING', 'CURRENT ROW') });
over(sum(orders.columns.amount), {
  // @ts-expect-error Explicit frames require a non-empty ORDER BY.
  orderBy: [],
  frame: rowsBetween('UNBOUNDED PRECEDING', 'CURRENT ROW'),
});
over(sum(orders.columns.amount), {
  // @ts-expect-error RANGE offsets allow only one ORDER BY expression.
  orderBy: [asc(orders.columns.day), asc(orders.columns.id)],
  frame: rangeBetween({ preceding: 1 }, 'CURRENT ROW'),
});
// @ts-expect-error Ranking functions do not accept frames.
rowNumber({ orderBy: [asc(orders.columns.id)], frame: rowsBetween('CURRENT ROW', 'CURRENT ROW') });
// @ts-expect-error A frame cannot start at UNBOUNDED FOLLOWING.
rowsBetween('UNBOUNDED FOLLOWING', 'UNBOUNDED FOLLOWING');
// @ts-expect-error A frame cannot end at UNBOUNDED PRECEDING.
rowsBetween('UNBOUNDED PRECEDING', 'UNBOUNDED PRECEDING');
// @ts-expect-error A frame starting at CURRENT ROW cannot end before it.
rowsBetween('CURRENT ROW', { preceding: 1 });
// @ts-expect-error A frame starting after the current row cannot end at it.
rangeBetween({ following: 1 }, 'CURRENT ROW');
// @ts-expect-error ROWS offsets cannot use interval units.
rowsBetween({ preceding: 1, unit: 'DAY' }, 'CURRENT ROW');
// @ts-expect-error Interval units are fixed.
rangeBetween({ preceding: 1, unit: 'FORTNIGHT' }, 'CURRENT ROW');
// @ts-expect-error Snowflake rejects sub-millisecond interval frames.
rangeBetween({ preceding: 1, unit: 'MICROSECOND' }, 'CURRENT ROW');
// @ts-expect-error Snowflake rejects sub-millisecond interval frames.
rangeBetween({ preceding: 1, unit: 'NANOSECOND' }, 'CURRENT ROW');
const joined = over(sum(orders.columns.amount), {
  partitionBy: [other.columns.id],
  orderBy: [asc(orders.columns.id)],
  frame: rowsBetween('UNBOUNDED PRECEDING', 'CURRENT ROW'),
});
// @ts-expect-error Frame window scope includes partition and order sources.
select(orders, { joined });
// @ts-expect-error A framed window over another table cannot be projected.
select(other, { running });
