import { writeFile } from 'node:fs/promises';
import { db } from './fixtures.js';
// ---cut---

import { generateSchema, introspect } from 'snowtyped';

const tables = await introspect(db, { database: 'APP_DB', schema: 'PUBLIC' });
await writeFile('src/db/schema.ts', generateSchema(tables));
