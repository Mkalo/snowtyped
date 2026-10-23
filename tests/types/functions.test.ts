import { expectTypeOf } from 'vitest';
import {
  cast,
  decimal,
  eq,
  type InferSelection,
  integer,
  jsonPath,
  select,
  snowflakeTable,
  text,
  variant,
} from '../../src/index.js';

const accounts = snowflakeTable('ACCOUNTS', {
  id: integer('ID').notNull(),
  code: text('CODE'),
  balance: decimal('BALANCE').notNull(),
  data: variant('DATA').notNull(),
});
const owners = snowflakeTable('OWNERS', { id: integer('ID').notNull() });
const { id, code, balance, data } = accounts.columns;

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
