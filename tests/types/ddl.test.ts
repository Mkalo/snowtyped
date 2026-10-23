// Checked by tsc, not executed. Keep this as .ts so skipLibCheck cannot hide failures.
import { expectTypeOf } from 'vitest';
import {
  defineTable,
  type MigrateResult,
  type MigrationErrorCode,
  migrate,
  sqlType,
} from '../../src/ddl/index.js';
import { decimal, integer, snowflakeTable } from '../../src/index.js';
import type { SnowflakeClient } from '../../src/snowflake/index.js';

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

declare const client: SnowflakeClient;
expectTypeOf(
  migrate(client, [], { database: 'DB', schema: 'APP' }),
).resolves.toEqualTypeOf<MigrateResult>();
expectTypeOf<MigrationErrorCode>().toEqualTypeOf<
  'INVALID' | 'DESTRUCTIVE' | 'UNSUPPORTED' | 'LOCKED' | 'LOCK_LOST' | 'HISTORY_DRIFT' | 'FAILED'
>();
// @ts-expect-error Migrations take DDL statements or raw queries, not SQL strings.
migrate(client, [{ id: '1', statements: ['CREATE TABLE T (ID INT)'] }], {
  database: 'DB',
  schema: 'APP',
});
