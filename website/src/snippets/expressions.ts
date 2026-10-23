import { orders } from './fixtures.js';
// ---cut---

import { caseWhen, cast, coalesce, div, gt, mul, select } from 'snowtyped';

const { id, amount } = orders.columns;
const query = select(orders, {
  id,
  label: cast(id, 'text'),
  share: div(mul(amount, '100'), '7'),
  tier: caseWhen(gt(amount, '1000'), 'large').when(gt(amount, '100'), 'medium').else('small'),
  total: coalesce(amount, '0'),
});
