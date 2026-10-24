import { customers, db, orders } from './fixtures.js';
// ---cut---

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
// rows: readonly { readonly id: bigint; readonly name: string; readonly email: string | null;
//   orders: { readonly id: bigint; readonly amount: string }[] }[]
// queryIds: one for the 20 customers, one for all of their orders
