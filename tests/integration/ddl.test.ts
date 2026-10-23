import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  alterTable,
  checkDrift,
  createTable,
  defineSchema,
  defineTable,
  dropTable,
  inspectSchema,
  type Migration,
  MigrationError,
  migrate,
  migrationStatus,
  pushSchema,
  sqlType,
} from '../../src/ddl/index.js';
import {
  array,
  binary,
  boolean,
  date,
  decimal,
  eq,
  float,
  geography,
  geometry,
  insert,
  integer,
  object,
  select,
  snowflakeTable,
  sql,
  text,
  time,
  timestamp,
  variant,
  vector,
} from '../../src/index.js';
import { createFixture, integrationConfig } from '../support/snowflake.js';

describe('DDL builders, schema diffs, and migrations against Snowflake', () => {
  const fixture = createFixture(integrationConfig());
  const other = createFixture(integrationConfig());
  const db = fixture.client;
  const database = fixture.table.node.parts[0] as string;
  // Derived from the fixture's unique name, so cleanup only targets schemas this file created.
  const migrated = { database, schema: `${fixture.schemaName}_MIGRATED` };
  const pushed = { database, schema: `${fixture.schemaName}_PUSHED` };
  const typed = { database, schema: `${fixture.schemaName}_TYPED` };
  const accounts = snowflakeTable(
    'ACCOUNTS',
    {
      id: integer('ID').notNull(),
      name: text('NAME').notNull(),
      balance: decimal('BALANCE').notNull(),
    },
    migrated,
  );
  const accountsTable = defineTable(accounts, {
    types: { name: sqlType.varchar(100), balance: sqlType.number(18, 2) },
    comment: "Customer's \\ accounts",
    comments: { name: 'Display name' },
  });
  const failed = (code: string) => expect.objectContaining({ name: 'MigrationError', code });

  beforeAll(async () => {
    await fixture.seed();
    await other.seed();
  });
  afterAll(async () => {
    try {
      for (const target of [migrated, pushed, typed])
        await db.queryRaw(
          sql`DROP SCHEMA IF EXISTS ${sql.identifier(target.database, target.schema)} CASCADE`,
        );
    } finally {
      await Promise.all([fixture.cleanup(), other.cleanup()]);
    }
  });

  it('applies migrations once, records history, and serves typed queries on the result', async () => {
    const migrations: Migration[] = [
      { id: '0001_accounts', statements: [createTable(accountsTable)] },
      {
        id: '0002_seed',
        statements: [
          sql`INSERT INTO ${sql.identifier(database, migrated.schema, 'ACCOUNTS')} VALUES (1, ${'Ada'}, 10.5)`,
        ],
      },
    ];
    const desired = defineSchema(migrated, [accountsTable]);
    expect(await migrationStatus(db, migrations, migrated)).toEqual({
      applied: [],
      pending: ['0001_accounts', '0002_seed'],
    });
    const result = await migrate(db, migrations, { ...migrated, verify: desired });
    expect(result.applied).toEqual(['0001_accounts', '0002_seed']);
    expect(result.drift).toEqual({ changes: [], unsupported: [] });
    expect((await migrate(db, migrations, migrated)).applied).toEqual([]);
    expect(await migrationStatus(db, migrations, migrated)).toEqual({
      applied: ['0001_accounts', '0002_seed'],
      pending: [],
    });

    await db.execute(insert(accounts, { id: 2n, name: 'Grace', balance: '3.25' }));
    const { rows } = await db.execute(
      select(accounts, { name: accounts.columns.name, balance: accounts.columns.balance }).where(
        eq(accounts.columns.id, 1n),
      ),
    );
    expect(rows).toEqual([{ name: 'Ada', balance: '10.50' }]);

    const observed = await inspectSchema(db, migrated);
    const table = observed.tables.find((entry) => entry.name === 'ACCOUNTS');
    expect(table?.comment).toBe("Customer's \\ accounts");
    expect(
      table?.columns.map((column) => [column.name, column.type, column.notNull, column.comment]),
    ).toEqual([
      ['ID', { kind: 'NUMBER', precision: 38, scale: 0 }, true, null],
      ['NAME', { kind: 'VARCHAR', length: 100 }, true, 'Display name'],
      ['BALANCE', { kind: 'NUMBER', precision: 18, scale: 2 }, true, null],
    ]);

    const edited = [migrations[0] as Migration, { id: '0002_seed', statements: [sql`SELECT 1`] }];
    await expect(migrate(db, edited, migrated)).rejects.toEqual(failed('HISTORY_DRIFT'));
    await expect(migrate(db, migrations.slice(1), migrated)).rejects.toEqual(
      failed('HISTORY_DRIFT'),
    );
  });

  it('stops on a failed statement and resumes after the committed ones', async () => {
    const base: Migration[] = [
      { id: '0001_accounts', statements: [createTable(accountsTable)] },
      {
        id: '0002_seed',
        statements: [
          sql`INSERT INTO ${sql.identifier(database, migrated.schema, 'ACCOUNTS')} VALUES (1, ${'Ada'}, 10.5)`,
        ],
      },
    ];
    const alter = alterTable(accounts);
    const broken: Migration = {
      id: '0003_columns',
      statements: [
        alter.addColumn('NOTE', sqlType.varchar()),
        // Fails: a NOT NULL column without a default cannot be added to a populated table.
        alter.addColumn('REGION', sqlType.varchar(), { notNull: true }),
        alter.addColumn('ACTIVE', sqlType.boolean()),
      ],
    };
    const error = await migrate(db, [...base, broken], migrated).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(MigrationError);
    expect(error).toMatchObject({ code: 'FAILED', migration: '0003_columns' });
    expect((error as Error).cause).toBeInstanceOf(Error);
    expect(await migrationStatus(db, [...base, broken], migrated)).toMatchObject({
      pending: [],
      incomplete: { id: '0003_columns', status: 'failed', appliedStatements: 1, statements: 3 },
    });
    await expect(migrate(db, [...base, broken], migrated)).rejects.toEqual(failed('FAILED'));

    const fixed: Migration = {
      ...broken,
      statements: [
        broken.statements[0],
        alter.addColumn('REGION', sqlType.varchar()),
        broken.statements[2],
      ] as Migration['statements'],
    };
    const changedPrefix: Migration = {
      ...fixed,
      statements: [alter.addColumn('OTHER', sqlType.varchar()), ...fixed.statements.slice(1)],
    };
    await expect(
      migrate(db, [...base, changedPrefix], { ...migrated, resumeFailed: true }),
    ).rejects.toEqual(failed('HISTORY_DRIFT'));
    // Re-running the first statement would fail because NOTE already exists.
    expect(
      (await migrate(db, [...base, fixed], { ...migrated, resumeFailed: true })).applied,
    ).toEqual(['0003_columns']);
    const columns = (await inspectSchema(db, migrated)).tables
      .find((entry) => entry.name === 'ACCOUNTS')
      ?.columns.map((column) => column.name);
    expect(columns).toEqual(['ID', 'NAME', 'BALANCE', 'NOTE', 'REGION', 'ACTIVE']);
    expect(await migrationStatus(db, [...base, fixed], migrated)).toEqual({
      applied: ['0001_accounts', '0002_seed', '0003_columns'],
      pending: [],
    });
  });

  it('refuses a held lease and takes over an expired one', async () => {
    const target = { ...migrated, historyTable: 'LEASE_HISTORY' };
    const lock = sql.identifier(database, migrated.schema, 'LEASE_HISTORY_LOCK');
    const table = snowflakeTable('LEASED', { id: integer('ID').notNull() }, migrated);
    const migrations: Migration[] = [
      { id: '0001_leased', statements: [createTable(defineTable(table))] },
    ];
    expect((await migrate(db, [], target)).applied).toEqual([]);
    await other.client.queryRaw(
      sql`UPDATE ${lock} SET OWNER = 'someone-else', EXPIRES_AT = DATEADD(MINUTE, 10, CURRENT_TIMESTAMP())`,
    );
    await expect(migrate(db, migrations, target)).rejects.toEqual(failed('LOCKED'));
    await other.client.queryRaw(
      sql`UPDATE ${lock} SET EXPIRES_AT = DATEADD(MINUTE, -1, CURRENT_TIMESTAMP())`,
    );
    expect((await migrate(db, migrations, target)).applied).toEqual(['0001_leased']);
    expect(await other.client.queryRaw(sql`SELECT OWNER, EXPIRES_AT FROM ${lock}`)).toEqual([
      { OWNER: null, EXPIRES_AT: null },
    ]);
  });

  it('serializes concurrent runs so each migration applies once', async () => {
    const target = { ...migrated, historyTable: 'CONCURRENT_HISTORY' };
    const table = snowflakeTable('COUNTER', { id: integer('ID').notNull() }, migrated);
    const migrations: Migration[] = [
      { id: '0001_counter', statements: [createTable(defineTable(table))] },
      {
        id: '0002_rows',
        statements: [
          sql`INSERT INTO ${sql.identifier(database, migrated.schema, 'COUNTER')} SELECT 1`,
        ],
      },
    ];
    const results = await Promise.allSettled([
      migrate(db, migrations, target),
      migrate(other.client, migrations, target),
    ]);
    for (const result of results)
      if (result.status === 'rejected') expect(result.reason).toEqual(failed('LOCKED'));
    expect(
      results.flatMap((result) => (result.status === 'fulfilled' ? result.value.applied : [])),
    ).toEqual(['0001_counter', '0002_rows']);
    expect(
      await db.queryRaw(
        sql`SELECT COUNT(*) AS N FROM ${sql.identifier(database, migrated.schema, 'COUNTER')}`,
      ),
    ).toEqual([{ N: '1' }]);
  });

  it('pushes diffs, gates destructive changes, and detects drift', async () => {
    const everything = snowflakeTable(
      'EVERYTHING',
      {
        id: integer('ID').notNull(),
        name: text('NAME'),
        amount: decimal('AMOUNT'),
        ratio: float('RATIO'),
        flag: boolean('FLAG'),
        day: date('DAY'),
        clock: time('CLOCK'),
        ntz: timestamp('NTZ'),
        ltz: timestamp('LTZ', 'ltz'),
        tz: timestamp('TZ', 'tz'),
        payload: variant('PAYLOAD'),
        list: variant('LIST'),
        map: variant('MAP'),
        data: binary('DATA'),
      },
      pushed,
    );
    const v1 = defineSchema({ ...pushed, comment: 'pushed schema' }, [
      defineTable(everything, {
        types: {
          amount: sqlType.number(12, 3),
          clock: sqlType.time(3),
          ltz: sqlType.timestamp('ltz', 6),
          list: sqlType.array(),
          map: sqlType.object(),
          data: sqlType.binary(16),
        },
      }),
    ]);
    const created = await pushSchema(db, v1);
    expect(created.changes.map((change) => change.description)).toEqual([
      `Create schema ${pushed.schema}`,
      'Create table EVERYTHING',
    ]);
    expect(await checkDrift(db, v1)).toEqual({ changes: [], unsupported: [] });

    const people = snowflakeTable(
      'EVERYTHING',
      { id: integer('ID').notNull(), name: text('NAME').notNull(), extra: integer('EXTRA') },
      pushed,
    );
    const v2 = defineSchema(pushed, [
      defineTable(people, {
        types: { name: sqlType.varchar() },
        comments: { id: 'key' },
        comment: 'v2',
      }),
    ]);
    await expect(pushSchema(db, v2)).rejects.toEqual(failed('DESTRUCTIVE'));
    // Raw insert: typed inserts of omitted VARIANT columns are tracked in #40.
    await db.queryRaw(
      sql`INSERT INTO ${sql.identifier(database, pushed.schema, 'EVERYTHING')} (ID, NAME) VALUES (1, 'kept')`,
    );
    const applied = await pushSchema(db, v2, { allowDestructive: true });
    expect(applied.changes.filter((change) => change.destructive)).toHaveLength(12);
    expect(await checkDrift(db, v2)).toEqual({ changes: [], unsupported: [] });
    expect((await db.execute(select(people))).rows).toEqual([
      { id: 1n, name: 'kept', extra: null },
    ]);

    await db.queryRaw(
      sql`ALTER TABLE ${sql.identifier(database, pushed.schema, 'EVERYTHING')} ADD COLUMN "MANUAL" NUMBER(10, 2)`,
    );
    await db.queryRaw(
      sql`CREATE TABLE ${sql.identifier(database, pushed.schema, 'STRAY')} (ID INT)`,
    );
    expect((await checkDrift(db, v2)).changes.map((change) => change.description)).toEqual([
      'Drop column EVERYTHING.MANUAL',
      'Drop table STRAY',
    ]);
    expect((await checkDrift(db, v2, { ignoreTables: ['STRAY'] })).changes).toHaveLength(1);

    const rescaled = snowflakeTable(
      'EVERYTHING',
      {
        id: integer('ID').notNull(),
        name: text('NAME').notNull(),
        extra: integer('EXTRA'),
        manual: decimal('MANUAL'),
      },
      pushed,
    );
    const v3 = defineSchema(pushed, [
      defineTable(rescaled, { types: { manual: sqlType.number(10, 4) } }),
    ]);
    await expect(pushSchema(db, v3, { allowDestructive: true })).rejects.toEqual(
      failed('UNSUPPORTED'),
    );
    const required = snowflakeTable(
      'EVERYTHING',
      {
        id: integer('ID').notNull(),
        name: text('NAME').notNull(),
        region: text('REGION').notNull(),
      },
      pushed,
    );
    await expect(
      pushSchema(db, defineSchema(pushed, [required]), { allowDestructive: true }),
    ).rejects.toMatchObject({
      code: 'UNSUPPORTED',
      message: expect.stringContaining('EVERYTHING.REGION'),
    });
    await db.queryRaw(
      sql.unsafe(dropTable(snowflakeTable('STRAY', { id: integer('ID') }, pushed)).compile().sql),
    );
    expect((await checkDrift(db, v2)).changes).toHaveLength(1);
  });

  it('round-trips declared types and server values, and adds only what Snowflake can add', async () => {
    const columns = {
      id: integer('ID').notNull().identity({ start: 5, increment: 2, order: true }),
      seq: integer('SEQ', { precision: 9 }).identity(),
      kind: text('KIND', { length: 10 }).notNull().serverDefault("'click'"),
      at: timestamp('AT', 'ltz').serverDefault('CURRENT_TIMESTAMP()'),
      label: text('LABEL').virtual('UPPER("KIND")'),
      note: text('NOTE'),
      amount: decimal('AMOUNT', { precision: 12, scale: 4 }),
      code: binary('CODE', { length: 8 }),
      clock: time('CLOCK', { precision: 0 }),
      seen: timestamp('SEEN', 'tz', { precision: 3 }),
      tags: array('TAGS'),
      attrs: object('ATTRS'),
      place: geography('PLACE'),
      shape: geometry('SHAPE', { srid: 4326 }),
      embedding: vector('EMBEDDING', 'float', 3),
      counts: vector('COUNTS', 'int', 2),
    };
    const events = snowflakeTable('EVENTS', columns, typed);
    const v1 = defineSchema(typed, [events]);
    expect((await pushSchema(db, v1)).changes).toHaveLength(2);
    expect(await checkDrift(db, v1)).toEqual({ changes: [], unsupported: [] });
    const table = sql.identifier(database, typed.schema, 'EVENTS');
    await db.queryRaw(sql`INSERT INTO ${table} (NOTE) VALUES ('first')`);
    expect(
      await db.queryRaw(sql`SELECT ID, SEQ, KIND, LABEL, AT IS NOT NULL AS STAMPED FROM ${table}`),
    ).toEqual([{ ID: '5', SEQ: '1', KIND: 'click', LABEL: 'CLICK', STAMPED: true }]);
    expect(await checkDrift(db, v1)).toEqual({ changes: [], unsupported: [] });

    const observed = (await inspectSchema(db, typed)).tables[0]?.columns;
    expect(observed?.map((column) => [column.name, column.type])).toEqual([
      ['ID', sqlType.number()],
      ['SEQ', sqlType.number(9, 0)],
      ['KIND', sqlType.varchar(10)],
      ['AT', sqlType.timestamp('ltz')],
      ['LABEL', sqlType.varchar(16_777_216)],
      ['NOTE', sqlType.varchar(16_777_216)],
      ['AMOUNT', sqlType.number(12, 4)],
      ['CODE', sqlType.binary()],
      ['CLOCK', sqlType.time(0)],
      ['SEEN', sqlType.timestamp('tz', 3)],
      ['TAGS', sqlType.array()],
      ['ATTRS', sqlType.object()],
      ['PLACE', sqlType.geography()],
      ['SHAPE', sqlType.geometry()],
      ['EMBEDDING', sqlType.vector('float', 3)],
      ['COUNTS', sqlType.vector('int', 2)],
    ]);
    expect(observed?.slice(0, 6).map((column) => column.serverValue)).toEqual([
      { kind: 'identity', start: 5, increment: 2, order: true },
      expect.objectContaining({ kind: 'identity', start: 1, increment: 1 }),
      { kind: 'default', expression: "'click'" },
      { kind: 'default', expression: 'CURRENT_TIMESTAMP()' },
      { kind: 'virtual', expression: expect.stringContaining('UPPER') },
      null,
    ]);

    const added = defineSchema(typed, [
      snowflakeTable(
        'EVENTS',
        {
          ...columns,
          source: text('SOURCE').notNull().serverDefault("'web'"),
          shout: text('SHOUT').virtual('UPPER("SOURCE")'),
        },
        typed,
      ),
    ]);
    expect((await pushSchema(db, added)).changes.map((change) => change.description)).toEqual([
      'Add column EVENTS.SOURCE',
      'Add column EVENTS.SHOUT',
    ]);
    expect(await checkDrift(db, added)).toEqual({ changes: [], unsupported: [] });
    expect(await db.queryRaw(sql`SELECT SOURCE, SHOUT FROM ${table}`)).toEqual([
      { SOURCE: 'web', SHOUT: 'WEB' },
    ]);

    const refused = defineSchema(typed, [
      snowflakeTable(
        'EVENTS',
        {
          ...columns,
          kind: text('KIND', { length: 10 }).virtual("'click'"),
          note: text('NOTE').serverDefault("'n'"),
          started: timestamp('STARTED', 'ltz').serverDefault('CURRENT_TIMESTAMP()'),
          serial: integer('SERIAL').identity(),
        },
        typed,
      ),
    ]);
    expect((await checkDrift(db, refused)).unsupported).toEqual([
      expect.objectContaining({ column: 'KIND', reason: expect.stringContaining('DEFAULT') }),
      expect.objectContaining({
        column: 'NOTE',
        reason: expect.stringContaining('no server value'),
      }),
      expect.objectContaining({ column: 'STARTED', reason: expect.stringContaining('constant') }),
      expect.objectContaining({ column: 'SERIAL', reason: expect.stringContaining('identity') }),
    ]);
    const alter = alterTable(events);
    for (const statement of [
      alter.addColumn('STARTED', sqlType.timestamp('ltz'), {
        serverValue: { kind: 'default', expression: 'CURRENT_TIMESTAMP()' },
      }),
      alter.addColumn('SERIAL', sqlType.number(), { serverValue: { kind: 'identity' } }),
    ])
      await expect(db.queryRaw(sql.unsafe(statement.compile().sql))).rejects.toThrow();
    await db.queryRaw(sql.unsafe(alter.dropDefault('KIND').compile().sql));
    expect((await inspectSchema(db, typed)).tables[0]?.columns[2]?.serverValue).toBeNull();
  });
});
