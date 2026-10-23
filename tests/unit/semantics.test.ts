import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import type { ExpressionNode } from '../../src/ast.js';
import { type AnyExpression, expression, type Predicate } from '../../src/expressions.js';
import {
  and,
  asc,
  binary,
  boolean,
  count,
  date,
  decimal,
  deleteFrom,
  desc,
  eq,
  float,
  gt,
  gte,
  ilike,
  inArray,
  integer,
  isNull,
  jsonPath,
  like,
  lower,
  lt,
  max,
  mergeInto,
  min,
  ne,
  not,
  or,
  over,
  rowNumber,
  select,
  snowflakeTable,
  sum,
  text,
  time,
  timestamp,
  update,
  upper,
  variant,
} from '../../src/index.js';

const t = snowflakeTable('T', {
  id: integer('ID').notNull(),
  amount: decimal('AMOUNT'),
  ratio: float('RATIO'),
  name: text('NAME'),
  active: boolean('ACTIVE'),
  day: date('DAY'),
  clock: time('CLOCK'),
  ntz: timestamp('NTZ'),
  tz: timestamp('TZ', 'tz'),
  data: binary('DATA'),
  json: variant('JSON'),
  flag: variant('FLAG', z.boolean()),
});
const u = snowflakeTable('U', { id: integer('ID').notNull(), name: text('NAME') });
const c = t.columns;
const loose = (value: unknown) => value as AnyExpression as never;

describe('SQL type domains', () => {
  it('records the SQL type of columns and derived expressions', () => {
    expect([c.id, c.amount, c.ratio, c.name, c.active].map((value) => value.dataType)).toEqual([
      'integer',
      'decimal',
      'float',
      'text',
      'boolean',
    ]);
    expect([c.day, c.clock, c.ntz, c.tz, c.data, c.json].map((value) => value.dataType)).toEqual([
      'date',
      'time',
      'timestamp_ntz',
      'timestamp_tz',
      'binary',
      'variant',
    ]);
    expect(c.name.notNull().dataType).toBe('text');
    expect(count().dataType).toBe('integer');
    expect(sum(c.id).dataType).toBe('decimal');
    expect(sum(c.ratio).dataType).toBe('float');
    expect(min(c.day).dataType).toBe('date');
    expect(over(max(c.tz)).dataType).toBe('timestamp_tz');
    expect(rowNumber().dataType).toBe('integer');
    expect(upper(c.name).dataType).toBe('text');
    expect(jsonPath(c.json, 'a').dataType).toBe('variant');
    expect(eq(c.id, 1n).dataType).toBe('boolean');
    const derived = select(t, { total: sum(c.amount), day: min(c.day) })
      .groupBy(c.name)
      .as('D');
    expect(derived.columns.total.dataType).toBe('decimal');
    expect(derived.columns.day.dataType).toBe('date');
  });

  it('compares numeric, date-time, and VARIANT values across representations', () => {
    const predicates = [
      eq(c.id, c.amount),
      lt(c.amount, c.ratio),
      gte(c.day, c.ntz),
      gt(c.ntz, c.tz),
      eq(jsonPath(c.json, 'name'), c.name),
      eq(c.name, jsonPath(c.json, 'name')),
      ne(c.data, c.data),
    ];
    expect(predicates.every((value) => value.dataType === 'boolean')).toBe(true);
  });

  it.each([
    [c.name, c.day, 'Cannot compare TEXT with DATE'],
    [c.clock, c.ntz, 'Cannot compare TIME with TIMESTAMP_NTZ'],
    [c.data, c.name, 'Cannot compare BINARY with TEXT'],
    [c.active, c.name, 'Cannot compare BOOLEAN with TEXT'],
    [c.amount, c.name, 'Cannot compare DECIMAL with TEXT'],
  ])('rejects comparing incompatible SQL types at runtime', (left, right, message) => {
    expect(() => eq(left, loose(right))).toThrow(message);
  });

  it('encodes literals compared with JSON paths as VARIANT values', () => {
    const path = jsonPath(c.json, 'a');
    expect(select(t, { id: c.id }).where(eq(path, 'x')).compile()).toMatchObject({
      sql: expect.stringContaining('(GET("JSON", ?) = PARSE_JSON(?))'),
      binds: ['a', '"x"'],
    });
    expect(inArray(path, [1, null]).expression).toMatchObject({
      values: [
        { name: 'PARSE_JSON', args: [{ value: '1' }] },
        { name: 'PARSE_JSON', args: [{ value: null }] },
      ],
    });
    expect(eq(path, null).expression).toMatchObject({ operator: 'IS NULL' });
    expect(() => eq(path, undefined)).toThrow('JSON serializable');
    expect(() => jsonPath(loose(c.name), 'a')).toThrow(
      'JSON path access does not accept TEXT expressions.',
    );
  });

  it('keeps column encoders for aggregate and window comparisons', () => {
    const bytes = new Uint8Array([1, 2]);
    expect(eq(min(c.data), bytes).expression).toMatchObject({ right: { name: 'TO_BINARY' } });
    expect(eq(over(max(c.data)), bytes).expression).toMatchObject({
      right: { name: 'TO_BINARY' },
    });
    expect(inArray(min(c.data), [null]).expression).toMatchObject({
      values: [{ kind: 'parameter', value: null }],
    });
  });

  it('restricts string and numeric functions to compatible SQL types', () => {
    expect(like(c.name, 'a%').expression).toMatchObject({ right: { value: 'a%' } });
    expect(ilike(variant('V', z.string()), 'a%').expression).toMatchObject({
      operator: 'ILIKE',
    });
    expect(lower(variant('V', z.string())).dataType).toBe('text');
    expect(() => like(loose(c.day), '2024%')).toThrow('LIKE does not accept DATE expressions.');
    expect(() => ilike(loose(c.amount), '1%')).toThrow('ILIKE does not accept DECIMAL');
    expect(() => like(c.name, loose(1))).toThrow();
    expect(() => lower(loose(c.ntz))).toThrow('LOWER does not accept TIMESTAMP_NTZ');
    expect(() => upper(loose(c.id))).toThrow('UPPER does not accept INTEGER');
    expect(() => sum(loose(c.name))).toThrow('SUM does not accept TEXT');
    expect(() => sum(loose(c.day))).toThrow('SUM does not accept DATE');
  });

  it('requires BOOLEAN predicates in every predicate position', () => {
    const flag = c.flag as unknown as Predicate<'T'>;
    expect(() => and(flag)).toThrow('AND requires a BOOLEAN predicate, not VARIANT.');
    expect(() => or(eq(c.id, 1n), flag)).toThrow('OR requires a BOOLEAN predicate');
    expect(() => not(flag)).toThrow('NOT requires a BOOLEAN predicate');
    expect(() => select(t).where(flag)).toThrow('WHERE requires a BOOLEAN predicate');
    expect(() => select(t).having(flag)).toThrow('HAVING requires a BOOLEAN predicate');
    expect(() => select(t).qualify(flag)).toThrow('QUALIFY requires a BOOLEAN predicate');
    expect(() => select(t).innerJoin(u, loose(c.flag))).toThrow('JOIN requires a BOOLEAN');
    expect(() => deleteFrom(t).where(flag)).toThrow('WHERE requires a BOOLEAN predicate');
    expect(() => mergeInto(t, u, loose(c.flag))).toThrow('MERGE requires a BOOLEAN');
    expect(
      select(t)
        .where(and(c.active, not(c.active)))
        .compile().sql,
    ).toContain('WHERE ("ACTIVE" AND (NOT "ACTIVE"))');
  });
});

describe('aggregate and window placement', () => {
  it('rejects nested window functions when expressions are built', () => {
    expect(() => count(rowNumber())).toThrow('Window functions cannot be nested inside COUNT.');
    expect(() => sum(over(sum(c.id)))).toThrow('nested inside SUM');
    expect(() => min(rowNumber())).toThrow('nested inside MIN');
    expect(() => over(rowNumber())).toThrow('OVER requires an aggregate or window function.');
    expect(() => over(c.id)).toThrow('OVER requires');
    expect(() => over(lower(c.name))).toThrow('OVER requires');
    expect(() => over(count(), { partitionBy: [rowNumber()] })).toThrow(
      'Window functions cannot be nested inside another window.',
    );
    expect(() => rowNumber({ orderBy: [asc(rowNumber())] })).toThrow('inside another window');
  });

  it('requires scalar ASOF match conditions and mutation values', () => {
    expect(() => select(t).asofJoin(u, gte(count(), 1n))).toThrow(
      'Join predicates must be scalar.',
    );
    expect(() => update(t, { id: count() })).toThrow(
      'Mutation values cannot contain aggregate or window functions.',
    );
    expect(() => update(t, { id: rowNumber() })).toThrow('Mutation values cannot contain');
    expect(() =>
      mergeInto(t, u, eq(c.id, u.columns.id)).whenNotMatchedInsert({
        id: loose(max(u.columns.id)),
      }),
    ).toThrow('Mutation values cannot contain');
  });

  it('checks mutation assignments against the target column type', () => {
    expect(() => update(t, { day: loose(c.name) })).toThrow(
      'Cannot assign a TEXT expression to DATE column day.',
    );
    expect(() =>
      mergeInto(t, u, eq(c.id, u.columns.id)).whenMatchedUpdate({ day: loose(u.columns.name) }),
    ).toThrow('Cannot assign a TEXT expression to DATE column day.');
    expect(update(t, { ratio: loose(c.id), json: loose(c.name) }).compile().sql).toBe(
      'UPDATE "T" SET "RATIO" = "ID", "JSON" = "NAME"',
    );
  });
});

describe('grouping rules', () => {
  const grouped = select(t, { name: c.name, total: count() }).groupBy(c.name);

  it('accepts grouping keys, expressions over keys, aggregates, and windows over groups', () => {
    const query = select(t, {
      name: c.name,
      lowered: lower(c.name),
      flagged: isNull(c.name),
      total: count(),
      share: over(sum(count())),
      rank: rowNumber({ orderBy: [desc(count())] }),
    })
      .groupBy(c.name)
      .having(and(gt(count(), 1n), not(isNull(c.name))))
      .qualify(eq(rowNumber({ partitionBy: [c.name], orderBy: [asc(max(c.id))] }), 1n))
      .orderBy(asc(lower(c.name)), desc(sum(c.amount)));
    expect(query.compile().sql).toContain('SUM(COUNT(*)) OVER ()');
    expect(select(t, { total: count() }).having(gt(count(), 0n)).compile().sql).toContain(
      'HAVING (COUNT(*) > ?)',
    );
    expect(select(t, { id: c.id }).having(gt(c.id, 0n)).compile().sql).toContain('HAVING');
    expect(
      select(t, { key: lower(c.name), total: count() })
        .groupBy(lower(c.name))
        .compile().sql,
    ).toContain('GROUP BY LOWER("NAME")');
    expect(
      select(t, { matched: inArray(c.id, [1n]), n: count() })
        .groupBy(inArray(c.id, [1n]))
        .compile().binds,
    ).toEqual(['1', '1']);
  });

  it('rejects ungrouped columns in each grouped clause', () => {
    expect(() => select(t).groupBy(c.name).compile()).toThrow(
      '"T"."ID" must appear in GROUP BY or inside an aggregate function.',
    );
    expect(() => select(t, { id: c.id, total: count() }).compile()).toThrow('"T"."ID" must');
    expect(() => grouped.having(gt(c.id, 1n)).compile()).toThrow('"T"."ID" must');
    expect(() => grouped.orderBy(asc(c.id)).compile()).toThrow('"T"."ID" must');
    expect(() =>
      grouped
        .select({ total: count(), rank: rowNumber({ orderBy: [asc(c.id)] }) })
        .qualify(eq(rowNumber({ orderBy: [asc(c.id)] }), 1n))
        .compile(),
    ).toThrow('"T"."ID" must');
    expect(() => grouped.select({ running: over(sum(c.id)) }).compile()).toThrow('"T"."ID" must');
    expect(() =>
      select(t, { name: c.name, total: count() }).groupBy(lower(c.name)).compile(),
    ).toThrow('"T"."NAME" must');
    expect(() =>
      select(t, { matched: inArray(c.id, [2n]), n: count() })
        .groupBy(inArray(c.id, [1n]))
        .compile(),
    ).toThrow('"T"."ID" must');
    expect(() => select(t, { n: count() }).orderBy(asc(c.id)).as('D')).toThrow('"T"."ID" must');
  });

  it('rejects nested aggregates and checks window ordering in grouped queries', () => {
    expect(() => select(t, { total: sum(count()) }).compile()).toThrow(
      'Aggregate functions cannot be nested without OVER.',
    );
    expect(() => select(t, { total: max(and(gt(min(c.id), 1n))) }).compile()).toThrow(
      'cannot be nested',
    );
    expect(grouped.orderBy(desc(rowNumber({ orderBy: [desc(count())] }))).compile().sql).toContain(
      'ROW_NUMBER() OVER (ORDER BY COUNT(*) DESC) AS "__sflib_order_0"',
    );
    expect(() => grouped.orderBy(desc(rowNumber({ orderBy: [asc(c.id)] }))).compile()).toThrow(
      '"T"."ID" must',
    );
    const rank = rowNumber({ orderBy: [asc(c.name)] });
    const names = select(t, { name: c.name }).groupBy(c.name);
    expect(() => names.orderBy(desc(rank)).compile()).toThrow(
      'Grouped queries must project window functions used in ORDER BY.',
    );
    expect(
      names
        .select({ name: c.name, active: c.active })
        .groupBy(c.name, c.active)
        .orderBy(asc(c.name))
        .compile().sql,
    ).toContain('ORDER BY "name" ASC');
    expect(names.select({ name: c.name, rank }).orderBy(desc(rank)).compile().sql).toContain(
      'ORDER BY "__sflib_result"."rank" DESC',
    );
    expect(select(t, { id: c.id }).orderBy(desc(rowNumber())).compile().sql).toContain(
      'ROW_NUMBER() OVER ()',
    );
  });

  it('walks every expression node kind', () => {
    const node = (value: ExpressionNode, refs = [t.ref]) =>
      expression(value, z.string(), { dataType: 'text', refs });
    const cast = node({ kind: 'cast', value: c.id.expression, target: 'VARCHAR' });
    expect(select(t, { id: cast, n: count() }).groupBy(c.id).compile().sql).toContain(
      'CAST("ID" AS VARCHAR)',
    );
    expect(() => select(t, { id: cast, n: count() }).compile()).toThrow('"T"."ID" must');
    expect(() => select(t, { raw: loose(text('RAW')), n: count() }).compile()).toThrow(
      '"RAW" must appear in GROUP BY',
    );
    const literal = node({ kind: 'parameter', value: 'x' }, []);
    expect(select(t, { literal, n: count() }).compile().binds).toEqual(['x']);
    expect(
      select(t, { path: jsonPath(c.json, 'a'), n: count() })
        .groupBy(c.json)
        .compile().sql,
    ).toContain('GET(');
    const unknown = node({ kind: 'unknown' } as unknown as ExpressionNode, []);
    expect(() => select(t, { unknown, n: count() }).compile()).toThrow(
      'Unsupported expression AST node.',
    );
  });
});
