import { customers, orders } from './fixtures.js';
// ---cut---

import { count, eq, exists, inSubquery, notExists, scalar, select } from 'snowtyped';

const theirOrders = select(orders, { id: orders.columns.id })
  .correlate(customers)
  .where(eq(orders.columns.customerId, customers.columns.id));

const query = select(customers, {
  name: customers.columns.name,
  orderCount: scalar(theirOrders.select({ n: count() })),
}).where(exists(theirOrders));

const inactive = select(customers, { id: customers.columns.id }).where(notExists(theirOrders));

const buyers = select(customers, { name: customers.columns.name }).where(
  inSubquery(customers.columns.id, select(orders, { id: orders.columns.customerId })),
);
