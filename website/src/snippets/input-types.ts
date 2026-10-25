import { customers, db } from './fixtures.js';
// ---cut---

import { eq, type InferInsert, type InferUpdate, insert, update } from 'snowtyped';

export async function createCustomer(input: InferInsert<typeof customers>) {
  await db.execute(insert(customers, input));
}
export async function patchCustomer(id: bigint, patch: InferUpdate<typeof customers>) {
  await db.execute(update(customers, patch).where(eq(customers.columns.id, id)));
}
