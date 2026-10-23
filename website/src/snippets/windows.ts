import { orders } from './fixtures.js';
// ---cut---

import { desc, eq, rowNumber, select } from 'snowtyped';

const rank = rowNumber({
  partitionBy: [orders.columns.customerId],
  orderBy: [desc(orders.columns.amount)],
});
const latest = select(orders, { id: orders.columns.id, rank }).qualify(eq(rank, 1n));
