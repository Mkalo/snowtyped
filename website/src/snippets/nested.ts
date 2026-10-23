import { customers, orders } from './fixtures.js';
// ---cut---

import { eq, select } from 'snowtyped';

const query = select(orders)
  .leftJoin(customers, eq(orders.columns.customerId, customers.columns.id))
  .select({
    id: orders.columns.id,
    customer: { id: customers.columns.id, name: customers.columns.name },
  });
// { id: bigint; customer: { id: bigint; name: string } | null }[]
