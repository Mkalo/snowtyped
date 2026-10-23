import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  add,
  asc,
  avg,
  cast,
  count,
  date,
  decimal,
  div,
  float,
  insert,
  integer,
  mul,
  select,
  snowflakeTable,
  sql,
  sub,
  sum,
  text,
  time,
  timestamp,
} from '../../src/index.js';
import { createFixture, integrationConfig } from '../support/snowflake.js';

describe('typed expression helpers against Snowflake', () => {
  const fixture = createFixture(integrationConfig());
  const db = fixture.client;
  const database = fixture.table.node.parts[0] as string;
  const metrics = snowflakeTable(
    'METRICS',
    {
      id: integer('ID').notNull(),
      grp: text('GRP').notNull(),
      qty: integer('QTY').notNull(),
      price: decimal('PRICE').notNull(),
      ratio: float('RATIO').notNull(),
      note: text('NOTE'),
      bonus: decimal('BONUS'),
      day: date('DAY').notNull(),
      at: timestamp('AT_VALUE').notNull(),
      clock: time('CLOCK').notNull(),
    },
    { database, schema: fixture.schemaName },
  );
  const m = metrics.columns;

  beforeAll(async () => {
    await fixture.seed();
    await db.queryRaw(
      sql`CREATE TABLE ${sql.identifier(...(metrics.node.parts as [string, ...string[]]))} (ID NUMBER(38,0) NOT NULL, GRP VARCHAR NOT NULL, QTY NUMBER(38,0) NOT NULL, PRICE NUMBER(38,4) NOT NULL, RATIO DOUBLE NOT NULL, NOTE VARCHAR, BONUS NUMBER(38,4), DAY DATE NOT NULL, AT_VALUE TIMESTAMP_NTZ(9) NOT NULL, CLOCK TIME(9) NOT NULL)`,
    );
    await db.execute(
      insert(metrics, [
        {
          id: 1n,
          grp: 'a',
          qty: 9007199254740993n,
          price: '10.5000',
          ratio: 0.5,
          note: ' x ',
          bonus: null,
          day: '2026-01-15',
          at: '2026-01-15 10:30:45.123456789',
          clock: '10:30:45.123456789',
        },
        {
          id: 2n,
          grp: 'a',
          qty: 3n,
          price: '2.2500',
          ratio: 1.5,
          note: null,
          bonus: '1.0000',
          day: '2026-02-28',
          at: '2026-02-28 23:59:59',
          clock: '23:59:59',
        },
        {
          id: 3n,
          grp: 'b',
          qty: 7n,
          price: '0.0001',
          ratio: 2,
          note: 'hello',
          bonus: '2.5000',
          day: '2024-02-29',
          at: '2024-02-29 00:00:00',
          clock: '00:00:00',
        },
      ]),
    );
  });
  afterAll(() => fixture.cleanup());

  it('casts into exact target domains and preserves nullability', async () => {
    const rows = (
      await db.execute(
        select(metrics, {
          qty: cast(m.qty, 'text'),
          price: cast(m.price, 'integer'),
          ratio: cast(m.ratio, 'decimal', 10, 3),
          bonus: cast(m.bonus, 'text'),
          day: cast(m.day, 'timestamp_ntz'),
          clock: cast(m.at, 'time'),
          float: cast(m.price, 'float'),
        }).orderBy(asc(m.id)),
      )
    ).rows;
    expect(rows).toEqual([
      {
        qty: '9007199254740993',
        price: 11n,
        ratio: '0.500',
        bonus: null,
        day: '2026-01-15 00:00:00.000000000',
        clock: '10:30:45.123456789',
        float: 10.5,
      },
      {
        qty: '3',
        price: 2n,
        ratio: '1.500',
        bonus: '1.0000',
        day: '2026-02-28 00:00:00.000000000',
        clock: '23:59:59.000000000',
        float: 2.25,
      },
      {
        qty: '7',
        price: 0n,
        ratio: '2.000',
        bonus: '2.5000',
        day: '2024-02-29 00:00:00.000000000',
        clock: '00:00:00.000000000',
        float: 0.0001,
      },
    ]);
  });

  it('averages and computes arithmetic with Snowflake numeric domains', async () => {
    const grouped = select(metrics, {
      grp: m.grp,
      qty: avg(m.qty),
      price: avg(m.price),
      ratio: avg(m.ratio),
      bonus: avg(m.bonus),
      perRow: div(sum(m.price), count()),
    })
      .groupBy(m.grp)
      .orderBy(asc(m.grp));
    expect((await db.execute(grouped)).rows).toEqual([
      {
        grp: 'a',
        qty: '4503599627370498.000000',
        price: '6.3750000000',
        ratio: 1,
        bonus: '1.0000000000',
        perRow: '6.3750000000',
      },
      {
        grp: 'b',
        qty: '7.000000',
        price: '0.0001000000',
        ratio: 2,
        bonus: '2.5000000000',
        perRow: '0.0001000000',
      },
    ]);
    const rows = select(metrics, {
      next: add(m.qty, 1n),
      half: div(m.qty, 2n),
      total: mul(m.price, m.qty),
      net: sub(m.price, '0.25'),
      scaled: mul(m.ratio, 2),
      mixed: add(m.price, m.ratio),
      maybe: add(m.bonus, m.qty),
    }).orderBy(asc(m.id));
    expect((await db.execute(rows)).rows).toEqual([
      {
        next: 9007199254740994n,
        half: '4503599627370496.500000',
        total: '94575592174780426.5000',
        net: '10.2500',
        scaled: 1,
        mixed: 11,
        maybe: null,
      },
      {
        next: 4n,
        half: '1.500000',
        total: '6.7500',
        net: '2.0000',
        scaled: 3,
        mixed: 3.75,
        maybe: '4.0000',
      },
      {
        next: 8n,
        half: '3.500000',
        total: '0.0007',
        net: '-0.2499',
        scaled: 4,
        mixed: 2.0001,
        maybe: '9.5000',
      },
    ]);
  });
});
