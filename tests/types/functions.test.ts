import { expectTypeOf } from 'vitest';
import {
  add,
  avg,
  boolean,
  caseWhen,
  cast,
  coalesce,
  concat,
  date,
  dateAdd,
  dateDiff,
  datePart,
  dateTrunc,
  decimal,
  div,
  eq,
  float,
  gt,
  type InferSelection,
  integer,
  isNull,
  jsonPath,
  length,
  mul,
  select,
  snowflakeTable,
  sub,
  substring,
  text,
  timestamp,
  trim,
  variant,
} from '../../src/index.js';

const accounts = snowflakeTable('ACCOUNTS', {
  id: integer('ID').notNull(),
  code: text('CODE'),
  balance: decimal('BALANCE').notNull(),
  data: variant('DATA').notNull(),
  rate: float('RATE').notNull(),
  bonus: decimal('BONUS'),
  active: boolean('ACTIVE'),
  opened: date('OPENED').notNull(),
  seen: timestamp('SEEN'),
});
const owners = snowflakeTable('OWNERS', { id: integer('ID').notNull() });
const { id, code, balance, data, rate, bonus, active, opened, seen } = accounts.columns;

const casts = select(accounts, {
  text: cast(id, 'text'),
  integer: cast(code, 'integer'),
  decimal: cast(id, 'decimal', 12, 2),
  float: cast(balance, 'float'),
  boolean: cast(code, 'boolean'),
  date: cast(code, 'date'),
  json: cast(jsonPath(data, 'x'), 'timestamp_tz'),
});
expectTypeOf<InferSelection<typeof casts.selection>>().toEqualTypeOf<{
  readonly text: string;
  readonly integer: bigint | null;
  readonly decimal: string;
  readonly float: number;
  readonly boolean: boolean | null;
  readonly date: string | null;
  readonly json: string | null;
}>();
const joinedCast = select(accounts)
  .leftJoin(owners, eq(accounts.columns.id, owners.columns.id))
  .select({ owner: cast(owners.columns.id, 'text') });
expectTypeOf<InferSelection<typeof joinedCast.selection, 'OWNERS'>>().toEqualTypeOf<{
  readonly owner: string | null;
}>();
eq(cast(id, 'text'), '1');
// @ts-expect-error A cast result compares in its target domain.
eq(cast(id, 'text'), 1n);
// @ts-expect-error Unknown cast targets are rejected.
cast(id, 'varchar');
// @ts-expect-error DECIMAL casts need an explicit precision and scale.
cast(id, 'decimal');
// @ts-expect-error A cast keeps its source scope.
select(owners, { value: cast(id, 'text') });

const math = select(accounts, {
  avgId: avg(id),
  avgRate: avg(rate),
  next: add(id, 1n),
  half: div(id, 2n),
  scaled: mul(balance, '1.5'),
  drift: sub(rate, 0.5),
  mixed: add(id, balance),
  floating: mul(id, rate),
  maybe: add(balance, bonus),
});
expectTypeOf<InferSelection<typeof math.selection>>().toEqualTypeOf<{
  readonly avgId: string | null;
  readonly avgRate: number | null;
  readonly next: bigint;
  readonly half: string;
  readonly scaled: string;
  readonly drift: number;
  readonly mixed: string;
  readonly floating: number;
  readonly maybe: string | null;
}>();
const joinedMath = select(accounts)
  .leftJoin(owners, eq(accounts.columns.id, owners.columns.id))
  .select({ next: add(owners.columns.id, id) });
expectTypeOf<InferSelection<typeof joinedMath.selection, 'OWNERS'>>().toEqualTypeOf<{
  readonly next: bigint | null;
}>();
// @ts-expect-error Literal operands use the left operand's representation.
add(id, '1');
// @ts-expect-error Boolean expressions are not numeric.
add(id, active);
// @ts-expect-error AVG requires a numeric representation.
avg(active);
// @ts-expect-error Arithmetic keeps its source scope.
select(owners, { value: add(owners.columns.id, id) });

const fallback = select(accounts, {
  code: coalesce(code, 'none'),
  maybe: coalesce(code, code),
  balance: coalesce(bonus, balance),
  tier: caseWhen(gt(id, 10n), 'big').when(gt(id, 5n), 'mid').else('small'),
  open: caseWhen(gt(id, 10n), 1n),
  amount: caseWhen(eq(active, true), bonus).else(balance),
});
expectTypeOf<InferSelection<typeof fallback.selection>>().toEqualTypeOf<{
  readonly code: string;
  readonly maybe: string | null;
  readonly balance: string;
  readonly tier: string;
  readonly open: bigint | null;
  readonly amount: string | null;
}>();
const joinedFallback = select(accounts)
  .leftJoin(owners, eq(accounts.columns.id, owners.columns.id))
  .select({
    guarded: coalesce(owners.columns.id, 0n),
    either: coalesce(owners.columns.id, id),
    label: caseWhen(isNull(owners.columns.id), 'none').else('owned'),
    owner: caseWhen(gt(id, 1n), owners.columns.id).else(0n),
  });
expectTypeOf<InferSelection<typeof joinedFallback.selection, 'OWNERS'>>().toEqualTypeOf<{
  readonly guarded: bigint;
  readonly either: bigint | null;
  readonly label: string;
  readonly owner: bigint | null;
}>();
// @ts-expect-error COALESCE values share one representation.
coalesce(id, '0');
// @ts-expect-error COALESCE needs a fallback value.
coalesce(id);
// @ts-expect-error CASE results share one representation.
caseWhen(gt(id, 1n), 'x').else(1n);
// @ts-expect-error CASE conditions must be predicates.
caseWhen(id, 'x');
// @ts-expect-error CASE keeps the scope of its conditions.
select(owners, { value: caseWhen(gt(id, 1n), 'x').else('y') });

const strings = select(accounts, {
  label: concat(code, ':', cast(id, 'text')),
  tag: concat(cast(id, 'text'), '!'),
  trimmed: trim(code),
  size: length(cast(id, 'text')),
  prefix: substring(code, 1, 2),
});
expectTypeOf<InferSelection<typeof strings.selection>>().toEqualTypeOf<{
  readonly label: string | null;
  readonly tag: string;
  readonly trimmed: string | null;
  readonly size: bigint;
  readonly prefix: string | null;
}>();
const dates = select(accounts, {
  month: dateTrunc('month', opened),
  next: dateAdd('day', 1n, opened),
  shifted: dateAdd('hour', id, seen),
  age: dateDiff('day', opened, '2026-01-01'),
  gap: dateDiff('day', opened, seen),
  year: datePart('year', opened),
});
expectTypeOf<InferSelection<typeof dates.selection>>().toEqualTypeOf<{
  readonly month: string;
  readonly next: string;
  readonly shifted: string | null;
  readonly age: bigint;
  readonly gap: bigint | null;
  readonly year: bigint;
}>();
// @ts-expect-error String helpers accept text representations.
concat(code, 1n);
// @ts-expect-error LENGTH accepts text representations.
length(id);
// @ts-expect-error Unknown date parts are rejected.
dateTrunc('decade', opened);
// @ts-expect-error DATE_PART does not support millisecond parts.
datePart('millisecond', seen);
// @ts-expect-error DATEADD amounts are integers.
dateAdd('day', 1, opened);
// @ts-expect-error DATEADD amounts are integer expressions.
dateAdd('day', balance, opened);
