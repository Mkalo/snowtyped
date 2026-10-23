import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  alias,
  asc,
  count,
  deleteFrom,
  eq,
  gt,
  insert,
  integer,
  like,
  mergeInto,
  select,
  snowflakeTable,
  sql,
  text,
  update,
  upper,
} from '../../src/index.js';
import { createFixture, integrationConfig, tableIdentifier } from '../support/snowflake.js';

const INJECTIONS = [
  "Robert'); DROP TABLE CUSTOMERS; --",
  'quote " and \\" backslash \\',
  '? :1 $1 %s {0}',
  '/* comment */ -- trailing',
  '$$ dollar quoted $$',
  "'' OR ''1''=''1",
];

describe('writes against Snowflake', () => {
  const fixture = createFixture(integrationConfig());
  const db = fixture.client;
  const namespace = { database: fixture.table.node.parts[0] as string, schema: fixture.schemaName };
  const items = snowflakeTable(
    'Mixed "Case" Items',
    {
      lowerId: integer('id').notNull(),
      upperId: text('ID'),
      display: text('Display Name').notNull(),
      quantity: integer('qty'),
      note: text('note'),
    },
    namespace,
  );
  const i = items.columns;
  const staged = snowflakeTable(
    'staged',
    { key: integer('key').notNull(), label: text('label').notNull() },
    namespace,
  );
  const limited = snowflakeTable(
    'LIMITED',
    { code: text('CODE').notNull(), small: integer('SMALL') },
    namespace,
  );
  const contents = async () =>
    (await db.execute(select(items).orderBy(asc(i.lowerId)))).rows.map((row) => ({ ...row }));

  beforeAll(async () => {
    await fixture.seed();
    await db.queryRaw(
      sql`CREATE TABLE ${tableIdentifier(items)} (${sql.identifier('id')} NUMBER(38,0) NOT NULL, ${sql.identifier('ID')} VARCHAR, ${sql.identifier('Display Name')} VARCHAR NOT NULL, ${sql.identifier('qty')} NUMBER(38,0), ${sql.identifier('note')} VARCHAR)`,
    );
    await db.queryRaw(
      sql`CREATE TABLE ${tableIdentifier(staged)} (${sql.identifier('key')} NUMBER(38,0) NOT NULL, ${sql.identifier('label')} VARCHAR NOT NULL)`,
    );
    await db.queryRaw(
      sql`CREATE TABLE ${tableIdentifier(limited)} (CODE VARCHAR(5) NOT NULL, SMALL NUMBER(3,0))`,
    );
  });
  beforeEach(async () => {
    await db.execute(deleteFrom(items));
    await db.execute(deleteFrom(staged));
    await db.execute(deleteFrom(limited));
  });
  afterAll(() => fixture.cleanup());

  it('inserts single and multiple rows into case-sensitive identifiers', async () => {
    expect(
      await db.execute(insert(items, { lowerId: 1n, upperId: 'upper', display: 'One' })),
    ).toMatchObject({ affectedRows: 1, queryId: expect.any(String) });
    expect(
      await db.execute(
        insert(items, [
          { lowerId: 2n, display: 'Two', quantity: 9007199254740993n, note: 'n' },
          { lowerId: 3n, display: 'Three', note: null },
          { lowerId: 4n, display: 'Four', quantity: -1n },
        ]),
      ),
    ).toMatchObject({ affectedRows: 3 });
    expect(await contents()).toEqual([
      { lowerId: 1n, upperId: 'upper', display: 'One', quantity: null, note: null },
      { lowerId: 2n, upperId: null, display: 'Two', quantity: 9007199254740993n, note: 'n' },
      { lowerId: 3n, upperId: null, display: 'Three', quantity: null, note: null },
      { lowerId: 4n, upperId: null, display: 'Four', quantity: -1n, note: null },
    ]);
  });

  it('stores and matches injection-like values as data', async () => {
    await db.execute(
      insert(
        items,
        INJECTIONS.map((display, index) => ({ lowerId: BigInt(index), display, note: display })),
      ),
    );
    expect((await contents()).map((row) => [row.display, row.note])).toEqual(
      INJECTIONS.map((value) => [value, value]),
    );
    for (const [index, value] of INJECTIONS.entries()) {
      const found = await db.execute(select(items, { id: i.lowerId }).where(eq(i.display, value)));
      expect(found.rows).toEqual([{ id: BigInt(index) }]);
    }
    expect(
      (await db.execute(select(items, { id: i.lowerId }).where(like(i.display, "Robert'); DROP%"))))
        .rows,
    ).toEqual([{ id: 0n }]);
    expect((await db.execute(select(fixture.table, { n: count() }))).rows).toEqual([{ n: 3n }]);
  });

  it('updates with literals, NULL, and same-table expressions and reports affected rows', async () => {
    await db.execute(
      insert(items, [
        { lowerId: 1n, display: 'one', note: 'keep' },
        { lowerId: 2n, display: 'two', note: 'keep' },
        { lowerId: 3n, display: 'three', note: 'keep' },
      ]),
    );
    expect(
      await db.execute(update(items, { quantity: 5n, note: null }).where(gt(i.lowerId, 1n))),
    ).toMatchObject({ affectedRows: 2 });
    expect(
      await db.execute(update(items, { note: upper(i.display) }).where(eq(i.lowerId, 3n))),
    ).toMatchObject({ affectedRows: 1 });
    expect(
      await db.execute(update(items, { note: 'none' }).where(eq(i.lowerId, 404n))),
    ).toMatchObject({ affectedRows: 0 });
    expect(await contents()).toEqual([
      { lowerId: 1n, upperId: null, display: 'one', quantity: null, note: 'keep' },
      { lowerId: 2n, upperId: null, display: 'two', quantity: 5n, note: null },
      { lowerId: 3n, upperId: null, display: 'three', quantity: 5n, note: 'THREE' },
    ]);
    expect(await db.execute(update(items, { upperId: 'all' }))).toMatchObject({ affectedRows: 3 });
    expect((await contents()).every((row) => row.upperId === 'all')).toBe(true);
  });

  it('deletes filtered, unmatched, and all rows', async () => {
    await db.execute(
      insert(items, [
        { lowerId: 1n, display: 'a' },
        { lowerId: 2n, display: 'b' },
        { lowerId: 3n, display: 'c' },
      ]),
    );
    expect(await db.execute(deleteFrom(items).where(eq(i.display, 'b')))).toMatchObject({
      affectedRows: 1,
    });
    expect(await db.execute(deleteFrom(items).where(eq(i.lowerId, 404n)))).toMatchObject({
      affectedRows: 0,
    });
    expect((await contents()).map((row) => row.lowerId)).toEqual([1n, 3n]);
    expect(await db.execute(deleteFrom(items))).toMatchObject({ affectedRows: 2 });
    expect(await contents()).toEqual([]);
  });

  it('merges matched updates and unmatched inserts from a table source', async () => {
    await db.execute(insert(items, { lowerId: 1n, display: 'old', note: 'kept' }));
    await db.execute(
      insert(staged, [
        { key: 1n, label: 'updated' },
        { key: 2n, label: 'inserted' },
      ]),
    );
    const merge = mergeInto(items, staged, eq(i.lowerId, staged.columns.key))
      .whenMatchedUpdate({ display: staged.columns.label, quantity: 10n })
      .whenNotMatchedInsert({ lowerId: staged.columns.key, display: staged.columns.label });
    expect(await db.execute(merge)).toMatchObject({ affectedRows: 2 });
    expect(await contents()).toEqual([
      { lowerId: 1n, upperId: null, display: 'updated', quantity: 10n, note: 'kept' },
      { lowerId: 2n, upperId: null, display: 'inserted', quantity: null, note: null },
    ]);
    expect(await db.execute(merge)).toMatchObject({ affectedRows: 2 });
    expect(await contents()).toHaveLength(2);
  });

  it('merges matched deletes from aliased and derived sources', async () => {
    await db.execute(
      insert(items, [
        { lowerId: 1n, display: 'one' },
        { lowerId: 2n, display: 'two' },
      ]),
    );
    await db.execute(
      insert(staged, [
        { key: 2n, label: 'remove' },
        { key: 3n, label: 'add' },
      ]),
    );
    const source = alias(staged, 's');
    expect(
      await db.execute(
        mergeInto(items, source, eq(i.lowerId, source.columns.key))
          .whenMatchedDelete()
          .whenNotMatchedInsert({ lowerId: source.columns.key, display: source.columns.label }),
      ),
    ).toMatchObject({ affectedRows: 2 });
    expect((await contents()).map((row) => [row.lowerId, row.display])).toEqual([
      [1n, 'one'],
      [3n, 'add'],
    ]);
    const derived = select(staged, { key: staged.columns.key, label: upper(staged.columns.label) })
      .where(eq(staged.columns.key, 3n))
      .as('derived source');
    expect(
      await db.execute(
        mergeInto(items, derived, eq(i.lowerId, derived.columns.key)).whenMatchedUpdate({
          note: derived.columns.label,
        }),
      ),
    ).toMatchObject({ affectedRows: 1 });
    expect((await contents()).find((row) => row.lowerId === 3n)?.note).toBe('ADD');
    expect(
      await db.execute(
        mergeInto(items, derived, eq(i.lowerId, 404n)).whenMatchedUpdate({ note: 'never' }),
      ),
    ).toMatchObject({ affectedRows: 0 });
  });

  it('rejects server constraint violations without partial writes', async () => {
    await db.execute(insert(limited, { code: 'ok', small: 1n }));
    await expect(
      db.execute(
        insert(limited, [
          { code: 'fits', small: 2n },
          { code: 'too long', small: 3n },
        ]),
      ),
    ).rejects.toThrow();
    await expect(db.execute(insert(limited, { code: 'big', small: 1000n }))).rejects.toThrow();
    await expect(
      db.execute(update(limited, { small: 1000n }).where(eq(limited.columns.code, 'ok'))),
    ).rejects.toThrow();
    const loose = snowflakeTable(
      'LIMITED',
      { code: text('CODE'), small: integer('SMALL') },
      namespace,
    );
    await expect(db.execute(insert(loose, { small: 4n }))).rejects.toThrow();
    expect((await db.execute(select(limited))).rows).toEqual([{ code: 'ok', small: 1n }]);
  });

  it('rejects a nondeterministic MERGE that matches one target row twice', async () => {
    await db.execute(insert(items, { lowerId: 1n, display: 'target' }));
    await db.execute(
      insert(staged, [
        { key: 1n, label: 'first' },
        { key: 1n, label: 'second' },
      ]),
    );
    await expect(
      db.execute(
        mergeInto(items, staged, eq(i.lowerId, staged.columns.key)).whenMatchedUpdate({
          display: staged.columns.label,
        }),
      ),
    ).rejects.toThrow();
    expect((await contents()).map((row) => row.display)).toEqual(['target']);
  });
});
