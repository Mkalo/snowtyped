import { eq, select } from 'snowtyped';
import { expect, it } from 'vitest';
import { customers } from './schema.js';

it('binds user input instead of inlining it', () => {
  const query = select(customers, { name: customers.columns.name }).where(
    eq(customers.columns.name, "Ada'; --"),
  );
  expect(query.compile()).toEqual({
    sql: 'SELECT "NAME" AS "name" FROM "APP_DB"."PUBLIC"."CUSTOMERS" WHERE ("NAME" = ?)',
    binds: ["Ada'; --"],
  });
});
