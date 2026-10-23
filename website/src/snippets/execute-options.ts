import { customers, db } from './fixtures.js';
// ---cut---

import { select } from 'snowtyped';

const controller = new AbortController();
const { rows } = await db.execute(select(customers), {
  signal: controller.signal,
  timeoutMs: 5_000,
});
