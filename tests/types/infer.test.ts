// Checked by tsc, not executed.
import { expectTypeOf } from 'vitest';
import type { InferInsert, InferRow, InferUpdate } from '../../src/index.js';
import {
  alias,
  count,
  decimal,
  eq,
  insert,
  integer,
  many,
  one,
  select,
  snowflakeTable,
  type sql,
  text,
  timestamp,
  update,
  withRelations,
} from '../../src/index.js';
import type { SnowflakeClient } from '../../src/snowflake/index.js';

const customers = snowflakeTable('CUSTOMERS', {
  id: integer('ID').notNull().identity(),
  name: text('NAME').notNull(),
  email: text('EMAIL'),
  status: text('STATUS').notNull().serverDefault("'new'"),
  created: timestamp('CREATED').serverDefault(),
  doubled: integer('DOUBLED').virtual('ID * 2'),
});
const orders = snowflakeTable('ORDERS', {
  id: integer('ID').notNull(),
  customerId: integer('CUSTOMER_ID').notNull(),
  amount: decimal('AMOUNT', { precision: 12, scale: 2 }).notNull(),
});
const c = customers.columns;
const o = orders.columns;
declare const db: SnowflakeClient;

type Customer = {
  readonly id: bigint;
  readonly name: string;
  readonly email: string | null;
  readonly status: string;
  readonly created: string | null;
  readonly doubled: bigint | null;
};
expectTypeOf<InferRow<typeof customers>>().toEqualTypeOf<Customer>();
const everything = select(customers);
expectTypeOf<InferRow<typeof everything>>().toEqualTypeOf<Customer>();
const renamed = alias(customers, 'c');
expectTypeOf<InferRow<typeof renamed>>().toEqualTypeOf<Customer>();

const projected = select(customers, { id: c.id, email: c.email }).where(eq(c.name, 'Ada'));
type Projected = { readonly id: bigint; readonly email: string | null };
expectTypeOf<InferRow<typeof projected>>().toEqualTypeOf<Projected>();
expectTypeOf(db.execute(projected))
  .resolves.toHaveProperty('rows')
  .toEqualTypeOf<readonly InferRow<typeof projected>[]>();
expectTypeOf(db.stream(projected)).toEqualTypeOf<AsyncIterable<InferRow<typeof projected>>>();

// Outer-joined columns become nullable, which the selection alone does not say.
const joined = select(customers)
  .leftJoin(orders, eq(c.id, o.customerId))
  .select({ name: c.name, amount: o.amount, customer: { id: c.id, orderId: o.id } });
expectTypeOf<InferRow<typeof joined>>().toEqualTypeOf<{
  readonly name: string;
  readonly amount: string | null;
  readonly customer: { readonly id: bigint; readonly orderId: bigint | null };
}>();
expectTypeOf(db.execute(joined))
  .resolves.toHaveProperty('rows')
  .toEqualTypeOf<readonly InferRow<typeof joined>[]>();

const grouped = select(orders, { customerId: o.customerId, orders: count() }).groupBy(o.customerId);
expectTypeOf<InferRow<typeof grouped>>().toEqualTypeOf<{
  readonly customerId: bigint;
  readonly orders: bigint;
}>();

const leads = snowflakeTable('LEADS', { id: integer('ID'), email: text('EMAIL').notNull() });
const unioned = select(customers, { id: c.id, email: c.email }).unionAll(
  select(leads, { id: leads.columns.id, email: leads.columns.email }),
);
expectTypeOf<InferRow<typeof unioned>>().toEqualTypeOf<{
  readonly id: bigint | null;
  readonly email: string | null;
}>();
expectTypeOf(db.execute(unioned))
  .resolves.toHaveProperty('rows')
  .toEqualTypeOf<readonly InferRow<typeof unioned>[]>();

const loaded = withRelations(select(customers, { id: c.id, name: c.name }), {
  orders: many(orders, { from: c.id, to: o.customerId }, (rows) =>
    rows.select({ id: o.id, amount: o.amount }),
  ),
  latest: one(orders, { from: c.id, to: o.customerId }),
});
type Loaded = {
  readonly id: bigint;
  readonly name: string;
  orders: { readonly id: bigint; readonly amount: string }[];
  latest: {
    readonly id: bigint;
    readonly customerId: bigint;
    readonly amount: string;
  } | null;
};
expectTypeOf<InferRow<typeof loaded>>().toEqualTypeOf<Loaded>();
expectTypeOf(db.execute(loaded)).resolves.toHaveProperty('rows').toEqualTypeOf<readonly Loaded[]>();

expectTypeOf<InferRow<typeof c.id>>().toEqualTypeOf<never>();
expectTypeOf<InferRow<ReturnType<typeof sql>>>().toEqualTypeOf<never>();
expectTypeOf<InferRow<ReturnType<typeof insert>>>().toEqualTypeOf<never>();
expectTypeOf<InferRow<unknown>>().toEqualTypeOf<never>();

type NewCustomer = InferInsert<typeof customers>;
expectTypeOf<NewCustomer>().toEqualTypeOf<{
  name: string;
  id?: bigint;
  email?: string | null;
  status?: string;
  created?: string | null;
}>();
const draft: NewCustomer = { name: 'Ada' };
insert(customers, draft);
insert(customers, [draft, { name: 'Grace', email: null }]);
// @ts-expect-error A required column without a server value must be present.
({ email: 'ada@example.com' }) satisfies NewCustomer;
// @ts-expect-error Virtual columns are read-only.
({ name: 'Ada', doubled: 2n }) satisfies NewCustomer;
expectTypeOf<InferInsert<typeof renamed>>().toEqualTypeOf<NewCustomer>();
expectTypeOf<InferInsert<typeof projected>>().toEqualTypeOf<never>();

type CustomerPatch = InferUpdate<typeof customers>;
expectTypeOf<CustomerPatch>().toEqualTypeOf<{
  id?: bigint;
  name?: string;
  email?: string | null;
  status?: string;
  created?: string | null;
}>();
const patch: CustomerPatch = { email: null };
update(customers, patch).where(eq(c.id, 1n));
// @ts-expect-error A NOT NULL column cannot be set to null.
({ name: null }) satisfies CustomerPatch;
// @ts-expect-error Virtual columns are read-only.
({ doubled: 2n }) satisfies CustomerPatch;
expectTypeOf<InferUpdate<typeof projected>>().toEqualTypeOf<never>();
