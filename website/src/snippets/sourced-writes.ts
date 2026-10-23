import { db, staged, target } from './fixtures.js';
// ---cut---

import { deleteUsing, eq, insertFrom, select, updateFrom } from 'snowtyped';

const byId = eq(target.columns.id, staged.columns.id);
await db.execute(
  insertFrom(target, select(staged, { id: staged.columns.id, name: staged.columns.name })),
);
await db.execute(updateFrom(target, staged, byId, { name: staged.columns.name }));
await db.execute(deleteUsing(target, staged, byId).where(eq(staged.columns.name, 'gone')));
