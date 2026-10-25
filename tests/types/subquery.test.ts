// Checked by tsc, not executed.
import { expectTypeOf } from 'vitest';
import {
  alias,
  count,
  eq,
  exists,
  inSubquery,
  integer,
  notExists,
  type Snowtyped,
  scalar,
  select,
  snowflakeTable,
  sum,
  text,
} from '../../src/index.js';

const users = snowflakeTable('USERS', {
  id: integer('ID').notNull(),
  name: text('NAME').notNull(),
});
const orders = snowflakeTable('ORDERS', {
  id: integer('ID').notNull(),
  userId: integer('USER_ID').notNull(),
  total: integer('TOTAL'),
});
const other = snowflakeTable('OTHER', { id: integer('ID').notNull() });
declare const db: Snowtyped.SnowflakeClient;

const correlated = select(orders, { id: orders.columns.id })
  .correlate(users)
  .where(eq(orders.columns.userId, users.columns.id));
const query = select(users, {
  name: users.columns.name,
  hasOrders: exists(correlated),
  noOrders: notExists(correlated),
  orderCount: scalar(
    select(orders, { n: count() })
      .correlate(users)
      .where(eq(orders.columns.userId, users.columns.id)),
  ),
  spent: scalar(select(orders, { total: sum(orders.columns.total) })),
  firstName: scalar(select(users, { name: users.columns.name }).limit(1)),
}).where(inSubquery(users.columns.id, select(orders, { userId: orders.columns.userId })));
expectTypeOf(db.execute(query)).resolves.toHaveProperty('rows').toEqualTypeOf<
  readonly {
    readonly name: string;
    readonly hasOrders: boolean;
    readonly noOrders: boolean;
    readonly orderCount: bigint | null;
    readonly spent: string | null;
    readonly firstName: string | null;
  }[]
>();

const u = alias(users, 'u');
const middle = select(orders, { id: orders.columns.id })
  .correlate(u)
  .where(eq(orders.columns.userId, u.columns.id))
  .where(
    exists(
      select(other, { id: other.columns.id })
        .correlate(orders)
        .where(eq(other.columns.id, orders.columns.id)),
    ),
  );
select(u).where(exists(middle));
const both = select(other, { id: other.columns.id })
  .correlate(users, orders)
  .where(eq(other.columns.id, users.columns.id))
  .where(eq(other.columns.id, orders.columns.userId));
select(users).innerJoin(orders, eq(users.columns.id, orders.columns.userId)).where(exists(both));
// @ts-expect-error Both correlated sources must be in the enclosing scope.
select(users).where(exists(both));

// @ts-expect-error A correlated query cannot execute on its own.
db.execute(correlated);
// @ts-expect-error A correlated query cannot compile on its own.
correlated.compile();
// @ts-expect-error A correlated query cannot become a derived source.
correlated.as('x');
// @ts-expect-error The subquery correlates with USERS, which this query lacks.
select(other).where(exists(correlated));
// @ts-expect-error A query can only reference sources it reads or correlates.
select(orders).correlate(users).where(eq(other.columns.id, 1n));
// @ts-expect-error A correlated reference to the original identity is not its alias.
select(u).where(exists(correlated));
// @ts-expect-error Scalar subqueries project exactly one column.
scalar(select(orders, { id: orders.columns.id, userId: orders.columns.userId }));
// @ts-expect-error IN subqueries project exactly one column.
inSubquery(users.columns.id, select(orders));
// @ts-expect-error IN subqueries compare compatible domains.
inSubquery(users.columns.name, select(orders, { id: orders.columns.id }));
