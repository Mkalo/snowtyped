// Checked by tsc, not executed.
import { expectTypeOf } from 'vitest';
import type { Migration, SchemaDiff } from '../../src/ddl/index.js';
import * as core from '../../src/index.js';
import {
  type Column,
  type InferSelection,
  integer,
  type PivotOptions,
  type SelectQuery,
  type Snowtyped,
  select,
  snowflakeTable,
  type Table,
  text,
} from '../../src/index.js';
import type { QueryResult, SnowflakeClient } from '../../src/snowflake/index.js';

const customers = snowflakeTable('CUSTOMERS', {
  id: integer('ID').notNull(),
  email: text('EMAIL'),
});
const query = select(customers, { id: customers.columns.id });
type Columns = typeof customers.columns;

// The deprecated flat exports are the namespace members, including their defaults.
expectTypeOf<Table>().toEqualTypeOf<Snowtyped.Table>();
expectTypeOf<Table<Columns, 'CUSTOMERS'>>().toEqualTypeOf<Snowtyped.Table<Columns, 'CUSTOMERS'>>();
expectTypeOf<Column<bigint>>().toEqualTypeOf<Snowtyped.Column<bigint>>();
expectTypeOf<SelectQuery<Columns>>().toEqualTypeOf<Snowtyped.SelectQuery<Columns>>();
expectTypeOf<InferSelection<Columns>>().toEqualTypeOf<Snowtyped.InferSelection<Columns>>();
expectTypeOf<PivotOptions<Columns, 'sum', 'id', 'email', readonly [], undefined>>().toEqualTypeOf<
  Snowtyped.PivotOptions<Columns, 'sum', 'id', 'email', readonly [], undefined>
>();
expectTypeOf<QueryResult<{ id: bigint }>>().toEqualTypeOf<Snowtyped.QueryResult<{ id: bigint }>>();
expectTypeOf<SnowflakeClient>().toEqualTypeOf<Snowtyped.SnowflakeClient>();
expectTypeOf<Migration>().toEqualTypeOf<Snowtyped.Migration>();
expectTypeOf<SchemaDiff>().toEqualTypeOf<Snowtyped.SchemaDiff>();

expectTypeOf<Snowtyped.InferRow<typeof query>>().toEqualTypeOf<{ readonly id: bigint }>();
expectTypeOf(customers).toEqualTypeOf<Snowtyped.Table<Columns, 'CUSTOMERS'>>();

// The namespace holds types only.
// @ts-expect-error `Snowtyped` is not a value.
core.Snowtyped;
