import { expectTypeOf } from 'vitest';
import * as z from 'zod';
import {
  asc,
  date,
  decimal,
  eq,
  integer,
  select,
  snowflakeTable,
  text,
  timestamp,
  variant,
} from '../../src/index.js';
import type { SnowflakeClient } from '../../src/snowflake/index.js';

const current = snowflakeTable('CURRENT', {
  id: integer('ID').notNull(),
  name: text('NAME').notNull(),
  email: text('EMAIL'),
  amount: decimal('AMOUNT').notNull(),
  day: date('DAY').notNull(),
  payload: variant('PAYLOAD', z.object({ ok: z.boolean() })).notNull(),
});
const archived = snowflakeTable('ARCHIVED', {
  id: integer('ID').notNull(),
  name: text('NAME'),
  email: text('EMAIL').notNull(),
  amount: decimal('AMOUNT').notNull(),
  day: date('DAY').notNull(),
  at: timestamp('AT').notNull(),
  payload: variant('PAYLOAD').notNull(),
});
declare const db: SnowflakeClient;

const left = select(current, {
  id: current.columns.id,
  name: current.columns.name,
  email: current.columns.email,
});
const right = select(archived, {
  email: archived.columns.email,
  id: archived.columns.id,
  name: archived.columns.name,
});
expectTypeOf(db.execute(left.union(right)))
  .resolves.toHaveProperty('rows')
  .toEqualTypeOf<
    readonly { readonly id: bigint; readonly name: string | null; readonly email: string | null }[]
  >();
expectTypeOf(db.execute(left.unionAll(right).orderBy(asc(left.unionAll(right).columns.id))))
  .resolves.toHaveProperty('rows')
  .toEqualTypeOf<
    readonly { readonly id: bigint; readonly name: string | null; readonly email: string | null }[]
  >();
expectTypeOf(db.execute(left.intersect(right)))
  .resolves.toHaveProperty('rows')
  .toEqualTypeOf<
    readonly { readonly id: bigint; readonly name: string; readonly email: string }[]
  >();
expectTypeOf(db.execute(left.except(right)))
  .resolves.toHaveProperty('rows')
  .toEqualTypeOf<
    readonly { readonly id: bigint; readonly name: string; readonly email: string | null }[]
  >();
const nested = left.union(right.intersect(left)).except(right);
for await (const row of db.stream(nested))
  expectTypeOf(row).toEqualTypeOf<{
    readonly id: bigint;
    readonly name: string;
    readonly email: string | null;
  }>();

const payloads = select(current, { payload: current.columns.payload }).union(
  select(archived, { payload: archived.columns.payload }),
);
expectTypeOf(db.execute(payloads))
  .resolves.toHaveProperty('rows')
  .toEqualTypeOf<readonly { readonly payload: unknown }[]>();
const shaped = select(current, { payload: current.columns.payload }).except(
  select(archived, { payload: archived.columns.payload }),
);
expectTypeOf(db.execute(shaped))
  .resolves.toHaveProperty('rows')
  .toEqualTypeOf<readonly { readonly payload: { ok: boolean } }[]>();

const combined = left.union(right).as('combined');
expectTypeOf(db.execute(select(combined).where(eq(combined.columns.id, 1n))))
  .resolves.toHaveProperty('rows')
  .toEqualTypeOf<
    readonly { readonly id: bigint; readonly name: string | null; readonly email: string | null }[]
  >();
const cte = left.union(right).asCte('combined_cte');
select(cte, { email: cte.columns.email });
select(archived, { amount: archived.columns.amount, day: archived.columns.day }).union(
  select(current, { day: current.columns.day, amount: current.columns.amount }),
);

// @ts-expect-error Branches need the same projection aliases.
left.union(select(archived, { id: archived.columns.id, name: archived.columns.name }));
// @ts-expect-error Branches cannot add projection aliases.
left.union(right.select({ ...right.selection, extra: archived.columns.at }));
const textIds = select(archived, {
  id: archived.columns.name,
  name: archived.columns.name,
  email: archived.columns.email,
});
// @ts-expect-error Integer and text domains cannot be combined.
left.union(textIds);
const decimals = select(archived, { value: archived.columns.amount });
// @ts-expect-error Integer and decimal domains cannot be combined.
select(current, { value: current.columns.id }).intersect(decimals);
// @ts-expect-error Set operation ordering uses the combined query's columns.
left.union(right).orderBy(asc(current.columns.id));
