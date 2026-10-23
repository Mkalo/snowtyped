import { db } from './fixtures.js';

declare const name: string;
// ---cut---

const rows = await db.queryRaw<Array<{ id: string; name: string }>>`
  SELECT ID AS "id", NAME AS "name"
  FROM APP_DB.PUBLIC.CUSTOMERS
  WHERE NAME = ${name}
`;

const result = await db.queryRaw`SELECT CURRENT_VERSION()`;
// result: unknown
