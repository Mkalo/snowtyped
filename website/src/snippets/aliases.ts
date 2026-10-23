import { customers } from './fixtures.js';
// ---cut---

import { alias, eq, select } from 'snowtyped';

const referrer = alias(customers, 'referrer');
const query = select(customers)
  .innerJoin(referrer, eq(customers.columns.email, referrer.columns.email))
  .select({ customer: customers.columns.name, referrer: referrer.columns.name });
