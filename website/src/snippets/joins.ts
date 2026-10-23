import { customers, orders } from './fixtures.js';
// ---cut---

import { eq, select } from 'snowtyped';

const query = select(customers)
  .leftJoin(orders, eq(customers.columns.id, orders.columns.customerId))
  .select({ name: customers.columns.name, orderId: orders.columns.id });
// orderId is nullable even if ORDERS.ID is declared .notNull().
