import type { ConnectionOptions } from 'snowflake-sdk';
import { customers } from './fixtures.js';

declare const connectionOptions: ConnectionOptions;

// ---cut---

import { select } from 'snowtyped';
import { createPool } from 'snowtyped/snowflake';

const pool = await createPool(connectionOptions, { min: 0, max: 5 });
try {
  await pool.execute(select(customers));
} finally {
  await pool.close();
}
