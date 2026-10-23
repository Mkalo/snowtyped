import { budgets, db, sales } from './fixtures.js';
// ---cut---

import { dynamicPivot, pivot, select, unpivot } from 'snowtyped';

const quarterly = pivot(sales, 'QUARTERLY', {
  aggregate: 'sum',
  value: 'amount',
  for: 'quarter',
  in: { q1: 'Q1', q2: 'Q2' },
  default: '0',
});
const totals = await db.execute(select(quarterly));
// rows: readonly { readonly region: string | null; readonly q1: string; readonly q2: string }[]

const monthly = unpivot(budgets, 'MONTHLY', { value: 'amount', for: 'month', in: ['jan', 'feb'] });
const amounts = await db.execute(select(monthly));
// rows: readonly { readonly id: bigint; readonly amount: string; readonly month: 'jan' | 'feb' }[]

const anyQuarter = await db.queryRaw(
  dynamicPivot(sales, 'ANY_QUARTER', { aggregate: 'count', value: 'amount', for: 'quarter' }),
);
// unknown: the columns depend on the data
