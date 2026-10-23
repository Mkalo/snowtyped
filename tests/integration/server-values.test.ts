import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as z from 'zod';
import {
  asc,
  eq,
  generateSchema,
  insert,
  integer,
  introspect,
  mergeInto,
  select,
  snowflakeTable,
  sql,
  text,
  timestamp,
  update,
  variant,
} from '../../src/index.js';
import { createFixture, integrationConfig } from '../support/snowflake.js';

describe('server defaults, identity, and virtual columns against Snowflake', () => {
  const fixture = createFixture(integrationConfig());
  const db = fixture.client;
  const database = fixture.table.node.parts[0] as string;
  const namespace = { database, schema: fixture.schemaName };
  const items = snowflakeTable(
    'ITEMS',
    {
      id: integer('ID').notNull().identity({ start: 10, increment: 5, order: true }),
      name: text('NAME').notNull(),
      status: text('STATUS').notNull().serverDefault("'new'"),
      note: text('NOTE').serverDefault("'none'"),
      payload: variant('PAYLOAD', z.object({ x: z.number() })),
      doubled: integer('DOUBLED').virtual('ID * 2'),
    },
    namespace,
  );
  const counters = snowflakeTable(
    'COUNTERS',
    {
      id: integer('ID').identity(),
      at: timestamp('AT_VALUE').notNull().serverDefault('CURRENT_TIMESTAMP()'),
    },
    namespace,
  );
  const staged = snowflakeTable('STAGED_ITEMS', { name: text('NAME').notNull() }, namespace);
  const name = (table: { node: { parts: readonly string[] } }) =>
    sql.identifier(...(table.node.parts as [string, ...string[]]));
  const rows = async () =>
    (await db.execute(select(items).orderBy(asc(items.columns.id)))).rows.map(
      ({ id: _, ...row }) => row,
    );

  beforeAll(async () => {
    await fixture.seed();
    await db.queryRaw(sql`CREATE TABLE ${name(items)} (
      ID NUMBER(38,0) NOT NULL AUTOINCREMENT START 10 INCREMENT 5 ORDER,
      NAME VARCHAR NOT NULL,
      STATUS VARCHAR NOT NULL DEFAULT 'new',
      NOTE VARCHAR DEFAULT 'none',
      PAYLOAD VARIANT,
      DOUBLED NUMBER(38,0) AS (ID * 2)
    )`);
    await db.queryRaw(sql`CREATE TABLE ${name(counters)} (
      ID NUMBER(38,0) IDENTITY,
      AT_VALUE TIMESTAMP_NTZ NOT NULL DEFAULT CURRENT_TIMESTAMP()
    )`);
    await db.queryRaw(sql`CREATE TABLE ${name(staged)} (NAME VARCHAR NOT NULL)`);
  });
  afterAll(() => fixture.cleanup());

  it('applies server defaults to omitted columns and keeps explicit NULL', async () => {
    expect((await db.execute(insert(items, { name: 'omitted' }))).affectedRows).toBe(1);
    await db.execute(insert(items, { name: 'explicit', note: null }));
    expect(
      (await db.execute(select(items).orderBy(asc(items.columns.id)))).rows.map(
        ({ id, name, status, note, doubled }) => ({ id, name, status, note, doubled }),
      ),
    ).toEqual([
      { id: 10n, name: 'omitted', status: 'new', note: 'none', doubled: 20n },
      { id: 15n, name: 'explicit', status: 'new', note: null, doubled: 30n },
    ]);
  });

  it('inserts mixed row shapes in one atomic statement with per-row defaults', async () => {
    const result = await db.execute(
      insert(items, [
        { name: 'json', payload: { x: 1 } },
        { name: 'status', status: 'done' },
        { name: 'both', status: 'done', note: 'kept' },
      ]),
    );
    expect(result.affectedRows).toBe(3);
    const inserted = (await rows()).slice(2);
    expect(inserted).toEqual(
      expect.arrayContaining([
        {
          name: 'json',
          status: 'new',
          note: 'none',
          payload: { x: 1 },
          doubled: expect.any(BigInt),
        },
        {
          name: 'status',
          status: 'done',
          note: 'none',
          payload: null,
          doubled: expect.any(BigInt),
        },
        { name: 'both', status: 'done', note: 'kept', payload: null, doubled: expect.any(BigInt) },
      ]),
    );
    const ids = (await db.execute(select(items, { id: items.columns.id }))).rows.map(
      (row) => row.id,
    );
    expect(new Set(ids).size).toBe(5);
    expect(() =>
      insert(items, [
        { name: 'bad', status: 'x' },
        { name: 'bad', status: null },
      ] as never),
    ).toThrow();
    const loose = snowflakeTable(
      'ITEMS',
      { name: text('NAME'), status: text('STATUS') },
      namespace,
    );
    await expect(
      db.execute(insert(loose, [{ name: 'partial', status: 'x' }, { name: null }])),
    ).rejects.toThrow(/NULL result in a non-nullable column/);
    expect((await rows()).filter((row) => row.name === 'partial')).toEqual([]);
  });

  it('inserts rows made entirely of server-populated values', async () => {
    expect((await db.execute(insert(counters, [{}, {}, {}]))).affectedRows).toBe(3);
    const values = (await db.execute(select(counters).orderBy(asc(counters.columns.id)))).rows;
    expect(values.map((row) => row.id)).toEqual([1n, 2n, 3n]);
    expect(values.every((row) => row.at.length > 0)).toBe(true);
  });

  it('rejects virtual column writes locally and matches Snowflake target rules', async () => {
    expect(() => insert(items, { name: 'v', doubled: 1n } as never)).toThrow('virtual column');
    expect(() => update(items, { doubled: 1n } as never)).toThrow('virtual column');
    await expect(
      db.queryRaw(sql`INSERT INTO ${name(items)} (NAME, DOUBLED) SELECT 'v', 1`),
    ).rejects.toThrow(/Virtual column/i);
    await db.execute(update(items, { id: 1000n }).where(eq(items.columns.name, 'omitted')));
    expect(
      (
        await db.execute(
          select(items, { doubled: items.columns.doubled }).where(
            eq(items.columns.name, 'omitted'),
          ),
        )
      ).rows,
    ).toEqual([{ doubled: 2000n }]);
  });

  it('uses server defaults for columns omitted by MERGE inserts', async () => {
    await db.execute(insert(staged, { name: 'merged' }));
    await db.execute(
      mergeInto(items, staged, eq(items.columns.name, staged.columns.name)).whenNotMatchedInsert({
        name: staged.columns.name,
      }),
    );
    expect(
      (
        await db.execute(
          select(items, { status: items.columns.status, note: items.columns.note }).where(
            eq(items.columns.name, 'merged'),
          ),
        )
      ).rows,
    ).toEqual([{ status: 'new', note: 'none' }]);
  });

  it('introspects server values and generates matching declarations', async () => {
    const tables = await introspect(db, namespace);
    const table = tables.find((entry) => entry.name === 'ITEMS');
    expect(table?.columns.map((column) => column.serverValue)).toEqual([
      { kind: 'identity', start: 10, increment: 5, order: true },
      null,
      { kind: 'default', expression: "'new'" },
      { kind: 'default', expression: "'none'" },
      null,
      { kind: 'virtual', expression: 'ID * 2' },
    ]);
    const code = generateSchema(tables);
    expect(code).toContain(
      '"ID": integer("ID").notNull().identity({ start: 10, increment: 5, order: true }),',
    );
    expect(code).toContain('"STATUS": text("STATUS").notNull().serverDefault("\'new\'"),');
    expect(code).toContain('"DOUBLED": integer("DOUBLED").virtual("ID * 2"),');
    expect(code).toContain(
      '"AT_VALUE": timestamp("AT_VALUE", "ntz").notNull().serverDefault("CURRENT_TIMESTAMP()"),',
    );
  });
});
