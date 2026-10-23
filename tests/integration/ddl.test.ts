import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  alterTable,
  checkDrift,
  createSchema,
  createTable,
  type DdlStatement,
  defineSchema,
  defineTable,
  dropSchema,
  dropTable,
  inspectSchema,
  pushSchema,
  setSchemaComment,
  sqlType,
} from '../../src/ddl/index.js';
import {
  array,
  binary,
  boolean,
  date,
  decimal,
  float,
  geography,
  geometry,
  identifier,
  integer,
  object,
  select,
  snowflakeTable,
  sql,
  structuredType as st,
  structured,
  text,
  time,
  timestamp,
  variant,
  vector,
} from '../../src/index.js';
import { createFixture, integrationConfig } from '../support/snowflake.js';

describe('DDL builders and schema diffs against Snowflake', () => {
  const fixture = createFixture(integrationConfig());
  const db = fixture.client;
  const database = fixture.table.node.parts[0] as string;
  // Derived from the fixture's unique name, so cleanup only targets schemas this file created.
  const pushed = { database, schema: `${fixture.schemaName}_PUSHED` };
  const typed = { database, schema: `${fixture.schemaName}_TYPED` };
  const shaped = { database, schema: `${fixture.schemaName}_SHAPED` };
  const altered = { database, schema: `${fixture.schemaName}_ALTERED` };
  const defaulted = { database, schema: `${fixture.schemaName}_DEFAULTED` };
  const failed = (code: string) => expect.objectContaining({ name: 'MigrationError', code });

  beforeAll(() => fixture.seed());
  afterAll(async () => {
    try {
      for (const target of [pushed, typed, shaped, altered, defaulted])
        await db.queryRaw(
          sql`DROP SCHEMA IF EXISTS ${sql.identifier(target.database, target.schema)} CASCADE`,
        );
    } finally {
      await fixture.cleanup();
    }
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
          source: text('SOURCE').notNull().serverDefault("'app'"),
          nulled: text('NULLED').notNull().serverDefault('NULL'),
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
      expect.objectContaining({
        column: 'SOURCE',
        reason: "Cannot change the DEFAULT from 'web' to 'app' in place.",
      }),
      expect.objectContaining({ column: 'NULLED', reason: expect.stringContaining('NOT NULL') }),
    ]);
    const alter = alterTable(events);
    for (const statement of [
      alter.addColumn('STARTED', sqlType.timestamp('ltz'), {
        serverValue: { kind: 'default', expression: 'CURRENT_TIMESTAMP()' },
      }),
      alter.addColumn('SERIAL', sqlType.number(), { serverValue: { kind: 'identity' } }),
      alter.addColumn('NULLED', sqlType.varchar(), {
        notNull: true,
        serverValue: { kind: 'default', expression: 'NULL' },
      }),
    ])
      await expect(db.queryRaw(sql.unsafe(statement.compile().sql))).rejects.toThrow();
    await db.queryRaw(sql.unsafe(alter.dropDefault('KIND').compile().sql));
    expect((await inspectSchema(db, typed)).tables[0]?.columns[2]?.serverValue).toBeNull();
  });

  it('maps structured columns and reads them back after a hand-written ALTER', async () => {
    const profile = (extra: boolean) =>
      st.object({
        Name: st.text({ length: 20 }),
        score: st.decimal({ precision: 10, scale: 2 }),
        ...(extra ? { active: st.boolean() } : {}),
      });
    const shapes = (extra: boolean) =>
      snowflakeTable(
        'SHAPES',
        {
          id: integer('ID').notNull(),
          counts: structured('COUNTS', st.array(st.integer())),
          profile: structured('PROFILE', profile(extra)),
          flags: structured('FLAGS', st.map(st.text(), st.array(st.boolean()))),
          ids: structured('IDS', st.map(st.integer({ precision: 9 }), st.text())),
          first: structured('FIRST', st.array(st.integer())).virtual('[1]::ARRAY(NUMBER(38,0))'),
        },
        shaped,
      );
    const current = shapes(false);
    const v1 = defineSchema(shaped, [current]);
    await pushSchema(db, v1);
    expect(await checkDrift(db, v1)).toEqual({ changes: [], unsupported: [] });
    const table = sql.identifier(database, shaped.schema, 'SHAPES');
    await db.queryRaw(
      sql`INSERT INTO ${table} (ID, COUNTS) SELECT 1, ARRAY_CONSTRUCT(1, 2)::ARRAY(NUMBER(38,0))`,
    );
    expect(
      (
        await db.execute(
          select(current, { counts: current.columns.counts, first: current.columns.first }),
        )
      ).rows,
    ).toEqual([{ counts: [1n, 2n], first: [1n] }]);

    await db.queryRaw(
      sql`ALTER TABLE ${table} ALTER COLUMN "PROFILE" SET DATA TYPE ${sql.unsafe(profile(true).sql)}`,
    );
    const v2 = defineSchema(shaped, [shapes(true)]);
    expect(await checkDrift(db, v2)).toEqual({ changes: [], unsupported: [] });
    expect((await checkDrift(db, v1)).unsupported).toEqual([
      {
        table: 'SHAPES',
        column: 'PROFILE',
        reason:
          'Cannot change OBJECT("Name" VARCHAR(20), "score" NUMBER(10,2), "active" BOOLEAN) to OBJECT("Name" VARCHAR(20), "score" NUMBER(10,2)) in place.',
      },
    ]);
  });

  it('runs each schema and ALTER TABLE builder in place', async () => {
    const run = (statement: DdlStatement) => db.queryRaw(sql.unsafe(statement.compile().sql));
    const schema = identifier(database, altered.schema);
    await run(createSchema(schema, { ifNotExists: true, comment: 'first' }));
    await run(createSchema(schema, { ifNotExists: true }));
    await run(setSchemaComment(schema, "it's \\ second"));
    expect((await inspectSchema(db, altered)).comment).toBe("it's \\ second");
    const items = snowflakeTable(
      'ITEMS',
      {
        id: integer('ID'),
        name: text('NAME', { length: 10 }).notNull(),
        price: decimal('PRICE', { precision: 8, scale: 2 }),
      },
      altered,
    );
    await run(createTable(defineTable(items, { comment: 'items', comments: { name: 'n' } })));
    await db.queryRaw(
      sql`INSERT INTO ${sql.identifier(database, altered.schema, 'ITEMS')} VALUES (1, 'a', 1.25)`,
    );
    const alter = alterTable(items);
    for (const statement of [
      alter.setColumnType('NAME', sqlType.varchar(40)),
      alter.setColumnType('PRICE', sqlType.number(12, 2)),
      alter.setNotNull('ID'),
      alter.dropNotNull('NAME'),
      alter.setColumnComment('ID', 'key'),
      alter.setColumnComment('NAME', null),
      alter.setComment(null),
      alter.addColumn('NOTE', sqlType.varchar()),
      alter.renameColumn('NOTE', 'REMARK'),
      alter.dropColumn('REMARK'),
      alter.renameTo('PRODUCTS'),
    ])
      await run(statement);
    const [table] = (await inspectSchema(db, altered)).tables;
    expect(table).toEqual({
      name: 'PRODUCTS',
      comment: null,
      columns: [
        { name: 'ID', type: sqlType.number(), notNull: true, comment: 'key', serverValue: null },
        {
          name: 'NAME',
          type: sqlType.varchar(40),
          notNull: false,
          comment: null,
          serverValue: null,
        },
        {
          name: 'PRICE',
          type: sqlType.number(12, 2),
          notNull: false,
          comment: null,
          serverValue: null,
        },
      ],
    });
    const products = sql.identifier(database, altered.schema, 'PRODUCTS');
    expect(await db.queryRaw(sql`SELECT ID, NAME, PRICE FROM ${products}`)).toEqual([
      { ID: '1', NAME: 'a', PRICE: '1.25' },
    ]);
    await run(dropTable(identifier(database, altered.schema, 'PRODUCTS'), { ifExists: true }));
    await run(dropTable(identifier(database, altered.schema, 'PRODUCTS'), { ifExists: true }));
    await run(createTable(defineTable(items)));
    // RESTRICT only refuses when other schemas reference this one's keys, so a non-empty schema drops.
    await run(dropSchema(schema));
    expect((await inspectSchema(db, altered)).exists).toBe(false);
    await run(createSchema(schema));
    await run(createTable(defineTable(items)));
    await run(dropSchema(schema, { cascade: true }));
    await run(dropSchema(schema, { ifExists: true }));
    expect((await inspectSchema(db, altered)).exists).toBe(false);
  });

  it('reports no drift for defaults Snowflake normalizes, and catches changed constants', async () => {
    const columns = (amount: string) => ({
      amount: decimal('AMOUNT', { precision: 10, scale: 2 }).serverDefault(amount),
      padded: integer('PADDED').serverDefault('05'),
      whole: integer('WHOLE').serverDefault('5.0'),
      zero: integer('ZERO').serverDefault('-0'),
      big: float('BIG').serverDefault('1e3'),
      bigger: float('BIGGER').serverDefault('1.0E+3'),
      flag: boolean('FLAG').serverDefault('true'),
      quote: text('QUOTE').serverDefault("'a''b'"),
      spaced: text('SPACED').serverDefault(" 'x' "),
      slash: text('SLASH').serverDefault("'back\\\\slash'"),
      escaped: text('ESCAPED').serverDefault("'back\\slash\\t'"),
      nothing: text('NOTHING').serverDefault('null'),
    });
    const v1 = defineSchema(defaulted, [snowflakeTable('DEFAULTS', columns('1.50'), defaulted)]);
    await pushSchema(db, v1);
    expect(await checkDrift(db, v1)).toEqual({ changes: [], unsupported: [] });
    expect((await pushSchema(db, v1)).changes).toEqual([]);
    const table = sql.identifier(database, defaulted.schema, 'DEFAULTS');
    await db.queryRaw(sql`INSERT INTO ${table} (PADDED) VALUES (DEFAULT)`);
    expect(
      await db.queryRaw(sql`SELECT AMOUNT, BIG, QUOTE, SLASH, ESCAPED, NOTHING FROM ${table}`),
    ).toEqual([
      {
        AMOUNT: '1.50',
        BIG: '1000',
        QUOTE: "a'b",
        SLASH: 'back\\slash',
        ESCAPED: 'backslash\t',
        NOTHING: null,
      },
    ]);
    const v2 = defineSchema(defaulted, [snowflakeTable('DEFAULTS', columns('2.5'), defaulted)]);
    expect((await checkDrift(db, v2)).unsupported).toEqual([
      {
        table: 'DEFAULTS',
        column: 'AMOUNT',
        reason: 'Cannot change the DEFAULT from 1.5 to 2.5 in place.',
      },
    ]);
  });
});
