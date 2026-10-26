import { expectTypeOf } from 'vitest';
import * as z from 'zod';
import {
  asc,
  eq,
  integer,
  recursiveCte,
  type Snowtyped,
  select,
  snowflakeTable,
  text,
  variant,
} from '../../src/index.js';

const employees = snowflakeTable('EMPLOYEES', {
  id: integer('ID').notNull(),
  managerId: integer('MANAGER_ID'),
  name: text('NAME').notNull(),
  title: text('TITLE'),
  payload: variant('PAYLOAD', z.object({ ok: z.boolean() })).notNull(),
  loose: variant('LOOSE').notNull(),
});
declare const db: Snowtyped.SnowflakeClient;
const { columns: e } = employees;
const anchor = select(employees, { id: e.id, managerId: e.managerId, name: e.name }).where(
  eq(e.id, 1n),
);

const chain = recursiveCte('CHAIN', anchor, (self) => {
  expectTypeOf(self.columns.id).toHaveProperty('readSchema').toEqualTypeOf<z.ZodType<bigint>>();
  expectTypeOf(self.columns.managerId)
    .toHaveProperty('readSchema')
    .toEqualTypeOf<z.ZodType<bigint | null>>();
  return select(employees, { name: e.name, id: e.id, managerId: e.managerId }).innerJoin(
    self,
    eq(e.managerId, self.columns.id),
  );
});
expectTypeOf(db.execute(select(chain).orderBy(asc(chain.columns.id))))
  .resolves.toHaveProperty('rows')
  .toEqualTypeOf<
    readonly { readonly id: bigint; readonly managerId: bigint | null; readonly name: string }[]
  >();

const titled = recursiveCte(
  'TITLED',
  select(employees, { id: e.id, title: e.name }),
  (self) =>
    select(employees, { id: e.id, title: e.title }).innerJoin(
      self,
      eq(e.managerId, self.columns.id),
    ),
  { nullable: ['title'] },
);
const derived = select(titled, { title: titled.columns.title }).as('derived');
expectTypeOf(db.execute(select(derived)))
  .resolves.toHaveProperty('rows')
  .toEqualTypeOf<readonly { readonly title: string | null }[]>();
const both = select(chain, { id: chain.columns.id, name: chain.columns.name }).union(
  select(titled, { id: titled.columns.id, name: titled.columns.title }),
);
expectTypeOf(db.execute(both))
  .resolves.toHaveProperty('rows')
  .toEqualTypeOf<readonly { readonly id: bigint; readonly name: string | null }[]>();

recursiveCte('PAYLOADS', select(employees, { payload: e.loose }), (self) =>
  select(employees, { payload: e.payload }).innerJoin(self, eq(e.id, e.id)),
);

recursiveCte('BAD_NULL', anchor, (self) =>
  // @ts-expect-error The recursive branch cannot introduce NULL into an undeclared column.
  select(employees, { id: e.id, managerId: e.managerId, name: e.title }).innerJoin(
    self,
    eq(e.managerId, self.columns.id),
  ),
);
recursiveCte('BAD_ALIAS', anchor, (self) =>
  // @ts-expect-error The recursive branch needs the anchor's projection aliases.
  select(employees, { id: e.id, name: e.name }).innerJoin(self, eq(e.managerId, self.columns.id)),
);
recursiveCte('BAD_DOMAIN', anchor, (self) =>
  // @ts-expect-error Recursive columns keep the anchor's domain.
  select(employees, { id: e.name, managerId: e.managerId, name: e.name }).innerJoin(
    self,
    eq(e.managerId, self.columns.id),
  ),
);
recursiveCte('BAD_VARIANT', select(employees, { payload: e.payload }), (self) =>
  // @ts-expect-error A looser VARIANT cannot feed a shaped contract.
  select(employees, { payload: e.loose }).innerJoin(self, eq(e.id, e.id)),
);
// @ts-expect-error Snowflake only recognizes uppercase recursive CTE names.
recursiveCte('chain', anchor, () => anchor);
// @ts-expect-error Only anchor columns can be declared nullable.
recursiveCte('CHAIN', anchor, () => anchor, { nullable: ['missing'] });
// @ts-expect-error Columns from the CTE under definition are not in the consumer's scope.
select(chain, { id: chain.columns.id, other: employees.columns.id });
