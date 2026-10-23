import { orders, trades } from './fixtures.js';
// ---cut---

import { asc, count, over, rangeBetween, rowsBetween, select, sum } from 'snowtyped';

const running = over(sum(orders.columns.amount), {
  partitionBy: [orders.columns.customerId],
  orderBy: [asc(orders.columns.id)],
  frame: rowsBetween('UNBOUNDED PRECEDING', 'CURRENT ROW'),
});
const lastDay = over(count(), {
  orderBy: [asc(trades.columns.at)],
  frame: rangeBetween({ preceding: 1, unit: 'DAY' }, 'CURRENT ROW'),
});
const totals = select(orders, { id: orders.columns.id, running });
const activity = select(trades, { id: trades.columns.id, lastDay });
