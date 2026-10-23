import { describe, expect, it } from 'vitest';
import {
  add,
  asc,
  avg,
  binary,
  boolean,
  caseWhen,
  cast,
  coalesce,
  concat,
  count,
  date,
  dateAdd,
  dateDiff,
  datePart,
  dateTrunc,
  decimal,
  denseRank,
  desc,
  div,
  eq,
  float,
  gt,
  inArray,
  integer,
  isNull,
  jsonPath,
  lag,
  lead,
  length,
  mul,
  rank,
  select,
  snowflakeTable,
  sub,
  substring,
  sum,
  text,
  time,
  timestamp,
  trim,
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
  clock: time('CLOCK').notNull(),
});
const o = snowflakeTable('O', { id: integer('ID').notNull(), name: text('NAME').notNull() });
const { id, name, label, amount, price, ratio, day, at, flag, json, data, clock } = t.columns;

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

describe('string and date helpers', () => {
  it('compiles text helpers with bound arguments and text domains', () => {
    const selection = {
      joined: concat(label, '-', name),
      tag: concat(label, 'x'),
      trimmed: trim(name),
      clean: trim(label),
      size: length(label),
      part: substring(label, 2, 3),
      tail: substring(name, -2),
    };
    const compiled = select(t, selection).compile();
    for (const fragment of [
      'CONCAT("LABEL", ?, "NAME")',
      'TRIM("NAME")',
      'LENGTH("LABEL")',
      'SUBSTR("LABEL", ?, ?)',
      'SUBSTR("NAME", ?)',
    ])
      expect(compiled.sql).toContain(fragment);
    expect(compiled.binds).toEqual(['-', 'x', 2, 3, -2]);
    expect(selection.size.wireType).toBe('integer');
    expect(
      resultSchema(selection).parse({
        joined: null,
        tag: 'ax',
        trimmed: null,
        clean: 'a',
        size: '3',
        part: 'bcd',
        tail: null,
      }),
    ).toMatchObject({ size: 3n });
    expect(() =>
      resultSchema(selection).parse({ ...selection, tag: null, clean: null, size: null }),
    ).toThrow();
    expect(concat(label, o.columns.name).refs).toEqual([t.ref, o.ref]);
    for (const invalid of [() => substring(label, 1.5), () => substring(label, 1, -1)])
      expect(invalid).toThrow('SUBSTR');
    expect(() => substring(label, 1, 0.5)).toThrow('SUBSTR');
    for (const invalid of [
      () => concat(label, day),
      () => trim(day),
      () => length(amount),
      () => substring(at, 1),
    ])
      expect(invalid).toThrow('String helpers require text expressions.');
  });

  it('models date part applicability and temporal result domains', () => {
    const selection = {
      month: dateTrunc('month', day),
      hour: dateTrunc('hour', at),
      minute: dateTrunc('minute', clock),
      tomorrow: dateAdd('day', 1n, day),
      later: dateAdd('hour', 1n, day),
      shifted: dateAdd('second', id, at),
      days: dateDiff('day', day, at),
      since: dateDiff('day', day, '2026-01-01'),
      hours: dateDiff('hour', day, day),
      year: datePart('year', day),
      nanos: datePart('nanosecond', clock),
    };
    const compiled = select(t, selection).compile();
    for (const fragment of [
      'DATE_TRUNC(MONTH, "DAY")',
      'DATE_TRUNC(HOUR, "AT_VALUE")',
      'DATEADD(DAY, CAST(? AS NUMBER(38,0)), "DAY")',
      'DATEADD(SECOND, "ID", "AT_VALUE")',
      'DATEDIFF(DAY, "DAY", CAST(? AS DATE))',
      'DATE_PART(YEAR, "DAY")',
    ])
      expect(compiled.sql).toContain(fragment);
    expect(compiled.binds).toEqual(['1', '1', '2026-01-01']);
    expect(Object.fromEntries(Object.entries(selection).map(([k, v]) => [k, v.wireType]))).toEqual({
      month: 'date',
      hour: 'timestamp_ntz',
      minute: 'time',
      tomorrow: 'date',
      later: 'timestamp_ntz',
      shifted: 'timestamp_ntz',
      days: 'integer',
      since: 'integer',
      hours: 'integer',
      year: 'integer',
      nanos: 'integer',
    });
    expect(selection.month.readSchema.safeParse(null).success).toBe(false);
    expect(selection.hour.readSchema.parse(null)).toBeNull();
    expect(selection.shifted.readSchema.parse(null)).toBeNull();
    expect(selection.days.readSchema.parse(null)).toBeNull();
    expect(selection.year.readSchema.parse('2026')).toBe(2026n);
    expect(() => dateTrunc('hour', day)).toThrow('The hour part does not apply to date values.');
    expect(() => dateTrunc('day', clock)).toThrow('The day part does not apply to time values.');
    expect(() => dateAdd('day', 1n, clock)).toThrow('does not apply to time values');
    expect(() => dateDiff('day', clock, clock)).toThrow('does not apply to time values');
    expect(() => datePart('hour', day)).toThrow('does not apply to date values');
    expect(() => datePart('millisecond' as never, at)).toThrow('DATE_PART');
    expect(() => dateTrunc('decade' as never, day)).toThrow('Unsupported date part: decade.');
    expect(() => dateTrunc('day', label)).toThrow('Date helpers require');
    expect(() => dateDiff('day', day, label)).toThrow('Date helpers require');
  });
});

describe('ranking and offset windows', () => {
  it('compiles ranking windows that require ordering', () => {
    const ranked = rank({ partitionBy: [name], orderBy: [desc(id)] });
    const dense = denseRank({ orderBy: [asc(amount)] });
    const query = select(t, { ranked, dense }).qualify(eq(ranked, 1n));
    expect(query.compile().sql).toContain(
      'RANK() OVER (PARTITION BY "NAME" ORDER BY "ID" DESC) AS "ranked"',
    );
    expect(query.compile().sql).toContain('DENSE_RANK() OVER (ORDER BY "AMOUNT" ASC) AS "dense"');
    expect(query.compile().sql).toContain('QUALIFY (RANK() OVER');
    expect(ranked).toMatchObject({ phase: 'window', wireType: 'integer', nullRefs: [] });
    expect(ranked.refs).toEqual([t.ref]);
    expect(resultSchema({ ranked }).parse({ ranked: '1' })).toEqual({ ranked: 1n });
    expect(() => resultSchema({ ranked }).parse({ ranked: null })).toThrow();
    expect(() => rank({} as never)).toThrow('RANK requires ORDER BY.');
    expect(() => denseRank({ orderBy: [] } as never)).toThrow('DENSE_RANK requires ORDER BY.');
  });

  it('binds LAG/LEAD offsets and defaults in the value domain', () => {
    const previous = lag(amount, { orderBy: [asc(id)] });
    const next = lead(amount, { partitionBy: [name], orderBy: [asc(id)], offset: 2, default: '0' });
    const compiled = select(t, { previous, next }).compile();
    expect(compiled.sql).toContain('LAG("AMOUNT", ?) OVER (ORDER BY "ID" ASC)');
    expect(compiled.sql).toContain(
      'LEAD("AMOUNT", ?, CAST(? AS NUMBER(38,0))) OVER (PARTITION BY "NAME" ORDER BY "ID" ASC)',
    );
    expect(compiled.binds).toEqual([1, 2, '0']);
    expect(previous).toMatchObject({ phase: 'window', wireType: 'decimal' });
    expect(previous.readSchema.parse(null)).toBeNull();
    expect(next.readSchema.safeParse(null).success).toBe(false);
    expect(lead(id, { orderBy: [asc(id)], default: id }).readSchema.safeParse(null).success).toBe(
      false,
    );
    expect(lag(price, { orderBy: [asc(id)], default: '0' }).readSchema.parse(null)).toBeNull();
    expect(lag(amount, { orderBy: [asc(id)], default: price }).readSchema.parse(null)).toBeNull();
    expect(lag(id, { orderBy: [asc(id)], offset: 0 }).expression).toMatchObject({
      value: { args: [{}, { kind: 'parameter', value: 0 }] },
    });
    const joined = select(t)
      .leftJoin(o, eq(t.columns.id, o.columns.id))
      .select({ prior: lag(o.columns.id, { orderBy: [asc(t.columns.id)], default: 0n }) });
    expect(joined.selection.prior.refs).toEqual([o.ref, t.ref]);
    expect(resultSchema(joined.selection, joined.nullableSources).parse({ prior: null })).toEqual({
      prior: null,
    });
    expect(
      select(t, { total: lag(sum(amount), { orderBy: [asc(name)] }) })
        .groupBy(name)
        .compile().sql,
    ).toContain('LAG(SUM("AMOUNT"), ?) OVER (ORDER BY "NAME" ASC)');
    expect(() => lag(day, { orderBy: [asc(id)], default: label })).toThrow(
      'LAG values must share one SQL domain.',
    );
    for (const value of [-1, 1.5])
      expect(() => lead(id, { orderBy: [asc(id)], offset: value })).toThrow('LEAD offset');
    expect(() => lag(id, {} as never)).toThrow('LAG requires ORDER BY.');
  });
});
