import { customers, db } from './fixtures.js';
// ---cut---

import { deleteFrom, eq, insert, update } from 'snowtyped';

await db.execute(insert(customers, { id: 1n, name: 'Ada', email: null }));
await db.execute(update(customers, { name: 'Grace' }).where(eq(customers.columns.id, 1n)));
const { affectedRows } = await db.execute(
  deleteFrom(customers).where(eq(customers.columns.id, 1n)),
);
