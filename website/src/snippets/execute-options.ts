import { customers, db } from './fixtures.js';
// ---cut---

import { select, sql } from 'snowtyped';

const controller = new AbortController();
const { rows } = await db.execute(select(customers), {
  signal: controller.signal,
  timeoutMs: 5_000,
});
const version = await db.queryRaw(sql`SELECT CURRENT_VERSION()`, { timeoutMs: 1_000 });
