import type { ConnectionOptions } from 'snowflake-sdk';
import { customers } from './fixtures.js';

declare const connectionOptions: ConnectionOptions;

// ---cut---

import { select } from 'snowtyped';
import { createPool } from 'snowtyped/snowflake';

const pool = await createPool(connectionOptions, {
  max: 10,
  acquireTimeoutMillis: 10_000,
  evictionRunIntervalMillis: 60_000,
  testOnBorrow: true,
});
// The deadline covers both the wait for a connection and the statement.
const { rows } = await pool.execute(select(customers), { timeoutMs: 30_000 });
