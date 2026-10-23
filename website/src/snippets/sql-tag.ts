import { db } from './fixtures.js';
// ---cut---

import { sql } from 'snowtyped';

const byName = (name: string) => sql<Array<{ ID: string }>>`
  SELECT ID FROM ${sql.identifier('APP_DB', 'PUBLIC', 'CUSTOMERS')}
  WHERE NAME = ${name}
`;
const rows = await db.queryRaw(byName('Ada'));

const ids = [1n, 2n, 3n];
const listed = await db.queryRaw<Array<{ ID: string }>>(sql`
  SELECT ID FROM CUSTOMERS WHERE ID IN (${sql.join(ids)})
`);
