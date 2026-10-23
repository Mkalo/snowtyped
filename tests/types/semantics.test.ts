import { expectTypeOf } from 'vitest';
import * as z from 'zod';
import {
  add,
  and,
  array,
  asc,
  avg,
  binary,
  boolean,
  caseWhen,
  cast,
  coalesce,
  concat,
  count,
  date,
  dateAdd,
  dateDiff,
  datePart,
  dateTrunc,
  decimal,
  div,
  eq,
  float,
  geography,
  geometry,
  gt,
  inArray,
  insertFrom,
  integer,
  jsonPath,
  lag,
  length,
  like,
  lower,
  lt,
  max,
  mergeInto,
  min,
  object,
  over,
  rank,
  rowNumber,
  select,
  snowflakeTable,
  sum,
  text,
  time,
  timestamp,
  update,
  upper,
  variant,
  vector,
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

const s = snowflakeTable('S', {
  list: array('LIST'),
  doc: object('DOC'),
  place: geography('PLACE'),
  shape: geometry('SHAPE'),
  embedding: vector('EMBEDDING', 'float', 2),
  json: variant('JSON'),
});
const d = s.columns;
eq(d.list, d.json);
eq(d.json, d.doc);
eq(d.embedding, d.embedding);
eq(d.place, null);
jsonPath(d.list, 0);
jsonPath(d.doc, 'a');
min(d.json);
select(s, { list: d.list }).groupBy(d.list).orderBy(asc(d.doc));
// @ts-expect-error ARRAY cannot be compared with OBJECT.
eq(d.list, d.doc);
// @ts-expect-error ARRAY cannot be compared with TEXT.
eq(d.list, c.name);
// @ts-expect-error GEOGRAPHY values cannot be compared.
eq(d.place, d.place);
// @ts-expect-error A typed VARIANT cannot be compared with GEOMETRY.
eq(c.label, d.shape);
// @ts-expect-error IN does not accept GEOGRAPHY.
inArray(d.place, []);
// @ts-expect-error MIN does not accept ARRAY.
min(d.list);
// @ts-expect-error MAX does not accept VECTOR.
max(d.embedding);
// @ts-expect-error MIN does not accept GEOMETRY.
min(d.shape);
// @ts-expect-error JSON paths do not accept VECTOR.
jsonPath(d.embedding, 0);
// @ts-expect-error GEOGRAPHY cannot be an ORDER BY key.
asc(d.place);
// @ts-expect-error GEOMETRY cannot be a GROUP BY key.
select(s).groupBy(d.shape);
// @ts-expect-error GEOGRAPHY cannot be a PARTITION BY key.
rowNumber({ partitionBy: [d.place] });

expectTypeOf(add(c.id, 1n).dataType).toEqualTypeOf<'integer'>();
expectTypeOf(add(c.id, c.amount).dataType).toEqualTypeOf<'decimal'>();
expectTypeOf(div(c.id, c.id).dataType).toEqualTypeOf<'decimal'>();
expectTypeOf(add(c.ratio, c.id).dataType).toEqualTypeOf<'float'>();
expectTypeOf(avg(c.ratio).dataType).toEqualTypeOf<'float'>();
expectTypeOf(avg(c.amount).dataType).toEqualTypeOf<'decimal'>();
expectTypeOf(cast(c.name, 'date').dataType).toEqualTypeOf<'date'>();
expectTypeOf(cast(c.name, 'decimal', 10, 2).dataType).toEqualTypeOf<'decimal'>();
expectTypeOf(concat(c.name, 'x').dataType).toEqualTypeOf<'text'>();
expectTypeOf(length(c.name).dataType).toEqualTypeOf<'integer'>();
expectTypeOf(dateAdd('day', 1n, c.day).dataType).toEqualTypeOf<'date'>();
expectTypeOf(dateAdd('hour', 1n, c.day).dataType).toEqualTypeOf<'timestamp_ntz'>();
expectTypeOf(dateAdd('hour', 1n, c.tz).dataType).toEqualTypeOf<'timestamp_tz'>();
expectTypeOf(dateTrunc('month', c.ntz).dataType).toEqualTypeOf<'timestamp_ntz'>();
expectTypeOf(datePart('year', c.day).dataType).toEqualTypeOf<'integer'>();
expectTypeOf(caseWhen(c.active, 'a').dataType).toEqualTypeOf<'text'>();
expectTypeOf(caseWhen(c.active, c.day).else(c.day).dataType).toEqualTypeOf<'date'>();
expectTypeOf(coalesce(c.day, '2024-01-01').dataType).toEqualTypeOf<'date'>();
expectTypeOf(lag(c.day, { orderBy: [asc(c.id)] }).dataType).toEqualTypeOf<'date'>();
expectTypeOf(rank({ orderBy: [asc(c.id)] }).dataType).toEqualTypeOf<'integer'>();
eq(add(c.id, 1n), c.amount);
lt(dateAdd('hour', 1n, c.day), c.tz);
insertFrom(t, select(u, { id: u.columns.id, day: u.columns.day }));

// @ts-expect-error COALESCE values must share one SQL type.
coalesce(c.name, c.day);
// @ts-expect-error CASE values must share one SQL type.
caseWhen(c.active, c.name).else(c.day);
// @ts-expect-error CASE WHEN needs a BOOLEAN predicate.
caseWhen(c.flag, 1n);
// @ts-expect-error LAG defaults must share the value's SQL type.
lag(c.name, { orderBy: [asc(c.id)], default: c.day });
// @ts-expect-error String helpers require TEXT.
length(c.day);
// @ts-expect-error String helpers require TEXT, not a VARIANT.
concat(c.name, c.label);
// @ts-expect-error Date helpers require a date, time, or timestamp.
dateTrunc('day', c.name);
// @ts-expect-error Date helpers require a date, time, or timestamp.
dateDiff('day', c.day, c.name);
// @ts-expect-error Arithmetic requires numeric types.
add(c.amount, c.name);
// @ts-expect-error dateAdd amounts must be INTEGER.
dateAdd('day', c.amount, c.day);
// @ts-expect-error INSERT ... SELECT values must match the column's SQL type.
insertFrom(t, select(u, { id: u.columns.id, name: u.columns.day }));
