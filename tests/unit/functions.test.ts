import { describe, expect, it } from 'vitest';
import {
  boolean,
  cast,
  count,
  date,
  decimal,
  eq,
  float,
  inArray,
  integer,
  jsonPath,
  select,
  snowflakeTable,
  text,
  timestamp,
  variant,
} from '../../src/index.js';
import { resultSchema } from '../../src/schema.js';

const t = snowflakeTable('T', {
  id: integer('ID').notNull(),
  name: text('NAME'),
  label: text('LABEL').notNull(),
  amount: decimal('AMOUNT').notNull(),
  price: decimal('PRICE'),
  ratio: float('RATIO').notNull(),
  day: date('DAY').notNull(),
  at: timestamp('AT_VALUE'),
  flag: boolean('FLAG'),
  json: variant('JSON').notNull(),
});
const o = snowflakeTable('O', { id: integer('ID').notNull(), name: text('NAME').notNull() });
const { id, name, label, amount, price, ratio, day, at, json } = t.columns;

describe('typed casts', () => {
  it('compiles every target and decodes the target domain', () => {
    const selection = {
      text: cast(id, 'text'),
      integer: cast(label, 'integer'),
      decimal: cast(id, 'decimal', 10, 2),
      float: cast(amount, 'float'),
      boolean: cast(label, 'boolean'),
      date: cast(label, 'date'),
      time: cast(label, 'time'),
      ntz: cast(label, 'timestamp_ntz'),
      ltz: cast(label, 'timestamp_ltz'),
      tz: cast(label, 'timestamp_tz'),
    };
    const compiled = select(t, selection).compile().sql;
    for (const target of [
      'CAST("ID" AS VARCHAR)',
      'CAST("LABEL" AS NUMBER(38,0))',
      'CAST("ID" AS NUMBER(10,2))',
      'CAST("AMOUNT" AS DOUBLE)',
      'CAST("LABEL" AS BOOLEAN)',
      'CAST("LABEL" AS DATE)',
      'CAST("LABEL" AS TIME)',
      'CAST("LABEL" AS TIMESTAMP_NTZ)',
      'CAST("LABEL" AS TIMESTAMP_LTZ)',
      'CAST("LABEL" AS TIMESTAMP_TZ)',
    ])
      expect(compiled).toContain(target);
    expect(compiled).toContain(`TO_VARCHAR("__sflib_result"."date", 'YYYY-MM-DD')`);
    expect(selection.text.wireType).toBeUndefined();
    expect(selection.decimal.wireType).toBe('decimal');
    expect(
      resultSchema(selection).parse({
        text: '1',
        integer: '9007199254740993',
        decimal: '1.50',
        float: '1.25',
        boolean: true,
        date: '2026-10-22',
        time: '12:00:00',
        ntz: '2026-10-22 12:00:00.000000000',
        ltz: '2026-10-22 12:00:00.000000000 +00:00',
        tz: '2026-10-22 12:00:00.000000000 +00:00',
      }),
    ).toMatchObject({ integer: 9007199254740993n, decimal: '1.50', float: 1.25 });
    expect(() => resultSchema(selection).parse({ ...selection, text: null })).toThrow();
  });

  it('preserves nullability, outer-join scope, phase, and literal encoding', () => {
    const nullableText = cast(name, 'integer');
    expect(nullableText.readSchema.parse(null)).toBeNull();
    expect(nullableText.readSchema.parse('7')).toBe(7n);
    expect(cast(json, 'text').readSchema.parse(null)).toBeNull();
    expect(cast(jsonPath(json, 'a'), 'text').readSchema.parse(null)).toBeNull();
    expect(cast(id, 'text').readSchema.safeParse(null).success).toBe(false);
    const joined = select(t)
      .leftJoin(o, eq(t.columns.id, o.columns.id))
      .select({ value: cast(o.columns.id, 'text') });
    expect(resultSchema(joined.selection, joined.nullableSources).parse({ value: null })).toEqual({
      value: null,
    });
    expect(cast(count(), 'text').phase).toBe('aggregate');
    expect(cast(at, 'date').refs).toEqual([t.ref]);
    expect(
      select(t)
        .where(eq(cast(id, 'text'), '1'))
        .compile(),
    ).toMatchObject({
      sql: expect.stringContaining('(CAST("ID" AS VARCHAR) = ?)'),
      binds: ['1'],
    });
    expect(
      select(t)
        .where(inArray(cast(name, 'integer'), [null, 2n]))
        .compile().binds,
    ).toEqual([null, '2']);
    expect(() => eq(cast(price, 'float'), 'x' as never)).toThrow();
    expect(cast(ratio, 'decimal', 38, 37).expression).toMatchObject({ target: 'NUMBER(38,37)' });
    for (const [precision, scale] of [
      [0, 0],
      [39, 0],
      [10, 11],
      [38, 38],
      [10, -1],
      [10.5, 2],
      [10, 0.5],
    ] as const)
      expect(() => cast(day, 'decimal', precision, scale)).toThrow('DECIMAL casts');
  });
});
