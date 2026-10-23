import { customers, orders } from './fixtures.js';
// ---cut---

import { eq, select, sum } from 'snowtyped';

const spend = select(orders, {
  customerId: orders.columns.customerId,
  total: sum(orders.columns.amount),
})
  .groupBy(orders.columns.customerId)
  .asCte('SPEND');

const query = select(customers)
  .innerJoin(spend, eq(customers.columns.id, spend.columns.customerId))
  .select({ name: customers.columns.name, total: spend.columns.total });
