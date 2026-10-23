import { db } from './fixtures.js';
import { customers } from './schema.js';
// ---cut---

import { checkDrift, defineSchema, diffSchema, inspectSchema, pushSchema } from 'snowtyped/ddl';

const desired = defineSchema({ database: 'APP_DB', schema: 'PUBLIC' }, [customers]);

const observed = await inspectSchema(db, desired);
const { changes, unsupported } = diffSchema(desired, observed);
for (const change of changes) console.log(change.description, change.statement.compile().sql);

// The same comparison, ignoring the migration history tables:
const drift = await checkDrift(db, desired);

// Development only: apply the diff directly. Destructive changes need allowDestructive.
await pushSchema(db, desired);
