import { expectTypeOf } from 'vitest';
import {
  add,
  avg,
  boolean,
  cast,
  decimal,
  div,
  eq,
  float,
  type InferSelection,
  integer,
  jsonPath,
  mul,
  select,
  snowflakeTable,
  sub,
  text,
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
});
const owners = snowflakeTable('OWNERS', { id: integer('ID').notNull() });
const { id, code, balance, data, rate, bonus, active } = accounts.columns;

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
