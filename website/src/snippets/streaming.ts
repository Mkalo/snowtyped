import { customers, db } from './fixtures.js';
// ---cut---

import { select, sql } from 'snowtyped';

for await (const row of db.stream(select(customers))) {
  // row is typed and validated: { id: bigint; name: string; email: string | null }
}

for await (const row of db.streamRaw<{ ID: string }>(sql`SELECT ID FROM CUSTOMERS`)) {
  // row type is asserted, not validated
}
