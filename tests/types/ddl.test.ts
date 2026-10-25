// Checked by tsc, not executed. Keep this as .ts so skipLibCheck cannot hide failures.
import { expectTypeOf } from 'vitest';
import { alterTable, defineTable, migrate, sqlType } from '../../src/ddl/index.js';
import { decimal, integer, type Snowtyped, snowflakeTable } from '../../src/index.js';

const accounts = snowflakeTable('ACCOUNTS', {
  id: integer('ID').notNull(),
  balance: decimal('BALANCE'),
});
defineTable(accounts, {
  types: { balance: sqlType.number(18, 2) },
  comments: { id: 'key', balance: null },
});
// @ts-expect-error Physical types are keyed by declared column keys, not physical names.
defineTable(accounts, { types: { BALANCE: sqlType.number(18, 2) } });
// @ts-expect-error Comments are keyed by declared column keys.
defineTable(accounts, { comments: { missing: 'x' } });
expectTypeOf<Snowtyped.ColumnDefinition['serverValue']>().toEqualTypeOf<
  Snowtyped.ServerValue | undefined
>();
alterTable(accounts).addColumn('N', sqlType.number(), {
  serverValue: { kind: 'identity', start: 1 },
});
// @ts-expect-error Server values use the column declaration shapes.
alterTable(accounts).addColumn('N', sqlType.number(), { serverValue: { kind: 'sequence' } });

declare const client: Snowtyped.SnowflakeClient;
expectTypeOf(
  migrate(client, [], { database: 'DB', schema: 'APP' }),
).resolves.toEqualTypeOf<Snowtyped.MigrateResult>();
expectTypeOf<Snowtyped.MigrationErrorCode>().toEqualTypeOf<
  'INVALID' | 'DESTRUCTIVE' | 'UNSUPPORTED' | 'LOCKED' | 'LOCK_LOST' | 'HISTORY_DRIFT' | 'FAILED'
>();
// @ts-expect-error Migrations take DDL statements or raw queries, not SQL strings.
migrate(client, [{ id: '1', statements: ['CREATE TABLE T (ID INT)'] }], {
  database: 'DB',
  schema: 'APP',
});
