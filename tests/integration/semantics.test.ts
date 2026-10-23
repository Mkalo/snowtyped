import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as z from 'zod';
import {
  asc,
  count,
  date,
  decimal,
  desc,
  eq,
  float,
  gt,
  gte,
  inArray,
  insert,
  integer,
  jsonPath,
  lower,
  lt,
  over,
  rowNumber,
  select,
  snowflakeTable,
  sql,
  sum,
  text,
  timestamp,
  update,
  variant,
} from '../../src/index.js';
import { createFixture, integrationConfig } from '../support/snowflake.js';

describe('semantic validation accepts valid Snowflake behavior', () => {
  const fixture = createFixture(integrationConfig());
  const db = fixture.client;
  const database = fixture.table.node.parts[0] as string;
  const facts = snowflakeTable(
    'FACTS',
    {
      id: integer('ID').notNull(),
      grp: text('GRP').notNull(),
      amount: decimal('AMOUNT').notNull(),
      ratio: float('RATIO').notNull(),
      day: date('DAY').notNull(),
      at: timestamp('AT_VALUE', 'tz').notNull(),
      payload: variant('PAYLOAD', z.object({ tag: z.string(), n: z.number() })).notNull(),
    },
    { database, schema: fixture.schemaName },
  );
  const c = facts.columns;

  beforeAll(async () => {
    await fixture.seed();
    await db.queryRaw(
      sql`CREATE TABLE ${sql.identifier(...(facts.node.parts as [string, ...string[]]))} (ID NUMBER(38,0) NOT NULL, GRP VARCHAR NOT NULL, AMOUNT NUMBER(38,2) NOT NULL, RATIO DOUBLE NOT NULL, DAY DATE NOT NULL, AT_VALUE TIMESTAMP_TZ(9) NOT NULL, PAYLOAD VARIANT NOT NULL)`,
    );
    await db.execute(
      insert(facts, [
        {
          id: 1n,
          grp: 'A',
          amount: '1.00',
          ratio: 1,
          day: '2024-01-01',
          at: '2024-01-01 00:00:00 +00:00',
          payload: { tag: 'Alpha', n: 1 },
        },
        {
          id: 2n,
          grp: 'a',
          amount: '2.50',
          ratio: 2,
          day: '2024-01-02',
          at: '2024-01-01 12:00:00 +00:00',
          payload: { tag: 'beta', n: 2 },
        },
        {
          id: 3n,
          grp: 'B',
          amount: '3.00',
          ratio: 3.5,
          day: '2024-01-03',
          at: '2024-01-04 00:00:00 +00:00',
          payload: { tag: 'gamma', n: 3 },
        },
      ]),
    );
  });
  afterAll(() => fixture.cleanup());

  it('compares numeric types, dates with timestamps, and VARIANT paths with literals', async () => {
    const query = select(facts, { id: c.id }).where(eq(c.id, c.amount)).orderBy(asc(c.id));
    expect((await db.execute(query)).rows).toEqual([{ id: 1n }, { id: 3n }]);
    expect(
      (await db.execute(select(facts, { id: c.id }).where(lt(c.amount, c.ratio)))).rows,
    ).toEqual([{ id: 3n }]);
    expect(
      (await db.execute(select(facts, { id: c.id }).where(gte(c.day, c.at)).orderBy(asc(c.id))))
        .rows,
    ).toEqual([{ id: 1n }, { id: 2n }]);
    const tag = jsonPath(c.payload, 'tag');
    expect((await db.execute(select(facts, { id: c.id }).where(eq(tag, 'beta')))).rows).toEqual([
      { id: 2n },
    ]);
    expect(
      (
        await db.execute(
          select(facts, { id: c.id })
            .where(inArray(jsonPath(c.payload, 'n'), [1, 3]))
            .orderBy(asc(c.id)),
        )
      ).rows,
    ).toEqual([{ id: 1n }, { id: 3n }]);
    expect(
      (await db.execute(select(facts, { id: c.id }).where(eq(c.grp, jsonPath(c.payload, 'tag')))))
        .rows,
    ).toEqual([]);
  });

  it('groups by expressions and windows over grouped aggregates', async () => {
    const query = select(facts, {
      key: lower(c.grp),
      total: sum(c.amount),
      share: over(sum(count())),
      rank: rowNumber({ orderBy: [desc(count())] }),
    })
      .groupBy(lower(c.grp))
      .having(gt(count(), 0n))
      .orderBy(asc(lower(c.grp)));
    expect((await db.execute(query)).rows).toEqual([
      { key: 'a', total: '3.50', share: '3', rank: 1n },
      { key: 'b', total: '3.00', share: '3', rank: 2n },
    ]);
    const implicit = select(facts, { n: count() }).having(gt(count(), 2n));
    expect((await db.execute(implicit)).rows).toEqual([{ n: 3n }]);
  });

  it('assigns across compatible SQL types', async () => {
    await db.execute(update(facts, { at: c.day }).where(eq(c.id, 3n)));
    const query = select(facts, { at: c.at }).where(eq(c.id, 3n));
    expect((await db.execute(query)).rows[0]?.at).toMatch(/^2024-01-03 00:00:00\.000000000/);
  });
});
