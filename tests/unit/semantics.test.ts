import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import type { ExpressionNode } from '../../src/ast.js';
import { type AnyExpression, expression, type Predicate } from '../../src/expressions.js';
import {
  add,
  and,
  array,
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
  deleteFrom,
  deleteUsing,
  desc,
  div,
  eq,
  float,
  geography,
  geometry,
  gt,
  gte,
  ilike,
  inArray,
  insertFrom,
  integer,
  isNull,
  jsonPath,
  lag,
  lead,
  length,
  like,
  lower,
  lt,
  matchRecognize,
  max,
  mergeInto,
  min,
  mul,
  ne,
  not,
  object,
  or,
  over,
  pivot,
  rank,
  recursiveCte,
  rowNumber,
  rowPattern,
  select,
  snowflakeTable,
  sum,
  text,
  time,
  timestamp,
  unpivot,
  update,
  updateFrom,
  upper,
  variant,
  vector,
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

  it('applies Snowflake rules for semi-structured, spatial, and VECTOR types', () => {
    const s = snowflakeTable('S', {
      list: array('LIST'),
      doc: object('DOC'),
      place: geography('PLACE'),
      shape: geometry('SHAPE'),
      embedding: vector('EMBEDDING', 'int', 2),
      json: variant('JSON'),
    });
    const d = s.columns;
    expect(eq(d.list, d.json).dataType).toBe('boolean');
    expect(eq(d.doc, d.json).dataType).toBe('boolean');
    expect(eq(d.embedding, d.embedding).dataType).toBe('boolean');
    expect(jsonPath(d.list, 0).dataType).toBe('variant');
    expect(jsonPath(d.doc, 'a').dataType).toBe('variant');
    expect(
      select(s, { list: d.list, n: count() }).groupBy(d.list).orderBy(asc(d.list)).compile().sql,
    ).toContain('GROUP BY "LIST" ORDER BY "list" ASC');
    expect(() => eq(d.list, loose(d.doc))).toThrow('Cannot compare ARRAY with OBJECT expressions.');
    expect(() => eq(d.list, loose(text('NAME')))).toThrow(
      'Cannot compare ARRAY with TEXT expressions.',
    );
    expect(() => eq(loose(d.place), loose(d.place))).toThrow(
      'Cannot compare GEOGRAPHY with GEOGRAPHY expressions.',
    );
    expect(eq(d.place, null).expression).toMatchObject({ operator: 'IS NULL' });
    expect(() => lt(loose(d.shape), loose({ type: 'Point', coordinates: [0, 0] }))).toThrow(
      '< does not accept GEOMETRY',
    );
    expect(() => eq(loose(d.json), loose(d.place))).toThrow(
      'Cannot compare VARIANT with GEOGRAPHY expressions.',
    );
    expect(() => inArray(loose(d.place), [])).toThrow('IN does not accept GEOGRAPHY');
    for (const [value, type] of [
      [d.list, 'ARRAY'],
      [d.doc, 'OBJECT'],
      [d.embedding, 'VECTOR'],
      [d.shape, 'GEOMETRY'],
    ] as const) {
      expect(() => min(loose(value))).toThrow(`MIN does not accept ${type} expressions.`);
      expect(() => max(loose(value))).toThrow(`MAX does not accept ${type} expressions.`);
    }
    expect(() => jsonPath(loose(d.embedding), 0)).toThrow(
      'JSON path access does not accept VECTOR',
    );
    expect(() => asc(loose(d.place))).toThrow('ORDER BY does not accept GEOGRAPHY');
    expect(() => desc(loose(d.shape))).toThrow('ORDER BY does not accept GEOMETRY');
    expect(() => select(s).groupBy(loose(d.place))).toThrow('GROUP BY does not accept GEOGRAPHY');
    expect(() => rowNumber({ partitionBy: [loose(d.shape)] })).toThrow(
      'PARTITION BY does not accept GEOMETRY',
    );
    expect(() => update(s, { list: loose(d.doc) })).toThrow(
      'Cannot assign a OBJECT expression to ARRAY column list.',
    );
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
    const helpers = {
      sum: add(c.id, 1n),
      choice: caseWhen(gt(c.ratio, 1), c.name).else('other'),
      year: datePart('year', c.day),
      n: count(),
    };
    expect(select(t, helpers).groupBy(c.id, c.ratio, c.name, c.day).compile().sql).toContain(
      'CASE WHEN',
    );
    for (const ungrouped of [c.id, c.ratio, c.name, c.day])
      expect(() =>
        select(t, helpers)
          .groupBy(...[c.id, c.ratio, c.name, c.day].filter((key) => key !== ungrouped))
          .compile(),
      ).toThrow(`"T"."${ungrouped.node.parts.at(-1)}" must appear in GROUP BY`);
    expect(select(t, { total: caseWhen(gt(count(), 1n), sum(c.amount)) }).compile().sql).toContain(
      'CASE WHEN',
    );
    const unknown = node({ kind: 'unknown' } as unknown as ExpressionNode, []);
    expect(() => select(t, { unknown, n: count() }).compile()).toThrow(
      'Unsupported expression AST node.',
    );
  });
});

describe('expression helpers', () => {
  it('derive SQL types from their inputs', () => {
    expect(add(c.id, 1n).dataType).toBe('integer');
    expect(add(c.id, c.amount).dataType).toBe('decimal');
    expect(div(c.id, c.id).dataType).toBe('decimal');
    expect(mul(c.ratio, 2).dataType).toBe('float');
    expect(avg(c.ratio).dataType).toBe('float');
    expect(avg(c.id).dataType).toBe('decimal');
    expect(cast(c.name, 'date').dataType).toBe('date');
    expect(cast(c.name, 'decimal', 10, 2).dataType).toBe('decimal');
    expect(concat(c.name, 'x').dataType).toBe('text');
    expect(length(c.name).dataType).toBe('integer');
    expect(dateAdd('day', 1n, c.day).dataType).toBe('date');
    expect(dateAdd('hour', 1n, c.day).dataType).toBe('timestamp_ntz');
    expect(dateDiff('day', c.day, c.tz).dataType).toBe('integer');
    expect(caseWhen(c.active, 'a').dataType).toBe('text');
    expect(caseWhen(c.active, c.day).else(c.day).dataType).toBe('date');
    expect(coalesce(c.day, '2024-01-01').dataType).toBe('date');
    expect(rank({ orderBy: [asc(c.id)] }).dataType).toBe('integer');
    expect(lag(c.day, { orderBy: [asc(c.id)] }).dataType).toBe('date');
    expect(lt(add(c.id, 1n), c.amount).dataType).toBe('boolean');
  });

  it('tag aggregate and window functions and keep windows out of them', () => {
    expect(avg(c.amount).expression).toMatchObject({ name: 'AVG', role: 'aggregate' });
    expect(rank({ orderBy: [asc(c.id)] }).expression).toMatchObject({
      value: { name: 'RANK', role: 'window' },
    });
    expect(lead(c.id, { orderBy: [asc(c.id)] }).expression).toMatchObject({
      value: { name: 'LEAD', role: 'window' },
    });
    const ranked = rank({ orderBy: [asc(c.id)] });
    expect(() => avg(loose(ranked))).toThrow('Window functions cannot be nested inside AVG.');
    expect(() => lag(ranked, { orderBy: [asc(c.id)] })).toThrow(
      'Window functions cannot be nested inside LAG.',
    );
    expect(() => lead(c.id, { orderBy: [asc(c.id)], default: loose(ranked) })).toThrow(
      'Window functions cannot be nested inside LEAD.',
    );
  });

  it('reject values from different SQL types that share a TypeScript type', () => {
    expect(() => coalesce(c.name, loose(c.day))).toThrow(
      'COALESCE values must share one SQL domain.',
    );
    expect(() => coalesce(c.data, loose(binary('OTHER').notNull()))).not.toThrow();
    expect(() => caseWhen(c.active, c.name).else(loose(c.day))).toThrow('CASE values must share');
    expect(() => caseWhen(loose(c.flag), 1n)).toThrow('CASE WHEN requires a BOOLEAN predicate');
    expect(() => caseWhen(c.active, 1n).when(loose(c.id), 2n)).toThrow('CASE WHEN requires');
    expect(() => lag(c.name, { orderBy: [asc(c.id)], default: loose(c.day) })).toThrow(
      'LAG values must share one SQL domain.',
    );
    expect(() => concat(c.name, loose(c.json))).toThrow('String helpers require text');
    expect(() => dateTrunc('day', loose(c.json))).toThrow('Date helpers require');
    expect(() => dateAdd('day', loose(c.amount), c.day)).toThrow(
      'dateAdd amounts must be integer expressions.',
    );
  });

  it('check BOOLEAN predicates and SQL types in sourced writes', () => {
    const flag = loose(c.flag);
    const on = eq(c.id, u.columns.id);
    expect(() => updateFrom(t, u, flag, { name: u.columns.name })).toThrow(
      'UPDATE FROM requires a BOOLEAN predicate',
    );
    expect(() => deleteUsing(t, u, flag)).toThrow('DELETE USING requires a BOOLEAN predicate');
    expect(() => updateFrom(t, u, on, { name: u.columns.name }).where(flag)).toThrow(
      'WHERE requires a BOOLEAN predicate',
    );
    expect(() => mergeInto(t, u, on).whenMatchedDelete(flag)).toThrow(
      'MERGE branch requires a BOOLEAN predicate',
    );
    expect(() => updateFrom(t, u, on, { day: loose(u.columns.name) })).toThrow(
      'Cannot assign a TEXT expression to DATE column day.',
    );
    const source = select(u, { id: u.columns.id, day: u.columns.name });
    expect(() => insertFrom(t, loose(source))).toThrow(
      'Cannot assign a TEXT expression to DATE column day.',
    );
    expect(
      insertFrom(t, select(u, { id: u.columns.id, name: u.columns.name })).compile().sql,
    ).toContain('INSERT INTO "T" ("ID", "NAME") SELECT');
  });

  it('keep SQL types through set operations', () => {
    const days = select(t, { value: c.day }).union(select(t, { value: c.day }));
    expect(days.columns.value.dataType).toBe('date');
    expect(days.as('S').columns.value.dataType).toBe('date');
    expect(lt(days.columns.value, c.tz).dataType).toBe('boolean');
    expect(() => eq(days.columns.value, loose(c.name))).toThrow(
      'Cannot compare DATE with TEXT expressions.',
    );
    expect(() => select(t, { value: c.name }).union(loose(select(t, { value: c.active })))).toThrow(
      'Set operation column value combines different domains: TEXT and BOOLEAN.',
    );
    expect(() => select(t, { value: c.id }).except(loose(select(t, { value: c.amount })))).toThrow(
      'INTEGER and DECIMAL',
    );
  });

  it('keep SQL types through recursive CTEs', () => {
    const anchor = select(t, { id: c.id, day: c.day }).where(eq(c.id, 1n));
    const days = recursiveCte('DAYS', anchor, (self) =>
      select(self, { id: add(self.columns.id, 1n), day: self.columns.day }).where(
        lt(self.columns.id, 3n),
      ),
    );
    expect(days.columns.day.dataType).toBe('date');
    expect(lt(days.columns.day, c.tz).dataType).toBe('boolean');
    expect(() =>
      recursiveCte('BAD', anchor, (self) =>
        loose(select(self, { id: self.columns.id, day: cast(self.columns.day, 'timestamp_ntz') })),
      ),
    ).toThrow('Set operation column day combines different domains: DATE and TIMESTAMP_NTZ.');
  });

  it('keep SQL types through PIVOT and UNPIVOT', () => {
    const sales = snowflakeTable('SALES', {
      region: text('REGION'),
      quarter: text('QUARTER').notNull(),
      amount: decimal('AMOUNT'),
      ratio: float('RATIO'),
      day: date('DAY'),
      tags: array('TAGS'),
    });
    const totals = pivot(sales, 'P', {
      aggregate: 'sum',
      value: 'amount',
      for: 'quarter',
      in: { q1: 'Q1' },
    });
    expect(totals.columns.q1.dataType).toBe('decimal');
    expect(totals.columns.day.dataType).toBe('date');
    const latest = pivot(sales, 'L', {
      aggregate: 'max',
      value: 'day',
      for: 'quarter',
      in: { q1: 'Q1' },
    });
    expect(latest.columns.q1.dataType).toBe('date');
    expect(lt(latest.columns.q1, c.tz).dataType).toBe('boolean');
    expect(
      pivot(sales, 'N', { aggregate: 'count', value: 'day', for: 'quarter', in: { q1: 'Q1' } })
        .columns.q1.dataType,
    ).toBe('integer');
    expect(() =>
      pivot(sales, 'A', { aggregate: 'min', value: 'tags', for: 'quarter', in: { q1: 'Q1' } }),
    ).toThrow('MIN does not accept ARRAY expressions.');
    expect(() =>
      pivot(sales, 'D', { aggregate: 'sum', value: 'day', for: 'quarter', in: { q1: 'Q1' } }),
    ).toThrow('PIVOT sum requires a numeric value column.');
    const dates = snowflakeTable('DATES', {
      id: integer('ID').notNull(),
      a: date('A'),
      b: date('B'),
    });
    const rows = unpivot(dates, 'U', { value: 'day', for: 'slot', in: ['a', 'b'] });
    expect(rows.columns.day.dataType).toBe('date');
    expect(rows.columns.slot.dataType).toBe('text');
    expect(() => unpivot(sales, 'X', { value: 'n', for: 'slot', in: ['amount', 'ratio'] })).toThrow(
      'UNPIVOT columns must share one type.',
    );
  });

  it('keep SQL types through MATCH_RECOGNIZE', () => {
    const prices = snowflakeTable('PRICES', {
      company: text('COMPANY').notNull(),
      day: date('DAY').notNull(),
      price: decimal('PRICE').notNull(),
      flag: variant('FLAG'),
      place: geography('PLACE'),
    });
    const up = rowPattern.variable('up');
    const matched = matchRecognize(prices, 'M', {
      partitionBy: ['company'],
      orderBy: (row) => [asc(row.day)],
      pattern: rowPattern.oneOrMore(up),
      define: ({ row, lag }) => ({ up: gt(row.price, lag(row.price)) }),
      measures: ({ row, vars, last, count, classifier }) => ({
        lastDay: last(row.day),
        peak: last(vars.up.price),
        n: count(),
        label: classifier(),
      }),
    });
    expect(matched.columns.lastDay.dataType).toBe('date');
    expect(matched.columns.peak.dataType).toBe('decimal');
    expect(matched.columns.n.dataType).toBe('integer');
    expect(matched.columns.label.dataType).toBe('text');
    expect(lt(matched.columns.lastDay, c.tz).dataType).toBe('boolean');
    expect(() =>
      matchRecognize(prices, 'B', {
        orderBy: (row) => [asc(row.day)],
        pattern: up,
        define: ({ row }) => ({ up: loose(row.flag) }),
        measures: ({ count }) => ({ n: count() }),
      }),
    ).toThrow('DEFINE requires a BOOLEAN predicate, not VARIANT.');
    expect(() =>
      matchRecognize(prices, 'G', {
        partitionBy: loose(['place']),
        orderBy: (row) => [asc(row.day)],
        pattern: up,
        measures: ({ count }) => ({ n: count() }),
      }),
    ).toThrow('PARTITION BY does not accept GEOGRAPHY expressions.');
  });
});
