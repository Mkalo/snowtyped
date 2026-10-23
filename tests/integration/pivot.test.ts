import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  asc,
  date,
  decimal,
  dynamicPivot,
  eq,
  insert,
  integer,
  pivot,
  select,
  snowflakeTable,
  sql,
  text,
  unpivot,
} from '../../src/index.js';
import { createFixture, integrationConfig } from '../support/snowflake.js';

describe('PIVOT and UNPIVOT against Snowflake', () => {
  const fixture = createFixture(integrationConfig());
  const db = fixture.client;
  const namespace = { database: fixture.table.node.parts[0] as string, schema: fixture.schemaName };
  const sales = snowflakeTable(
    'SALES',
    {
      id: integer('ID').notNull(),
      region: text('REGION'),
      quarter: text('QUARTER').notNull(),
      amount: decimal('AMOUNT'),
      day: date('DAY').notNull(),
    },
    namespace,
  );
  const months = snowflakeTable(
    'MONTHS',
    {
      id: integer('ID').notNull(),
      jan: integer('JAN').notNull(),
      feb: integer('FEB'),
    },
    namespace,
  );
  const name = (table: { node: { parts: readonly string[] } }) =>
    sql.identifier(...(table.node.parts as [string, ...string[]]));
  const byRegion = select(sales, {
    region: sales.columns.region,
    quarter: sales.columns.quarter,
    amount: sales.columns.amount,
  }).as('S');

  beforeAll(async () => {
    await fixture.seed();
    await db.queryRaw(
      sql`CREATE TABLE ${name(sales)} (ID NUMBER(38,0) NOT NULL, REGION VARCHAR, QUARTER VARCHAR NOT NULL, AMOUNT NUMBER(38,2), DAY DATE NOT NULL)`,
    );
    await db.execute(
      insert(sales, [
        { id: 1n, region: 'east', quarter: 'Q1', amount: '10.50', day: '2024-01-05' },
        { id: 2n, region: 'east', quarter: 'Q1', amount: '4.50', day: '2024-02-01' },
        { id: 3n, region: 'east', quarter: "it's", amount: '1.00', day: '2024-04-01' },
        { id: 4n, region: 'west', quarter: 'Q2', amount: null, day: '2024-05-01' },
        { id: 5n, region: null, quarter: 'Q1', amount: '2.00', day: '2024-03-01' },
      ]),
    );
    await db.queryRaw(
      sql`CREATE TABLE ${name(months)} (ID NUMBER(38,0) NOT NULL, JAN NUMBER(38,0) NOT NULL, FEB NUMBER(38,0))`,
    );
    await db.execute(
      insert(months, [
        { id: 1n, jan: 10n, feb: 20n },
        { id: 2n, jan: 30n, feb: null },
      ]),
    );
  });
  afterAll(() => fixture.cleanup());

  it('pivots declared values with null groups, defaults, and escaped literals', async () => {
    const totals = pivot(byRegion, 'P', {
      aggregate: 'sum',
      value: 'amount',
      for: 'quarter',
      in: { q1: 'Q1', q2: 'Q2', quoted: "it's", q4: 'Q4' },
    });
    const result = await db.execute(select(totals).orderBy(asc(totals.columns.region, 'LAST')));
    expect(result.rows).toEqual([
      { region: 'east', q1: '15.00', q2: null, quoted: '1.00', q4: null },
      { region: 'west', q1: null, q2: null, quoted: null, q4: null },
      { region: null, q1: '2.00', q2: null, quoted: null, q4: null },
    ]);
    const filled = pivot(byRegion, 'F', {
      aggregate: 'sum',
      value: 'amount',
      for: 'quarter',
      in: { q1: 'Q1', q4: 'Q4' },
      default: '0',
    });
    expect(
      (await db.execute(select(filled).orderBy(asc(filled.columns.region, 'LAST')))).rows,
    ).toEqual([
      { region: 'east', q1: '15.00', q4: '0.00' },
      { region: 'west', q1: '0.00', q4: '0.00' },
      { region: null, q1: '2.00', q4: '0.00' },
    ]);
  });

  it('infers count and min/max domains from the declared source', async () => {
    const counts = pivot(byRegion, 'C', {
      aggregate: 'count',
      value: 'amount',
      for: 'quarter',
      in: { q1: 'Q1', q2: 'Q2' },
    });
    expect(
      (await db.execute(select(counts).orderBy(asc(counts.columns.region, 'LAST')))).rows,
    ).toEqual([
      { region: 'east', q1: 2n, q2: 0n },
      { region: 'west', q1: 0n, q2: 0n },
      { region: null, q1: 1n, q2: 0n },
    ]);
    const days = select(sales, { quarter: sales.columns.quarter, day: sales.columns.day }).as('D');
    const latest = pivot(days, 'L', {
      aggregate: 'max',
      value: 'day',
      for: 'quarter',
      in: { q1: 'Q1', q3: 'Q3' },
      default: '1970-01-01',
    });
    expect((await db.execute(select(latest))).rows).toEqual([
      { q1: '2024-03-01', q3: '1970-01-01' },
    ]);
  });

  it('composes pivots with joins, filters, and derived queries', async () => {
    const ids = select(sales, {
      id: sales.columns.id,
      quarter: sales.columns.quarter,
      amount: sales.columns.amount,
    }).as('I');
    const perId = pivot(ids, 'P', {
      aggregate: 'sum',
      value: 'amount',
      for: 'quarter',
      in: { q1: 'Q1' },
    });
    const joined = select(sales)
      .innerJoin(perId, eq(sales.columns.id, perId.columns.id))
      .where(eq(perId.columns.q1, '4.50'))
      .select({ id: sales.columns.id, region: sales.columns.region, q1: perId.columns.q1 });
    expect((await db.execute(joined)).rows).toEqual([{ id: 2n, region: 'east', q1: '4.50' }]);
    const direct = pivot(sales, 'B', {
      aggregate: 'min',
      value: 'amount',
      for: 'quarter',
      in: { q1: 'Q1' },
    });
    expect((await db.execute(select(direct).where(eq(direct.columns.id, 4n)))).rows).toEqual([
      { id: 4n, region: 'west', day: '2024-05-01', q1: null },
    ]);
    const wrapped = select(perId, { id: perId.columns.id, q1: perId.columns.q1 })
      .orderBy(asc(perId.columns.id))
      .as('W');
    expect((await db.execute(select(wrapped).limit(2))).rows).toEqual([
      { id: 1n, q1: '10.50' },
      { id: 2n, q1: '4.50' },
    ]);
  });

  it('unpivots same-typed columns with and without nulls', async () => {
    const long = unpivot(months, 'U', { value: 'amount', for: 'month', in: ['jan', 'feb'] });
    const ordered = (query: typeof long) =>
      select(query).orderBy(asc(query.columns.id), asc(query.columns.month));
    expect((await db.execute(ordered(long))).rows).toEqual([
      { id: 1n, amount: 20n, month: 'feb' },
      { id: 1n, amount: 10n, month: 'jan' },
      { id: 2n, amount: 30n, month: 'jan' },
    ]);
    const withNulls = unpivot(months, 'N', {
      value: 'amount',
      for: 'month',
      in: ['jan', 'feb'],
      includeNulls: true,
    });
    expect(
      (
        await db.execute(
          select(withNulls)
            .where(eq(withNulls.columns.id, 2n))
            .orderBy(asc(withNulls.columns.month)),
        )
      ).rows,
    ).toEqual([
      { id: 2n, amount: null, month: 'feb' },
      { id: 2n, amount: 30n, month: 'jan' },
    ]);
  });

  it('returns dynamic pivots as unvalidated raw rows', async () => {
    const dynamic = dynamicPivot(byRegion, 'Y', {
      aggregate: 'count',
      value: 'amount',
      for: 'quarter',
      order: 'asc',
    });
    const rows = (await db.queryRaw(
      sql`SELECT * FROM (${dynamic}) WHERE "region" = ${'east'}`,
    )) as Record<string, unknown>[];
    expect(rows).toEqual([{ region: 'east', "'Q1'": '2', "'Q2'": '0', "'it''s'": '1' }]);
  });
});
