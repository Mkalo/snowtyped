import { describe, expect, it } from 'vitest';
import {
  add,
  avg,
  binary,
  boolean,
  caseWhen,
  cast,
  coalesce,
  count,
  date,
  decimal,
  div,
  eq,
  float,
  gt,
  inArray,
  integer,
  isNull,
  jsonPath,
  mul,
  select,
  snowflakeTable,
  sub,
  sum,
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
  data: binary('DATA'),
});
const o = snowflakeTable('O', { id: integer('ID').notNull(), name: text('NAME').notNull() });
const { id, name, label, amount, price, ratio, day, at, flag, json, data } = t.columns;

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

describe('averages and arithmetic', () => {
  it('derives Snowflake numeric result domains', () => {
    const selection = {
      avgInteger: avg(id),
      avgDecimal: avg(price),
      avgFloat: avg(ratio),
      plus: add(id, 1n),
      minus: sub(amount, '1.50'),
      times: mul(amount, '5'),
      quotient: div(id, id),
      scaled: mul(ratio, 2),
      mixed: add(id, ratio),
      exact: add(id, amount),
      ratio: div(sum(amount), count()),
    };
    const compiled = select(t, selection).compile();
    for (const fragment of [
      'AVG("ID")',
      '("ID" + CAST(? AS NUMBER(38,0)))',
      '("AMOUNT" - CAST(? AS NUMBER(38,2)))',
      '("AMOUNT" * CAST(? AS NUMBER(38,0)))',
      '("ID" / "ID")',
      '("RATIO" * CAST(? AS DOUBLE))',
      '(SUM("AMOUNT") / COUNT(*))',
    ])
      expect(compiled.sql).toContain(fragment);
    expect(compiled.binds).toEqual(['1', '1.50', '5', 2]);
    expect(Object.fromEntries(Object.entries(selection).map(([k, v]) => [k, v.wireType]))).toEqual({
      avgInteger: 'decimal',
      avgDecimal: 'decimal',
      avgFloat: 'float',
      plus: 'integer',
      minus: 'decimal',
      times: 'decimal',
      quotient: 'decimal',
      scaled: 'float',
      mixed: 'float',
      exact: 'decimal',
      ratio: 'decimal',
    });
    expect(
      resultSchema(selection).parse({
        avgInteger: '1.500000',
        avgDecimal: null,
        avgFloat: '1.75',
        plus: '9007199254740994',
        minus: '-0.50',
        times: '5.00',
        quotient: '1.000000',
        scaled: '3',
        mixed: '2.5',
        exact: '2.25',
        ratio: null,
      }),
    ).toMatchObject({ avgFloat: 1.75, plus: 9007199254740994n, scaled: 3, ratio: null });
    expect(() => resultSchema(selection).parse({ ...selection, plus: null })).toThrow();
  });

  it('tracks nullability, phase, scope, and rejects non-numeric operands', () => {
    expect(avg(id).phase).toBe('aggregate');
    expect(add(count(), 1n).phase).toBe('aggregate');
    expect(
      select(t, { n: count() })
        .having(eq(add(count(), 1n), 3n))
        .compile().sql,
    ).toContain('HAVING ((COUNT(*) + CAST(? AS NUMBER(38,0))) = ?)');
    expect(add(id, price).readSchema.parse(null)).toBeNull();
    expect(add(price, null as never).expression).toMatchObject({
      right: { kind: 'parameter', value: null },
    });
    const joined = select(t)
      .leftJoin(o, eq(t.columns.id, o.columns.id))
      .select({ next: add(o.columns.id, 1n) });
    expect(resultSchema(joined.selection, joined.nullableSources).parse({ next: null })).toEqual({
      next: null,
    });
    expect(add(id, o.columns.id).refs).toEqual([t.ref, o.ref]);
    expect(inArray(add(id, price), [null]).expression).toMatchObject({
      values: [{ kind: 'parameter', value: null }],
    });
    expect(() => add(label, 'x')).toThrow('Numeric helpers');
    expect(() => avg(day)).toThrow('Numeric helpers');
    expect(() => add(amount, `0.${'1'.repeat(38)}`)).toThrow('37 fractional digits');
    expect(() => add(id, 1 as never)).toThrow();
  });
});

describe('COALESCE and CASE', () => {
  it('derives COALESCE domains, nullability, and typed literal fallbacks', () => {
    const selection = {
      text: coalesce(name, label),
      literal: coalesce(name, 'x'),
      decimal: coalesce(price, '0'),
      maybe: coalesce(name, name),
      bool: coalesce(flag, false),
      bytes: coalesce(data, new Uint8Array([1])),
      json: coalesce(jsonPath(json, 'a'), '1'),
      variant: coalesce(json, { a: 1 }),
    };
    const compiled = select(t, selection).compile();
    expect(compiled.sql).toContain('COALESCE("NAME", "LABEL")');
    expect(compiled.sql).toContain('COALESCE("PRICE", CAST(? AS NUMBER(38,0)))');
    expect(compiled.sql).toContain('COALESCE("DATA", TO_BINARY(?, ?))');
    expect(compiled.binds).toEqual(['x', '0', false, '01', 'HEX', 'a', 1, '{"a":1}']);
    expect(selection.decimal.wireType).toBe('decimal');
    expect(selection.text.readSchema.safeParse(null).success).toBe(false);
    expect(selection.literal.readSchema.safeParse(null).success).toBe(false);
    expect(selection.maybe.readSchema.parse(null)).toBeNull();
    expect(select(t).where(eq(selection.decimal, '1.5')).compile().binds).toEqual(['0', '1.5']);
    expect(inArray(selection.maybe, [null]).expression).toMatchObject({
      values: [{ kind: 'parameter', value: null }],
    });
    const joined = select(t)
      .leftJoin(o, eq(t.columns.id, o.columns.id))
      .select({
        guarded: coalesce(o.columns.name, 'x'),
        counted: coalesce(o.columns.id, count()),
        either: coalesce(o.columns.name, label),
      });
    expect(joined.selection.guarded.nullRefs).toEqual([]);
    expect(joined.selection.counted.nullRefs).toEqual([]);
    expect(joined.selection.either.nullRefs).toEqual([o.ref, t.ref]);
    expect(
      resultSchema(joined.selection, joined.nullableSources).safeParse({
        guarded: null,
        counted: '1',
        either: null,
      }).success,
    ).toBe(false);
    expect(coalesce(count(), id).phase).toBe('aggregate');
    expect(() => coalesce(day, label)).toThrow('COALESCE values must share one SQL domain.');
    expect(() => (coalesce as (value: unknown) => unknown)(name)).toThrow('at least two');
    expect(() => coalesce(id, 'x' as never)).toThrow();
  });

  it('compiles searched CASE with ordered bindings and derived domains', () => {
    const tier = caseWhen(gt(id, 10n), 'big').when(gt(id, 5n), 'mid').else('small');
    expect(select(t, { tier }).compile()).toMatchObject({
      sql: expect.stringContaining(
        'CASE WHEN ("ID" > ?) THEN ? WHEN ("ID" > ?) THEN ? ELSE ? END AS "tier"',
      ),
      binds: ['10', 'big', '5', 'mid', 'small'],
    });
    expect(tier.wireType).toBeUndefined();
    expect(tier.readSchema.safeParse(null).success).toBe(false);
    const open = caseWhen(gt(id, 10n), 'big');
    expect(open.readSchema.parse(null)).toBeNull();
    expect(open.when(gt(id, 1n), 'small').readSchema.parse(null)).toBeNull();
    const decimalCase = caseWhen(gt(id, 1n), amount).else('0');
    expect(decimalCase.wireType).toBe('decimal');
    expect(decimalCase.readSchema.safeParse(null).success).toBe(false);
    expect(select(t, { v: decimalCase }).compile().sql).toContain(
      'ELSE CAST(? AS NUMBER(38,0)) END',
    );
    const late = caseWhen(gt(id, 1n), 1n).else(id);
    expect(late.wireType).toBe('integer');
    expect(late.readSchema.parse('2')).toBe(2n);
    expect(select(t, { v: late }).compile().sql).toContain(
      'THEN CAST(? AS NUMBER(38,0)) ELSE "ID"',
    );
    expect(select(t, { v: caseWhen(gt(id, 1n), 1.5) }).compile().sql).toContain(
      'THEN CAST(? AS DOUBLE) END',
    );
    expect(caseWhen(gt(id, 1n), true).else(false).readSchema.parse(true)).toBe(true);
    expect(caseWhen(gt(id, 1n), price).else(amount).readSchema.parse(null)).toBeNull();
    expect(caseWhen(gt(count(), 1n), 'many').phase).toBe('aggregate');
    const scoped = caseWhen(isNull(o.columns.name), label).else('y');
    expect(scoped.refs).toEqual([o.ref, t.ref]);
    expect(scoped.nullRefs).toEqual([t.ref]);
    expect(() => caseWhen(gt(id, 1n), day).else(label)).toThrow(
      'CASE values must share one SQL domain.',
    );
    expect(() => caseWhen(gt(id, 1n), 'x').else(1n as never)).toThrow();
  });
});
