import { expectTypeOf } from 'vitest';
import * as z from 'zod';
import {
  and,
  binary,
  boolean,
  count,
  date,
  decimal,
  eq,
  float,
  gt,
  integer,
  jsonPath,
  like,
  lower,
  lt,
  max,
  mergeInto,
  min,
  over,
  select,
  snowflakeTable,
  sum,
  text,
  time,
  timestamp,
  update,
  upper,
  variant,
} from '../../src/index.js';

const t = snowflakeTable('T', {
  id: integer('ID').notNull(),
  amount: decimal('AMOUNT'),
  ratio: float('RATIO'),
  name: text('NAME'),
  active: boolean('ACTIVE'),
  day: date('DAY'),
  clock: time('CLOCK'),
  ntz: timestamp('NTZ'),
  tz: timestamp('TZ', 'tz'),
  data: binary('DATA'),
  json: variant('JSON'),
  flag: variant('FLAG', z.boolean()),
  label: variant('LABEL', z.string()),
});
const u = snowflakeTable('U', { id: integer('ID').notNull(), day: date('DAY') });
const c = t.columns;

expectTypeOf(c.tz.dataType).toEqualTypeOf<'timestamp_tz'>();
expectTypeOf(c.ntz.dataType).toEqualTypeOf<'timestamp_ntz'>();
expectTypeOf(timestamp('AT', 'ltz', { precision: 3 }).dataType).toEqualTypeOf<'timestamp_ltz'>();
expectTypeOf(text('CODE', { length: 4 }).notNull().dataType).toEqualTypeOf<'text'>();
expectTypeOf(decimal('PRICE', { precision: 10, scale: 2 }).dataType).toEqualTypeOf<'decimal'>();
expectTypeOf(c.name.notNull().dataType).toEqualTypeOf<'text'>();
expectTypeOf(sum(c.id).dataType).toEqualTypeOf<'decimal'>();
expectTypeOf(sum(c.ratio).dataType).toEqualTypeOf<'float'>();
expectTypeOf(min(c.day).dataType).toEqualTypeOf<'date'>();
expectTypeOf(over(max(c.data)).dataType).toEqualTypeOf<'binary'>();
expectTypeOf(count().dataType).toEqualTypeOf<'integer'>();
expectTypeOf(jsonPath(c.json, 'a').dataType).toEqualTypeOf<'variant'>();
const derived = select(t, { day: min(c.day), total: sum(c.amount) }).as('D');
expectTypeOf(derived.columns.day.dataType).toEqualTypeOf<'date'>();

eq(c.id, c.amount);
lt(c.ratio, c.id);
gt(c.day, c.tz);
eq(c.ntz, c.tz);
eq(jsonPath(c.json, 'a'), c.name);
eq(c.day, jsonPath(c.json, 'a'));
eq(jsonPath(c.json, 'a'), 'text');
eq(c.json, c.data);
like(c.label, 'a%');
lower(c.label);
select(t).where(and(c.active, eq(c.flag, true)));
update(t, { ratio: c.ratio, ntz: c.day, name: c.label });

// @ts-expect-error TEXT and DATE share a TypeScript representation but are different SQL types.
eq(c.name, c.day);
// @ts-expect-error DECIMAL strings are not TEXT.
eq(c.amount, c.name);
// @ts-expect-error TIME cannot be compared with timestamps.
lt(c.clock, c.ntz);
// @ts-expect-error BINARY cannot be compared with TEXT.
eq(c.data, c.name);
// @ts-expect-error BOOLEAN cannot be compared with TEXT.
eq(c.active, c.name);
// @ts-expect-error Derived columns keep their SQL type.
eq(derived.columns.day, c.name);
// @ts-expect-error LIKE requires TEXT, not DATE.
like(c.day, '2024%');
// @ts-expect-error LOWER requires TEXT, not DECIMAL.
lower(c.amount);
// @ts-expect-error UPPER requires TEXT, not a timestamp.
upper(c.tz);
// @ts-expect-error SUM requires a numeric type.
sum(c.name);
// @ts-expect-error SUM requires a numeric type, not DATE.
sum(c.day);
// @ts-expect-error JSON paths require a VARIANT source.
jsonPath(c.name, 'a');
// @ts-expect-error A VARIANT is not a BOOLEAN predicate.
select(t).where(c.flag);
// @ts-expect-error AND operands must be BOOLEAN.
and(c.active, c.flag);
// @ts-expect-error UPDATE values must match the column's SQL type.
update(t, { day: c.name });
// @ts-expect-error UPDATE values must match the column's SQL type.
update(t, { name: c.day });
const mismatched = { id: u.columns.id, name: u.columns.day };
// @ts-expect-error MERGE inserts must match the column's SQL type.
mergeInto(t, u, eq(c.id, u.columns.id)).whenNotMatchedInsert(mismatched);
mergeInto(t, u, eq(c.id, u.columns.id)).whenNotMatchedInsert({
  id: u.columns.id,
  day: u.columns.day,
});
