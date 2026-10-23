import { orders } from './fixtures.js';
// ---cut---

import { asc, denseRank, desc, lag, select } from 'snowtyped';

const place = denseRank({ orderBy: [desc(orders.columns.amount)] });
const previous = lag(orders.columns.amount, {
  partitionBy: [orders.columns.customerId],
  orderBy: [asc(orders.columns.id)],
  default: '0',
});
const query = select(orders, { id: orders.columns.id, place, previous });
