import { db, staged, target } from './fixtures.js';
// ---cut---

import { eq, mergeInto } from 'snowtyped';

await db.execute(
  mergeInto(target, staged, eq(target.columns.id, staged.columns.id))
    .whenMatchedUpdate({ name: staged.columns.name })
    .whenNotMatchedInsert({ id: staged.columns.id, name: staged.columns.name }),
);
