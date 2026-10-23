import { db, employees } from './fixtures.js';
// ---cut---

import { eq, recursiveCte, select } from 'snowtyped';

const e = employees.columns;
const reports = recursiveCte(
  'REPORTS',
  select(employees, { id: e.id, name: e.name }).where(eq(e.id, 1n)),
  (self) =>
    select(employees, { id: e.id, name: e.name }).innerJoin(self, eq(e.managerId, self.columns.id)),
);
const { rows } = await db.execute(select(reports));
