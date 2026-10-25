import { customers, db } from './fixtures.js';
// ---cut---

import { eq, insert, type Snowtyped, update } from 'snowtyped';

export async function createCustomer(input: Snowtyped.InferInsert<typeof customers>) {
  await db.execute(insert(customers, input));
}
export async function patchCustomer(id: bigint, patch: Snowtyped.InferUpdate<typeof customers>) {
  await db.execute(update(customers, patch).where(eq(customers.columns.id, id)));
}
