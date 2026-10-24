// ---cut---

import type { Connection } from 'snowflake-sdk';
import { eq, select } from 'snowtyped';
import { createClient } from 'snowtyped/snowflake';
import { customers } from './schema.js';

// connection is an already-connected snowflake-sdk Connection.
declare const connection: Connection;
const db = createClient(connection);

const { rows, queryId } = await db.execute(
  select(customers, {
    id: customers.columns.id,
    email: customers.columns.email,
  }).where(eq(customers.columns.name, 'Ada')),
);
// rows: readonly { readonly id: bigint; readonly email: string | null }[]
