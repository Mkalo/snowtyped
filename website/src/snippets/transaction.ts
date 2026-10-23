import { customers, db } from './fixtures.js';
// ---cut---

import { eq, insert, update } from 'snowtyped';

await db.transaction(async (tx) => {
  await tx.execute(insert(customers, { id: 2n, name: 'Grace' }));
  await tx.execute(update(customers, { email: null }).where(eq(customers.columns.id, 2n)));
});
