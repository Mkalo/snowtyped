import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  asc,
  count,
  date,
  decimal,
  eq,
  insert,
  integer,
  min,
  over,
  rangeBetween,
  rowsBetween,
  select,
  snowflakeTable,
  sql,
  sum,
  text,
  timestamp,
} from '../../src/index.js';
import { createFixture, integrationConfig } from '../support/snowflake.js';

describe('explicit window frames against Snowflake', () => {
  const fixture = createFixture(integrationConfig());
  const db = fixture.client;
  const database = fixture.table.node.parts[0] as string;
  const ledger = snowflakeTable(
    'LEDGER',
    {
      id: integer('ID').notNull(),
      grp: text('GRP').notNull(),
      amount: decimal('AMOUNT').notNull(),
      day: date('DAY').notNull(),
      at: timestamp('AT_VALUE').notNull(),
    },
    { database, schema: fixture.schemaName },
  );
  const { id, grp, amount, day, at } = ledger.columns;

  beforeAll(async () => {
    await fixture.seed();
    await db.queryRaw(
      sql`CREATE TABLE ${sql.identifier(...(ledger.node.parts as [string, ...string[]]))} (ID NUMBER(38,0) NOT NULL, GRP VARCHAR NOT NULL, AMOUNT NUMBER(38,4) NOT NULL, DAY DATE NOT NULL, AT_VALUE TIMESTAMP_NTZ(9) NOT NULL)`,
    );
    await db.execute(
      insert(ledger, [
        { id: 1n, grp: 'a', amount: '10', day: '2024-01-01', at: '2024-01-01 00:00:00' },
        { id: 2n, grp: 'a', amount: '20', day: '2024-01-02', at: '2024-01-02 00:00:00' },
        { id: 3n, grp: 'a', amount: '30', day: '2024-01-05', at: '2024-01-05 00:00:00' },
        { id: 4n, grp: 'b', amount: '5', day: '2024-01-01', at: '2024-01-01 12:00:00' },
      ]),
    );
  });
  afterAll(() => fixture.cleanup());

  it('computes running and bounded ROWS frames', async () => {
    const query = select(ledger, {
      id,
      running: over(sum(amount), {
        partitionBy: [grp],
        orderBy: [asc(id)],
        frame: rowsBetween('UNBOUNDED PRECEDING', 'CURRENT ROW'),
      }),
      bounded: over(sum(amount), {
        orderBy: [asc(id)],
        frame: rowsBetween({ preceding: 1 }, { following: 1 }),
      }),
    }).orderBy(asc(id));
    expect((await db.execute(query)).rows).toEqual([
      { id: 1n, running: '10.0000', bounded: '30.0000' },
      { id: 2n, running: '30.0000', bounded: '60.0000' },
      { id: 3n, running: '60.0000', bounded: '55.0000' },
      { id: 4n, running: '5.0000', bounded: '35.0000' },
    ]);
  });

  it('decodes empty frames as NULL aggregates and zero counts', async () => {
    const prior = rowsBetween({ preceding: 2 }, { preceding: 1 });
    const priorCount = over(count(id), { partitionBy: [grp], orderBy: [asc(id)], frame: prior });
    const query = select(ledger, {
      id,
      priorSum: over(sum(amount), { partitionBy: [grp], orderBy: [asc(id)], frame: prior }),
      priorCount,
      nextDay: over(min(day), {
        partitionBy: [grp],
        orderBy: [asc(id)],
        frame: rowsBetween({ following: 1 }, { following: 2 }),
      }),
    }).orderBy(asc(id));
    expect((await db.execute(query)).rows).toEqual([
      { id: 1n, priorSum: null, priorCount: 0n, nextDay: '2024-01-02' },
      { id: 2n, priorSum: '10.0000', priorCount: 1n, nextDay: '2024-01-05' },
      { id: 3n, priorSum: '30.0000', priorCount: 2n, nextDay: null },
      { id: 4n, priorSum: null, priorCount: 0n, nextDay: null },
    ]);
    const first = select(ledger, { id, priorCount }).qualify(eq(priorCount, 0n)).orderBy(asc(id));
    expect((await db.execute(first)).rows).toEqual([
      { id: 1n, priorCount: 0n },
      { id: 4n, priorCount: 0n },
    ]);
  });

  it('computes numeric and interval RANGE frames', async () => {
    const query = select(ledger, {
      id,
      days: over(sum(amount), {
        partitionBy: [grp],
        orderBy: [asc(day)],
        frame: rangeBetween({ preceding: 1 }, 'CURRENT ROW'),
      }),
      hours: over(sum(amount), {
        orderBy: [asc(at)],
        frame: rangeBetween({ preceding: 24, unit: 'HOUR' }, 'CURRENT ROW'),
      }),
      peers: over(count(), {
        orderBy: [asc(grp), asc(day)],
        frame: rangeBetween('UNBOUNDED PRECEDING', 'CURRENT ROW'),
      }),
    }).orderBy(asc(id));
    expect((await db.execute(query)).rows).toEqual([
      { id: 1n, days: '10.0000', hours: '10.0000', peers: 1n },
      { id: 2n, days: '30.0000', hours: '35.0000', peers: 2n },
      { id: 3n, days: '30.0000', hours: '30.0000', peers: 3n },
      { id: 4n, days: '5.0000', hours: '15.0000', peers: 4n },
    ]);
  });
});
