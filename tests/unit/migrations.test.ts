import { describe, expect, it, vi } from 'vitest';
import {
  alterTable,
  checkDrift,
  createTable,
  defineSchema,
  defineTable,
  dropTable,
  MigrationError,
  migrate,
  migrationStatus,
  pushSchema,
  sqlType,
} from '../../src/ddl/index.js';
import { integer, type Snowtyped, snowflakeTable, sql, text } from '../../src/index.js';

const target = { database: 'DB', schema: 'APP' };
const users = snowflakeTable('USERS', { id: integer('ID').notNull(), name: text('NAME') }, target);

interface Row {
  ID: string;
  ORDINAL: string;
  CHECKSUM: string;
  STATEMENT_CHECKSUMS: string;
  STATUS: string;
  STATEMENTS: string;
  APPLIED_STATEMENTS: string;
  ERROR: string | null;
}
/** Simulates the bookkeeping statements; any other statement is a migration statement. */
function database(options: { schema?: boolean; historyTable?: boolean } = {}) {
  const state = {
    schema: options.schema ?? true,
    historyTable: options.historyTable ?? true,
    rows: [] as Row[],
    owner: null as string | null,
    free: true,
    renew: [] as boolean[],
    executed: [] as string[],
    fail: undefined as ((text: string) => unknown) | undefined,
    failRecord: false,
    failRelease: false,
    inspect: [] as unknown[],
  };
  const updated = (count: number) => [{ 'number of rows updated': String(count) }];
  const row = (id: unknown) => state.rows.find((entry) => entry.ID === id) as Row;
  const queryRaw = vi.fn(async (query: Snowtyped.RawQuery) => {
    const { sql: text, binds } = query.compile();
    if (text.startsWith('SELECT 1 FROM') && text.includes('"SCHEMATA"'))
      return state.schema ? [{}] : [];
    if (text.startsWith('SELECT 1 FROM') && text.includes('"TABLES"'))
      return state.historyTable ? [{}] : [];
    if (text.includes('"INFORMATION_SCHEMA"')) return state.inspect.shift();
    if (/^(CREATE (SCHEMA|TABLE) IF NOT EXISTS|MERGE)/.test(text)) return [];
    if (text.startsWith('SELECT ID, ORDINAL')) return state.rows.map((entry) => ({ ...entry }));
    if (text.includes('_LOCK" SET "OWNER" = NULL')) {
      if (state.failRelease) throw new Error('release failed');
      if (state.owner === binds[0]) state.owner = null;
      return updated(1);
    }
    if (text.includes('_LOCK" SET "OWNER" = ?')) {
      if (!state.free) return updated(0);
      state.owner = binds[0] as string;
      return updated(1);
    }
    if (text.includes('_LOCK" SET "EXPIRES_AT"'))
      return updated(state.renew.shift() === false ? 0 : 1);
    if (text.startsWith('INSERT INTO "DB"."APP"."SNOWTYPED_MIGRATIONS"')) {
      const [id, ordinal, checksum, checksums, statements] = binds;
      state.rows.push({
        ID: id as string,
        ORDINAL: String(ordinal),
        CHECKSUM: checksum as string,
        STATEMENT_CHECKSUMS: checksums as string,
        STATUS: 'running',
        STATEMENTS: String(statements),
        APPLIED_STATEMENTS: '0',
        ERROR: null,
      });
      return [];
    }
    if (text.includes('SET "CHECKSUM"')) {
      Object.assign(row(binds[4]), {
        CHECKSUM: binds[0],
        STATEMENT_CHECKSUMS: binds[1],
        STATUS: 'running',
        STATEMENTS: String(binds[2]),
        ERROR: null,
      });
      return [];
    }
    if (text.includes(`SET "STATUS" = 'failed'`)) {
      if (state.failRecord) throw new Error('record failed');
      Object.assign(row(binds[1]), { STATUS: 'failed', ERROR: binds[0] });
      return [];
    }
    if (text.includes('SET "APPLIED_STATEMENTS"')) {
      row(binds[1]).APPLIED_STATEMENTS = String(binds[0]);
      return [];
    }
    if (text.includes(`SET "STATUS" = 'applied'`)) {
      row(binds[0]).STATUS = 'applied';
      return [];
    }
    if (state.fail) {
      const error = state.fail(text);
      if (error !== undefined) throw error;
    }
    state.executed.push(text);
    return [];
  });
  return { state, queryRaw, client: { queryRaw } as unknown as Snowtyped.SnowflakeClient };
}
const code = (value: string) => expect.objectContaining({ name: 'MigrationError', code: value });
const migrations: Snowtyped.Migration[] = [
  { id: '0001', statements: [createTable(defineTable(users))] },
  {
    id: '0002',
    statements: [
      alterTable(users).addColumn('A', sqlType.boolean()),
      sql`UPDATE T SET A = ${true}`,
    ],
  },
];

describe('migration validation', () => {
  it('rejects invalid declarations before touching the database', async () => {
    const { client, queryRaw } = database();
    await expect(
      migrate(client, [{ id: '', statements: [sql`SELECT 1`] }], target),
    ).rejects.toEqual(code('INVALID'));
    await expect(
      migrate(
        client,
        [migrations[0] as Snowtyped.Migration, migrations[0] as Snowtyped.Migration],
        target,
      ),
    ).rejects.toMatchObject({ code: 'INVALID', migration: '0001' });
    await expect(migrate(client, [{ id: 'x', statements: [] }], target)).rejects.toThrow(
      'has no statements',
    );
    await expect(
      migrate(client, [{ id: 'x', statements: ['DROP TABLE T' as never] }], target),
    ).rejects.toThrow('invalid statement');
    await expect(
      migrate(client, [{ id: 'x', statements: [dropTable(users)] }], target),
    ).rejects.toEqual(code('DESTRUCTIVE'));
    for (const leaseSeconds of [0, 1.5, 604_801])
      await expect(migrate(client, [], { ...target, leaseSeconds })).rejects.toThrow(
        'leaseSeconds',
      );
    expect(queryRaw).not.toHaveBeenCalled();
    const error = new MigrationError('LOCKED', 'held');
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ name: 'MigrationError', code: 'LOCKED', migration: undefined });
    expect(error.cause).toBeUndefined();
    expect(new MigrationError('FAILED', 'x', { cause: 'why', migration: 'm' })).toMatchObject({
      cause: 'why',
      migration: 'm',
    });
  });
});

describe('migration runs', () => {
  it('creates bookkeeping, applies in order, records progress, and releases the lock', async () => {
    const { client, state, queryRaw } = database({ schema: false });
    const result = await migrate(client, migrations, { ...target, leaseSeconds: 60 });
    expect(result).toEqual({ applied: ['0001', '0002'] });
    const texts = queryRaw.mock.calls.map(([query]) => query.compile().sql);
    expect(texts.slice(0, 5)).toEqual([
      'SELECT 1 FROM "DB"."INFORMATION_SCHEMA"."SCHEMATA" WHERE SCHEMA_NAME = ?',
      'CREATE SCHEMA IF NOT EXISTS "DB"."APP"',
      'CREATE TABLE IF NOT EXISTS "DB"."APP"."SNOWTYPED_MIGRATIONS" ("ID" VARCHAR NOT NULL, "ORDINAL" NUMBER(38, 0) NOT NULL, "CHECKSUM" VARCHAR NOT NULL, "STATEMENT_CHECKSUMS" VARCHAR NOT NULL, "STATUS" VARCHAR NOT NULL, "STATEMENTS" NUMBER(38, 0) NOT NULL, "APPLIED_STATEMENTS" NUMBER(38, 0) NOT NULL, "OWNER" VARCHAR NOT NULL, "STARTED_AT" TIMESTAMP_LTZ(9) NOT NULL, "FINISHED_AT" TIMESTAMP_LTZ(9), "ERROR" VARCHAR)',
      'CREATE TABLE IF NOT EXISTS "DB"."APP"."SNOWTYPED_MIGRATIONS_LOCK" ("ID" NUMBER(38, 0) NOT NULL, "OWNER" VARCHAR, "EXPIRES_AT" TIMESTAMP_LTZ(9))',
      'MERGE INTO "DB"."APP"."SNOWTYPED_MIGRATIONS_LOCK" AS "L" USING (SELECT 1 AS "ID") AS "S" ON "L"."ID" = "S"."ID" WHEN NOT MATCHED THEN INSERT ("ID") VALUES ("S"."ID")',
    ]);
    const acquire = queryRaw.mock.calls[5]?.[0].compile();
    expect(acquire?.sql).toContain('DATEADD(SECOND, ?, CURRENT_TIMESTAMP())');
    expect(acquire?.binds[1]).toBe(60);
    expect(state.executed).toEqual([
      'CREATE TABLE "DB"."APP"."USERS" ("ID" NUMBER(38, 0) NOT NULL, "NAME" VARCHAR)',
      'ALTER TABLE "DB"."APP"."USERS" ADD COLUMN "A" BOOLEAN',
      'UPDATE T SET A = ?',
    ]);
    expect(
      state.rows.map((row) => [row.ID, row.ORDINAL, row.STATUS, row.APPLIED_STATEMENTS]),
    ).toEqual([
      ['0001', '0', 'applied', '1'],
      ['0002', '1', 'applied', '2'],
    ]);
    expect(JSON.parse(state.rows[1]?.STATEMENT_CHECKSUMS as string)).toHaveLength(2);
    expect(state.owner).toBeNull();

    expect((await migrate(client, migrations, target)).applied).toEqual([]);
    expect(await migrationStatus(client, migrations, target)).toEqual({
      applied: ['0001', '0002'],
      pending: [],
    });
    const next = [...migrations, { id: '0003', statements: [dropTable(users)], destructive: true }];
    expect(await migrationStatus(client, next, target)).toEqual({
      applied: ['0001', '0002'],
      pending: ['0003'],
    });
    expect((await migrate(client, next, target)).applied).toEqual(['0003']);
  });

  it('reports pending migrations before history exists and refuses a held lock', async () => {
    const { client, state } = database({ historyTable: false });
    expect(await migrationStatus(client, migrations, target)).toEqual({
      applied: [],
      pending: ['0001', '0002'],
    });
    state.free = false;
    await expect(migrate(client, migrations, target)).rejects.toEqual(code('LOCKED'));
    expect(state.executed).toEqual([]);
  });

  it('detects history that no longer matches the declared migrations', async () => {
    const { client, state } = database();
    await migrate(client, migrations, target);
    const changed = [
      migrations[0] as Snowtyped.Migration,
      { id: '0002', statements: [sql`SELECT 2`] },
    ];
    await expect(migrate(client, changed, target)).rejects.toMatchObject({
      code: 'HISTORY_DRIFT',
      migration: '0002',
      message: 'Migration 0002 changed after it was applied.',
    });
    await expect(migrationStatus(client, migrations.slice(1), target)).rejects.toThrow(
      'missing or out of order',
    );
    await expect(migrationStatus(client, migrations.slice(0, 1), target)).rejects.toThrow(
      'missing or out of order',
    );
    expect(state.owner).toBeNull();
    (state.rows[1] as Row).ORDINAL = '5';
    await expect(migrationStatus(client, migrations, target)).rejects.toEqual(
      code('HISTORY_DRIFT'),
    );
    (state.rows[1] as Row).ORDINAL = '1';
    (state.rows[0] as Row).STATUS = 'failed';
    await expect(migrationStatus(client, migrations, target)).rejects.toThrow(
      'later migrations are recorded',
    );
  });

  it('records a failed statement and resumes after the committed prefix', async () => {
    const { client, state } = database();
    state.fail = (text) => (text.startsWith('UPDATE T') ? new Error('boom') : undefined);
    const error = await migrate(client, migrations, target).catch((reason: unknown) => reason);
    expect(error).toMatchObject({
      code: 'FAILED',
      migration: '0002',
      message: 'Migration 0002 failed at statement 2 of 2; earlier statements are committed.',
    });
    expect((error as Error).cause).toEqual(new Error('boom'));
    expect(state.owner).toBeNull();
    expect(await migrationStatus(client, migrations, target)).toEqual({
      applied: ['0001'],
      pending: [],
      incomplete: {
        id: '0002',
        status: 'failed',
        appliedStatements: 1,
        statements: 2,
        error: 'boom',
      },
    });
    await expect(migrate(client, migrations, target)).rejects.toThrow(
      'Migration 0002 failed after 1 of 2 statements: boom.',
    );
    const reordered: Snowtyped.Migration[] = [
      migrations[0] as Snowtyped.Migration,
      { id: '0002', statements: [sql`SELECT 0`, sql`UPDATE T SET A = ${true}`] },
    ];
    await expect(migrate(client, reordered, { ...target, resumeFailed: true })).rejects.toThrow(
      'Statements already committed by migration 0002 changed.',
    );
    state.fail = undefined;
    const fixed: Snowtyped.Migration[] = [
      migrations[0] as Snowtyped.Migration,
      {
        id: '0002',
        statements: [
          (migrations[1] as Snowtyped.Migration).statements[0] as Snowtyped.RawQuery,
          sql`UPDATE T SET A = ${false}`,
          sql`SELECT 3`,
        ],
      },
    ];
    const before = state.executed.length;
    expect((await migrate(client, fixed, { ...target, resumeFailed: true })).applied).toEqual([
      '0002',
    ]);
    expect(state.executed.slice(before)).toEqual(['UPDATE T SET A = ?', 'SELECT 3']);
    expect(state.rows[1]).toMatchObject({
      STATUS: 'applied',
      STATEMENTS: '3',
      APPLIED_STATEMENTS: '3',
      ERROR: null,
    });
    expect(await migrationStatus(client, fixed, target)).toEqual({
      applied: ['0001', '0002'],
      pending: [],
    });
    const shorter: Snowtyped.Migration[] = [
      migrations[0] as Snowtyped.Migration,
      { id: '0002', statements: [sql`SELECT 0`] },
    ];
    (state.rows[1] as Row).STATUS = 'running';
    await expect(migrationStatus(client, shorter, target)).rejects.toThrow(
      'Statements already committed',
    );
  });

  it('describes interrupted runs and stringifies non-Error failures', async () => {
    const { client, state } = database();
    state.fail = (text) => (text.startsWith('UPDATE T') ? 'plain failure' : undefined);
    await expect(migrate(client, migrations, target)).rejects.toEqual(code('FAILED'));
    expect(state.rows[1]?.ERROR).toBe('plain failure');
    Object.assign(state.rows[1] as Row, { STATUS: 'running', ERROR: null });
    await expect(migrate(client, migrations, target)).rejects.toThrow(
      'Migration 0002 was interrupted after 1 of 2 statements. Committed',
    );
  });

  it('keeps the original failure when recording it or releasing the lock fails', async () => {
    const { client, state } = database();
    state.fail = (text) => (text.startsWith('UPDATE T') ? new Error('boom') : undefined);
    state.failRecord = true;
    state.failRelease = true;
    await expect(migrate(client, migrations, target)).rejects.toEqual(code('FAILED'));
    expect(state.rows[1]?.STATUS).toBe('running');
    state.fail = undefined;
    await expect(migrate(client, migrations, { ...target, resumeFailed: true })).rejects.toThrow(
      'release failed',
    );
    expect(state.rows[1]?.STATUS).toBe('applied');
  });

  it('stops when the lease was taken by another run', async () => {
    const { client, state } = database();
    state.renew = [true, false];
    await expect(migrate(client, migrations, target)).rejects.toMatchObject({
      code: 'LOCK_LOST',
      migration: '0002',
    });
    expect(state.executed).toHaveLength(1);
    expect(state.rows[1]?.STATUS).toBe('running');
  });

  it('uses a custom history table and verifies the resulting schema', async () => {
    const { client, state, queryRaw } = database();
    state.inspect = [[{ COMMENT: null }], [], []];
    const verify = defineSchema(target, [users]);
    const result = await migrate(client, [], { ...target, historyTable: 'HISTORY', verify });
    expect(result.drift?.changes.map((change) => change.description)).toEqual([
      'Create table USERS',
    ]);
    const texts = queryRaw.mock.calls.map(([query]) => query.compile().sql);
    expect(texts.some((text) => text.includes('"DB"."APP"."HISTORY_LOCK"'))).toBe(true);
  });
});

describe('drift checks and schema pushes', () => {
  const column = (name: string, type: string, nullable = 'YES') => ({
    TABLE_NAME: 'USERS',
    COLUMN_NAME: name,
    DATA_TYPE: type,
    IS_NULLABLE: nullable,
    CHARACTER_MAXIMUM_LENGTH: type === 'TEXT' ? '16777216' : null,
    NUMERIC_PRECISION: type === 'NUMBER' ? '38' : null,
    NUMERIC_SCALE: type === 'NUMBER' ? '0' : null,
    DATETIME_PRECISION: null,
    COLUMN_DEFAULT: null,
    IS_IDENTITY: 'NO',
    COMMENT: null,
    DATA_TYPE_ALIAS: null,
    IDENTITY_START: null,
    IDENTITY_INCREMENT: null,
    IDENTITY_ORDERED: null,
    KIND: 'COLUMN',
    EXPRESSION: null,
  });
  const tables = (...names: string[]) => names.map((name) => ({ TABLE_NAME: name, COMMENT: null }));

  it('ignores bookkeeping tables and caller-ignored tables', async () => {
    const { client, state } = database();
    state.inspect = [
      [{ COMMENT: null }],
      tables('SNOWTYPED_MIGRATIONS', 'SNOWTYPED_MIGRATIONS_LOCK', 'USERS', 'KEEP'),
      [column('ID', 'NUMBER', 'NO'), column('NAME', 'TEXT')],
    ];
    expect(
      await checkDrift(client, defineSchema(target, [users]), { ignoreTables: ['KEEP'] }),
    ).toEqual({
      changes: [],
      unsupported: [],
    });
    state.inspect = [
      [{ COMMENT: null }],
      tables('H', 'H_LOCK', 'USERS'),
      [column('ID', 'NUMBER', 'NO'), column('NAME', 'TEXT')],
    ];
    expect(
      (await checkDrift(client, defineSchema(target, [users]), { historyTable: 'H' })).changes,
    ).toEqual([]);
  });

  it('applies safe diffs and gates unsupported and destructive ones', async () => {
    const { client, state } = database();
    state.inspect = [[], [], []];
    const created = await pushSchema(client, defineSchema(target, [users]));
    expect(state.executed).toEqual([
      'CREATE SCHEMA "DB"."APP"',
      'CREATE TABLE "DB"."APP"."USERS" ("ID" NUMBER(38, 0) NOT NULL, "NAME" VARCHAR)',
    ]);
    expect(created.changes).toHaveLength(2);

    state.inspect = [
      [{ COMMENT: null }],
      tables('USERS', 'OLD'),
      [column('ID', 'NUMBER', 'NO'), column('NAME', 'TEXT')],
    ];
    await expect(pushSchema(client, defineSchema(target, [users]))).rejects.toMatchObject({
      code: 'DESTRUCTIVE',
      message: 'Destructive changes need allowDestructive: Drop table OLD',
    });
    state.inspect = [
      [{ COMMENT: null }],
      tables('USERS', 'OLD'),
      [column('ID', 'NUMBER', 'NO'), column('NAME', 'TEXT')],
    ];
    await pushSchema(client, defineSchema(target, [users]), { allowDestructive: true });
    expect(state.executed.at(-1)).toBe('DROP TABLE "DB"."APP"."OLD"');

    state.inspect = [
      [{ COMMENT: null }],
      tables('USERS'),
      [column('ID', 'FLOAT', 'NO'), column('NAME', 'TEXT')],
    ];
    await expect(
      pushSchema(client, defineSchema(target, [users]), { allowDestructive: true }),
    ).rejects.toMatchObject({
      code: 'UNSUPPORTED',
      message: 'Write a migration for: USERS.ID: Cannot change FLOAT to NUMBER(38, 0) in place.',
    });
  });
});
