import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as z from 'zod';
import {
  asc,
  binary,
  boolean,
  date,
  decimal,
  desc,
  eq,
  float,
  gt,
  insert,
  integer,
  max,
  min,
  type Snowtyped,
  select,
  snowflakeTable,
  sql,
  sum,
  text,
  time,
  timestamp,
  variant,
} from '../../src/index.js';
import { createFixture, integrationConfig, tableIdentifier } from '../support/snowflake.js';

const MAX_NUMBER = 10n ** 38n - 1n;
const ALL_BYTES = new Uint8Array(Array.from({ length: 256 }, (_, index) => index));
const TRICKY_TEXT = 'it\'s "quoted"\n\ttab \\ back ? $1 ;-- /* */ ação 🚀';

describe('column families and wire representations against Snowflake', () => {
  const fixture = createFixture(integrationConfig());
  const db = fixture.client;
  const namespace = { database: fixture.table.node.parts[0] as string, schema: fixture.schemaName };
  const columns = {
    id: integer('ID').notNull(),
    big: integer('BIG'),
    exact: decimal('EXACT'),
    money: decimal('MONEY'),
    real: float('REAL_VALUE'),
    flag: boolean('FLAG'),
    label: text('LABEL'),
    bytes: binary('BYTES'),
    day: date('DAY'),
    clock: time('CLOCK'),
    ntz: timestamp('NTZ'),
    ltz: timestamp('LTZ', 'ltz'),
    tz: timestamp('TZ', 'tz'),
    json: variant('JSON'),
  };
  const values = snowflakeTable('VALUES_TABLE', columns, namespace);
  const v = values.columns;
  const read = async (id: bigint) => (await db.execute(select(values).where(eq(v.id, id)))).rows[0];

  beforeAll(async () => {
    await fixture.seed();
    await db.queryRaw`ALTER SESSION SET TIMEZONE = 'UTC'`;
    await db.queryRaw(sql`CREATE TABLE ${tableIdentifier(values)} (
      ID NUMBER(38,0) NOT NULL, BIG NUMBER(38,0), EXACT NUMBER(38,4), MONEY NUMBER(10,2),
      REAL_VALUE DOUBLE, FLAG BOOLEAN, LABEL VARCHAR, BYTES BINARY, DAY DATE, CLOCK TIME(9),
      NTZ TIMESTAMP_NTZ(9), LTZ TIMESTAMP_LTZ(9), TZ TIMESTAMP_TZ(9), JSON VARIANT)`);
    await db.execute(
      insert(values, [
        {
          id: 1n,
          big: MAX_NUMBER,
          exact: '9999999999999999999999999999999999.9999',
          money: '99999999.99',
          real: 1.5,
          flag: true,
          label: 'NULL',
          bytes: ALL_BYTES,
          day: '9999-12-31',
          clock: '23:59:59.999999999',
          ntz: '9999-12-31 23:59:59.999999999',
          ltz: '2026-10-22 12:34:56.123456789 +02:00',
          tz: '2026-10-22 12:34:56.123456789 +05:30',
          json: { nested: { list: [1, 'two', null, true] }, text: 'ação 🚀' },
        },
        {
          id: 2n,
          big: -MAX_NUMBER,
          exact: '-9999999999999999999999999999999999.9999',
          money: '-0.01',
          real: -2.5e-10,
          flag: false,
          label: '',
          bytes: new Uint8Array(),
          day: '0001-01-01',
          clock: '00:00:00',
          ntz: '1970-01-01 00:00:00',
          ltz: '1970-01-01 00:00:00 +00:00',
          tz: '2000-02-29 23:59:59.5 -11:00',
          json: [],
        },
        {
          id: 3n,
          big: 0n,
          exact: '0',
          money: '0.1',
          real: 0,
          flag: true,
          label: TRICKY_TEXT,
          bytes: new Uint8Array([0]),
          day: '2024-02-29',
          clock: '12:00:00.5',
          ntz: '2024-02-29 12:00:00.000000001',
          ltz: '2024-02-29 12:00:00 -08:00',
          tz: '2024-02-29T12:00:00Z',
          json: 'just text',
        },
      ]),
    );
    await db.queryRaw(sql`INSERT INTO ${tableIdentifier(values)} (ID) VALUES (4)`);
    await db.queryRaw(
      sql`INSERT INTO ${tableIdentifier(values)} (ID, JSON) SELECT 5, PARSE_JSON('null')`,
    );
  });
  afterAll(() => fixture.cleanup());

  it('round-trips maximum magnitudes and nanosecond precision', async () => {
    const row = await read(1n);
    expect(row).toMatchObject({
      big: MAX_NUMBER,
      exact: '9999999999999999999999999999999999.9999',
      money: '99999999.99',
      real: 1.5,
      flag: true,
      label: 'NULL',
      day: '9999-12-31',
      clock: '23:59:59.999999999',
      ntz: '9999-12-31 23:59:59.999999999',
      ltz: '2026-10-22 10:34:56.123456789 Z',
      tz: '2026-10-22 12:34:56.123456789 +05:30',
      json: { nested: { list: [1, 'two', null, true] }, text: 'ação 🚀' },
    });
    expect(row?.bytes).toBeInstanceOf(Uint8Array);
    expect([...(row?.bytes ?? [])]).toEqual([...ALL_BYTES]);
  });

  it('round-trips minimum magnitudes, empty values, and calendar edges', async () => {
    const row = await read(2n);
    expect(row).toMatchObject({
      big: -MAX_NUMBER,
      exact: '-9999999999999999999999999999999999.9999',
      money: '-0.01',
      real: -2.5e-10,
      flag: false,
      label: '',
      day: '0001-01-01',
      clock: '00:00:00.000000000',
      ntz: '1970-01-01 00:00:00.000000000',
      ltz: '1970-01-01 00:00:00.000000000 Z',
      tz: '2000-02-29 23:59:59.500000000 -11:00',
      json: [],
    });
    expect([...(row?.bytes ?? [1])]).toEqual([]);
  });

  it('pads scale, keeps zeros, and preserves text and JSON scalars', async () => {
    expect(await read(3n)).toMatchObject({
      big: 0n,
      exact: '0.0000',
      money: '0.10',
      real: 0,
      label: TRICKY_TEXT,
      day: '2024-02-29',
      clock: '12:00:00.500000000',
      ntz: '2024-02-29 12:00:00.000000001',
      ltz: '2024-02-29 20:00:00.000000000 Z',
      tz: '2024-02-29 12:00:00.000000000 Z',
      json: 'just text',
    });
  });

  it('decodes SQL NULL in every nullable family and JSON null in VARIANT', async () => {
    const empty = {
      big: null,
      exact: null,
      money: null,
      real: null,
      flag: null,
      label: null,
      bytes: null,
      day: null,
      clock: null,
      ntz: null,
      ltz: null,
      tz: null,
      json: null,
    };
    expect(await read(4n)).toEqual({ id: 4n, ...empty });
    expect(await read(5n)).toEqual({ id: 5n, ...empty });
  });

  it('renders LTZ values in the session time zone', async () => {
    await db.queryRaw`ALTER SESSION SET TIMEZONE = 'Asia/Kolkata'`;
    try {
      expect((await read(1n))?.ltz).toBe('2026-10-22 16:04:56.123456789 +05:30');
      expect((await read(1n))?.tz).toBe('2026-10-22 12:34:56.123456789 +05:30');
    } finally {
      await db.queryRaw`ALTER SESSION SET TIMEZONE = 'UTC'`;
    }
  });

  it('binds typed filter values for every family', async () => {
    const match = async (predicate: Snowtyped.Predicate<'VALUES_TABLE'>) =>
      (await db.execute(select(values, { id: v.id }).where(predicate))).rows
        .map((row) => row.id)
        .sort();
    expect(await match(eq(v.big, -MAX_NUMBER))).toEqual([2n]);
    expect(await match(eq(v.exact, '0'))).toEqual([3n]);
    expect(await match(eq(v.money, '-0.01'))).toEqual([2n]);
    expect(await match(gt(v.real, 1))).toEqual([1n]);
    expect(await match(eq(v.flag, false))).toEqual([2n]);
    expect(await match(eq(v.label, TRICKY_TEXT))).toEqual([3n]);
    expect(await match(eq(v.label, 'NULL'))).toEqual([1n]);
    expect(await match(eq(v.bytes, new Uint8Array([0])))).toEqual([3n]);
    expect(await match(eq(v.bytes, new Uint8Array()))).toEqual([2n]);
    expect(await match(eq(v.day, '2024-02-29'))).toEqual([3n]);
    expect(await match(eq(v.clock, '12:00:00.5'))).toEqual([3n]);
    expect(await match(eq(v.ntz, '2024-02-29 12:00:00.000000001'))).toEqual([3n]);
    expect(await match(eq(v.ntz, '2024-02-29 12:00:00'))).toEqual([]);
    expect(await match(eq(v.tz, '2026-10-22 07:04:56.123456789 +00:00'))).toEqual([1n]);
  });

  it('orders and aggregates natively before wire serialization', async () => {
    const ordered = (key: keyof typeof v, direction: typeof asc) =>
      db
        .execute(select(values, { id: v.id }).orderBy(direction(v[key], 'LAST'), asc(v.id)))
        .then((result) => result.rows.map((row) => row.id));
    expect(await ordered('day', asc)).toEqual([2n, 3n, 1n, 4n, 5n]);
    expect(await ordered('big', desc)).toEqual([1n, 3n, 2n, 4n, 5n]);
    expect(await ordered('exact', asc)).toEqual([2n, 3n, 1n, 4n, 5n]);
    expect(await ordered('ntz', desc)).toEqual([1n, 3n, 2n, 4n, 5n]);
    expect(await ordered('clock', asc)).toEqual([2n, 3n, 1n, 4n, 5n]);
    expect(
      (
        await db.execute(
          select(values, {
            firstDay: min(v.day),
            lastStamp: max(v.ntz),
            latestClock: max(v.clock),
            money: sum(v.money),
            highest: max(v.big),
          }),
        )
      ).rows,
    ).toEqual([
      {
        firstDay: '0001-01-01',
        lastStamp: '9999-12-31 23:59:59.999999999',
        latestClock: '23:59:59.999999999',
        money: '100000000.08',
        highest: MAX_NUMBER,
      },
    ]);
  });

  it('validates VARIANT values against a declared shape', async () => {
    const shaped = snowflakeTable(
      'VALUES_TABLE',
      {
        id: integer('ID').notNull(),
        json: variant('JSON', z.object({ nested: z.object({ list: z.array(z.unknown()) }) })),
      },
      namespace,
    );
    expect((await db.execute(select(shaped).where(eq(shaped.columns.id, 1n)))).rows).toEqual([
      { id: 1n, json: { nested: { list: [1, 'two', null, true] } } },
    ]);
    await expect(db.execute(select(shaped).where(eq(shaped.columns.id, 2n)))).rejects.toThrow();
  });

  it('rejects real data that contradicts each kind of declaration', async () => {
    const reading = (column: Snowtyped.AnyColumn, id: bigint) => {
      const table = snowflakeTable(
        'VALUES_TABLE',
        { id: integer('ID').notNull(), value: column },
        namespace,
      );
      return db.execute(select(table).where(eq(table.columns.id, id)));
    };
    await expect(reading(integer('EXACT'), 1n)).rejects.toThrow();
    await expect(reading(boolean('LABEL'), 1n)).rejects.toThrow();
    await expect(reading(binary('LABEL'), 1n)).rejects.toThrow();
    await expect(reading(integer('BIG').notNull(), 4n)).rejects.toThrow();
    await expect(reading(date('LABEL'), 1n)).rejects.toThrow();
    await expect(reading(integer('EXACT'), 3n)).rejects.toThrow();
    expect((await reading(decimal('EXACT'), 3n)).rows).toEqual([{ id: 3n, value: '0.0000' }]);
  });

  it('rejects non-finite FLOAT values instead of decoding them', async () => {
    const floats = snowflakeTable('FLOATS', { value: float('VALUE') }, namespace);
    await db.queryRaw(
      sql`CREATE TABLE ${tableIdentifier(floats)} AS SELECT 'NaN'::DOUBLE AS VALUE UNION ALL SELECT 'inf'::DOUBLE`,
    );
    await expect(db.execute(select(floats))).rejects.toThrow();
    await expect(
      db.execute(select(floats).where(eq(floats.columns.value, 1))),
    ).resolves.toMatchObject({ rows: [] });
  });

  it('returns exact text and NULL-normalized values from raw queries', async () => {
    const [row] = await db.queryRaw<
      [Record<string, unknown>]
    >`SELECT ${MAX_NUMBER}::NUMBER(38,0) AS BIG, 1.5::NUMBER(10,4) AS EXACT,
        NULL::NUMBER AS NUM, NULL::DATE AS DAY, 'NULL' AS TEXT, NULL::VARCHAR AS EMPTY,
        '2026-01-02'::DATE AS DATE_VALUE, TO_BINARY('00ff', 'HEX') AS BYTES, NULL::BINARY AS NO_BYTES,
        PARSE_JSON('{"a":1}') AS JSON, TRUE AS FLAG`;
    expect(Buffer.isBuffer(row.BYTES) && [...row.BYTES]).toEqual([0, 255]);
    expect(row).toEqual({
      BIG: MAX_NUMBER.toString(),
      EXACT: '1.5000',
      NUM: null,
      DAY: null,
      TEXT: 'NULL',
      EMPTY: null,
      DATE_VALUE: '2026-01-02',
      BYTES: row.BYTES,
      NO_BYTES: null,
      JSON: '{\n  "a": 1\n}',
      FLAG: true,
    });
  });

  it('normalizes NULL by the column a duplicated raw name keeps', async () => {
    const [row] = await db.queryRaw<[Record<string, unknown>]>`SELECT
        'text' AS NUMBER_LAST, NULL::NUMBER AS NUMBER_LAST, NULL::NUMBER AS TEXT_LAST, 'NULL' AS TEXT_LAST`;
    expect(row).toEqual({ NUMBER_LAST: null, TEXT_LAST: 'NULL' });
  });
});
