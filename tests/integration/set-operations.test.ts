import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as z from 'zod';
import {
  asc,
  count,
  decimal,
  desc,
  eq,
  insert,
  integer,
  select,
  snowflakeTable,
  sql,
  text,
  timestamp,
  variant,
} from '../../src/index.js';
import { createFixture, integrationConfig } from '../support/snowflake.js';

describe('typed set operations against Snowflake', () => {
  const fixture = createFixture(integrationConfig());
  const db = fixture.client;
  const namespace = { database: fixture.table.node.parts[0] as string, schema: fixture.schemaName };
  const current = snowflakeTable(
    'CURRENT_ROWS',
    {
      id: integer('ID').notNull(),
      name: text('NAME'),
      amount: decimal('AMOUNT').notNull(),
      at: timestamp('AT_VALUE').notNull(),
      payload: variant('PAYLOAD', z.object({ ok: z.boolean() })).notNull(),
    },
    namespace,
  );
  const archived = snowflakeTable(
    'ARCHIVED_ROWS',
    {
      id: integer('ID').notNull(),
      name: text('NAME'),
      amount: decimal('AMOUNT'),
      at: timestamp('AT_VALUE').notNull(),
      payload: variant('PAYLOAD'),
    },
    namespace,
  );
  const name = (table: { node: { parts: readonly string[] } }) =>
    sql.identifier(...(table.node.parts as [string, ...string[]]));
  const currentKeys = select(current, { id: current.columns.id, name: current.columns.name });
  const archivedKeys = select(archived, { name: archived.columns.name, id: archived.columns.id });

  beforeAll(async () => {
    await fixture.seed();
    await db.queryRaw(
      sql`CREATE TABLE ${name(current)} (ID NUMBER(10,0) NOT NULL, NAME VARCHAR, AMOUNT NUMBER(10,2) NOT NULL, AT_VALUE TIMESTAMP_NTZ(9) NOT NULL, PAYLOAD VARIANT NOT NULL)`,
    );
    await db.queryRaw(
      sql`CREATE TABLE ${name(archived)} (ID NUMBER(38,0) NOT NULL, NAME VARCHAR, AMOUNT NUMBER(12,4), AT_VALUE TIMESTAMP_NTZ(0) NOT NULL, PAYLOAD VARIANT)`,
    );
    await db.execute(
      insert(current, [
        {
          id: 1n,
          name: 'Ada',
          amount: '1.50',
          at: '2026-01-01 10:00:00.123456789',
          payload: { ok: true },
        },
        { id: 2n, name: null, amount: '2.25', at: '2026-01-02 00:00:00', payload: { ok: false } },
        { id: 2n, name: null, amount: '2.25', at: '2026-01-02 00:00:00', payload: { ok: false } },
      ]),
    );
    for (const row of [
      { id: 2n, name: null, amount: '2.25', at: '2026-01-02 00:00:00', payload: { ok: false } },
      {
        id: 9007199254740993n,
        name: 'Grace',
        amount: '3.1234',
        at: '2026-01-04 00:00:00',
        payload: [1, 2],
      },
    ])
      await db.execute(insert(archived, row));
    await db.queryRaw(
      sql`INSERT INTO ${name(archived)} SELECT 10, 'Linus', NULL, '2026-01-03 00:00:00', NULL`,
    );
  });
  afterAll(() => fixture.cleanup());

  it('keeps or removes duplicates and orders combined integers natively', async () => {
    const all = currentKeys.unionAll(archivedKeys);
    expect((await db.execute(all.orderBy(asc(all.columns.id)))).rows.map((row) => row.id)).toEqual([
      1n,
      2n,
      2n,
      2n,
      10n,
      9007199254740993n,
    ]);
    const distinct = currentKeys.union(archivedKeys);
    expect((await db.execute(distinct.orderBy(desc(distinct.columns.id)))).rows).toEqual([
      { id: 9007199254740993n, name: 'Grace' },
      { id: 10n, name: 'Linus' },
      { id: 2n, name: null },
      { id: 1n, name: 'Ada' },
    ]);
    const page = distinct.orderBy(asc(distinct.columns.id)).limit(2).offset(1);
    expect((await db.execute(page)).rows.map((row) => row.id)).toEqual([2n, 10n]);
  });

  it('applies INTERSECT and EXCEPT set semantics, treating NULLs as equal', async () => {
    expect((await db.execute(currentKeys.intersect(archivedKeys))).rows).toEqual([
      { id: 2n, name: null },
    ]);
    expect((await db.execute(currentKeys.except(archivedKeys))).rows).toEqual([
      { id: 1n, name: 'Ada' },
    ]);
    const remaining = archivedKeys.except(currentKeys);
    expect((await db.execute(remaining.orderBy(asc(remaining.columns.id)))).rows).toEqual([
      { name: 'Linus', id: 10n },
      { name: 'Grace', id: 9007199254740993n },
    ]);
  });

  it('groups by builder structure where keyword precedence would differ', async () => {
    const left = select(current, { id: current.columns.id });
    const right = select(archived, { id: archived.columns.id });
    const only = right.where(eq(archived.columns.id, 2n));
    const ids = (rows: readonly { readonly id: bigint }[]) =>
      rows.map((row) => row.id).sort((x, y) => Number(x - y));
    expect(ids((await db.execute(left.union(right).intersect(only))).rows)).toEqual([2n]);
    expect(ids((await db.execute(left.union(right.intersect(only)))).rows)).toEqual([1n, 2n]);
    const keyword = await db.queryRaw<{ ID: string }[]>(
      sql`SELECT ID FROM ${name(current)} UNION SELECT ID FROM ${name(archived)} INTERSECT SELECT ID FROM ${name(archived)} WHERE ID = 2 ORDER BY ID`,
    );
    expect(keyword.map((row) => row.ID)).toEqual(['1', '2']);
  });

  it('returns exact widened decimals, nanosecond timestamps, and nullable branch domains', async () => {
    const amounts = select(current, { amount: current.columns.amount }).union(
      select(archived, { amount: archived.columns.amount }),
    );
    expect((await db.execute(amounts.orderBy(asc(amounts.columns.amount, 'LAST')))).rows).toEqual([
      { amount: '1.5000' },
      { amount: '2.2500' },
      { amount: '3.1234' },
      { amount: null },
    ]);
    const times = select(current, { at: current.columns.at }).unionAll(
      select(archived, { at: archived.columns.at }),
    );
    const stamps = (await db.execute(times.orderBy(asc(times.columns.at)).limit(1))).rows;
    expect(stamps).toEqual([{ at: '2026-01-01 10:00:00.123456789' }]);
  });

  it('validates VARIANT branches with their declared shapes', async () => {
    const payloads = select(current, { payload: current.columns.payload }).union(
      select(archived, { payload: archived.columns.payload }),
    );
    const rows = (await db.execute(payloads)).rows.map((row) => JSON.stringify(row.payload));
    expect(rows.sort()).toEqual(['[1,2]', 'null', '{"ok":false}', '{"ok":true}']);
    const shaped = select(current, { payload: current.columns.payload }).except(
      select(archived, { payload: archived.columns.payload }),
    );
    expect((await db.execute(shaped)).rows).toEqual([{ payload: { ok: true } }]);
  });

  it('composes with CTEs, derived tables, and streaming', async () => {
    const shared = select(archived, {
      id: archived.columns.id,
      name: archived.columns.name,
    }).asCte('shared');
    const fromShared = select(shared, { id: shared.columns.id, name: shared.columns.name });
    const combined = fromShared
      .union(currentKeys)
      .except(fromShared.where(eq(shared.columns.id, 10n)));
    const rows = [];
    for await (const row of db.stream(combined.orderBy(asc(combined.columns.id)))) rows.push(row);
    expect(rows).toEqual([
      { id: 1n, name: 'Ada' },
      { id: 2n, name: null },
      { id: 9007199254740993n, name: 'Grace' },
    ]);
    const derived = combined.as('combined');
    expect(
      (await db.execute(select(derived, { total: count() }).where(eq(derived.columns.name, null))))
        .rows,
    ).toEqual([{ total: 1n }]);
  });
});
