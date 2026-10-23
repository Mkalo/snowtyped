import { expectTypeOf } from 'vitest';
import * as z from 'zod';
import {
  alias,
  count,
  eq,
  flatten,
  insert,
  integer,
  jsonPath,
  select,
  snowflakeTable,
  sql,
  text,
  update,
  variant,
} from '../../src/index.js';
import type { SnowflakeClient } from '../../src/snowflake/index.js';

const users = snowflakeTable('USERS', {
  id: integer('ID').notNull(),
  name: text('NAME').notNull(),
  data: variant('DATA').notNull(),
});
const orders = snowflakeTable('ORDERS', {
  id: integer('ID').notNull(),
  userId: integer('USER_ID').notNull(),
});
const other = snowflakeTable('OTHER', { id: integer('ID').notNull() });
const nullable = snowflakeTable('NULLABLE', { id: integer('ID') });
select(users).leftJoin(nullable, eq(users.columns.id, nullable.columns.id));
declare const db: SnowflakeClient;
const left = select(users)
  .leftJoin(orders, eq(users.columns.id, orders.columns.userId))
  .select({ name: users.columns.name, orderId: orders.columns.id, count: count() });
expectTypeOf(db.execute(left))
  .resolves.toHaveProperty('rows')
  .toEqualTypeOf<
    readonly { readonly name: string; readonly orderId: bigint | null; readonly count: bigint }[]
  >();
const right = select(users)
  .rightJoin(orders, eq(users.columns.id, orders.columns.userId))
  .select({ name: users.columns.name, orderId: orders.columns.id });
expectTypeOf(db.execute(right))
  .resolves.toHaveProperty('rows')
  .toEqualTypeOf<readonly { readonly name: string | null; readonly orderId: bigint }[]>();
const full = select(users)
  .fullJoin(orders, eq(users.columns.id, orders.columns.userId))
  .select({ name: users.columns.name, orderId: orders.columns.id });
expectTypeOf(db.execute(full))
  .resolves.toHaveProperty('rows')
  .toEqualTypeOf<readonly { readonly name: string | null; readonly orderId: bigint | null }[]>();
const inner = select(users)
  .innerJoin(orders, eq(users.columns.id, orders.columns.userId))
  .select({ id: orders.columns.id });
expectTypeOf(db.execute(inner))
  .resolves.toHaveProperty('rows')
  .toEqualTypeOf<readonly { readonly id: bigint }[]>();
const source = left.as('RESULT');
expectTypeOf(db.execute(select(source)))
  .resolves.toHaveProperty('rows')
  .toEqualTypeOf<
    readonly { readonly name: string; readonly orderId: bigint | null; readonly count: bigint }[]
  >();
const renamed = alias(users, 'u');
select(renamed).where(eq(renamed.columns.id, 1n));
const expanded = flatten(jsonPath(users.columns.data, 'items'), 'f');
select(users).lateralJoin(expanded).select({ value: expanded.columns.value });
expectTypeOf(db.queryRaw<{ ID: string }[]>(sql`SELECT 1 AS ID`)).toEqualTypeOf<
  Promise<{ ID: string }[]>
>();
expectTypeOf(db.queryRaw(sql`SELECT 1`)).toEqualTypeOf<Promise<unknown>>();
insert(users, { id: 1n, name: 'Ada', data: { ok: true } });
// @ts-expect-error A structured VARIANT type requires a schema declaration, not a generic assertion.
variant<{ ok: boolean }>('PAYLOAD');
// @ts-expect-error A column from a different scope cannot be projected.
select(users, { id: other.columns.id });
// @ts-expect-error A filter cannot reference a table that was not joined.
select(users).where(eq(other.columns.id, 1n));
// @ts-expect-error A column from the source's original identity is not its alias.
select(renamed).where(eq(users.columns.id, 1n));
// @ts-expect-error Comparisons cannot mix integer and text expressions.
eq(users.columns.id, users.columns.name);
// @ts-expect-error Required declared columns must be present in inserts.
insert(users, { id: 1n, data: {} });
// @ts-expect-error Required VARIANT columns cannot be omitted even though their type is unknown.
insert(users, { id: 1n, name: 'Ada' });
// @ts-expect-error Insert values must match the declared domain.
insert(users, { id: '1', name: 'Ada', data: {} });
// @ts-expect-error Unknown insert column.
insert(users, { id: 1n, name: 'Ada', data: {}, missing: true });
// @ts-expect-error Unknown update column.
update(users, { missing: true });
// @ts-expect-error Update expressions must refer to the mutation's table.
update(users, { id: other.columns.id });
const tagged = snowflakeTable('TAGGED', {
  tag: variant('TAG', z.enum(['a', 'b'])).notNull(),
});
select(tagged).where(eq(tagged.columns.tag, 'a'));
