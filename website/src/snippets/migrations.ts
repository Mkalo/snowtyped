import { db } from './fixtures.js';
import { customers } from './schema.js';
// ---cut---

import {
  alterTable,
  createTable,
  defineSchema,
  defineTable,
  type Migration,
  migrate,
  migrationStatus,
  sqlType,
} from 'snowtyped/ddl';

const customersTable = defineTable(customers, {
  types: { name: sqlType.varchar(200) },
  comments: { email: 'Primary contact' },
});
const migrations: Migration[] = [
  { id: '0001_customers', statements: [createTable(customersTable)] },
  {
    id: '0002_customer_tier',
    statements: [alterTable(customers).addColumn('TIER', sqlType.varchar(20))],
  },
];
const target = { database: 'APP_DB', schema: 'PUBLIC' };

const { pending } = await migrationStatus(db, migrations, target);
const { applied, drift } = await migrate(db, migrations, {
  ...target,
  verify: defineSchema(target, [customersTable]),
});
// pending and applied: ['0001_customers', '0002_customer_tier'] on a fresh schema.
// drift lists the TIER column, which the declaration does not include yet.
