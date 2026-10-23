import { orders } from './fixtures.js';
// ---cut---

import { count, desc, gt, select, sum } from 'snowtyped';

const totals = select(orders, {
  customerId: orders.columns.customerId,
  orders: count(),
  total: sum(orders.columns.amount),
})
  .groupBy(orders.columns.customerId)
  .having(gt(count(), 1n))
  .orderBy(desc(orders.columns.customerId))
  .limit(10);
// orders: bigint; total: string | null
