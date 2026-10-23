import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import { compileAst, identifier, type PivotNode, type SelectNode } from '../../src/ast.js';
import {
  boolean,
  date,
  decimal,
  dynamicPivot,
  eq,
  flatten,
  float,
  integer,
  pivot,
  select,
  snowflakeTable,
  sql,
  text,
  unpivot,
  variant,
} from '../../src/index.js';
import { resultSchema } from '../../src/schema.js';

const sales = snowflakeTable('SALES', {
  id: integer('ID').notNull(),
  region: text('REGION'),
  quarter: text('QUARTER').notNull(),
  amount: decimal('AMOUNT'),
  day: date('DAY').notNull(),
});
const months = snowflakeTable('MONTHS', {
  id: integer('ID').notNull(),
  jan: integer('JAN').notNull(),
  feb: integer('FEB'),
});
const input =
  'SELECT "ID" AS "id", "REGION" AS "region", "QUARTER" AS "quarter", "AMOUNT" AS "amount", "DAY" AS "day" FROM "SALES"';

describe('PIVOT', () => {
  const totals = pivot(sales, 'P', {
    aggregate: 'sum',
    value: 'amount',
    for: 'quarter',
    in: { q1: 'Q1', q2: "it's \\ odd" },
  });

  it('compiles declared values as escaped literals with aliased output columns', () => {
    expect(select(totals, { id: totals.columns.id, q1: totals.columns.q1 }).compile()).toEqual({
      sql: `SELECT TO_VARCHAR("__sflib_result"."id") AS "id", TO_VARCHAR("__sflib_result"."q1") AS "q1" FROM (SELECT "id" AS "id", "q1" AS "q1" FROM (${input}) PIVOT (SUM("amount") FOR "quarter" IN ('Q1', 'it''s \\\\ odd')) AS "P" ("id", "region", "day", "q1", "q2")) AS "__sflib_result"`,
      binds: [],
    });
    expect(Object.keys(totals.columns)).toEqual(['id', 'region', 'day', 'q1', 'q2']);
  });

  it('renders numeric and boolean literals and binds the default', () => {
    const flags = snowflakeTable('FLAGS', {
      on: boolean('ON').notNull(),
      ratio: float('RATIO').notNull(),
      id: integer('ID').notNull(),
      n: integer('N').notNull(),
    });
    const byFlag = pivot(flags, 'F', {
      aggregate: 'max',
      value: 'n',
      for: 'on',
      in: { yes: true, no: false },
      default: 0n,
    });
    expect(compileAst(select(byFlag).ast).sql).toContain(
      'PIVOT (MAX("n") FOR "on" IN (TRUE, FALSE) DEFAULT ON NULL (?)) AS "F" ("ratio", "id", "yes", "no")',
    );
    expect(compileAst(select(byFlag).ast).binds).toEqual(['0']);
    const byRatio = pivot(flags, 'R', {
      aggregate: 'count',
      value: 'n',
      for: 'ratio',
      in: { half: 0.5 },
    });
    expect(compileAst(select(byRatio).ast).sql).toContain('IN (0.5)) AS "R" ("on", "id", "half")');
    const byId = pivot(flags, 'I', { aggregate: 'min', value: 'n', for: 'id', in: { one: 1n } });
    expect(compileAst(select(byId).ast).sql).toContain(`IN ('1')) AS "I" ("on", "ratio", "one")`);
  });

  it('derives nullability and domains from the aggregate and default', () => {
    expect(
      resultSchema(totals.columns).parse({
        id: '1',
        region: null,
        day: '2024-01-01',
        q1: '10.5',
        q2: null,
      }),
    ).toEqual({ id: 1n, region: null, day: '2024-01-01', q1: '10.5', q2: null });
    const counts = pivot(sales, 'C', {
      aggregate: 'count',
      value: 'amount',
      for: 'quarter',
      in: { q1: 'Q1' },
    });
    expect(counts.columns.q1.wireType).toBe('integer');
    expect(counts.columns.q1.dataType).toBe('integer');
    expect(counts.columns.q1.readSchema.parse('3')).toBe(3n);
    expect(() => counts.columns.q1.readSchema.parse(null)).toThrow();
    const latest = pivot(sales, 'L', {
      aggregate: 'max',
      value: 'day',
      for: 'quarter',
      in: { q1: 'Q1' },
      default: '1970-01-01',
    });
    expect(latest.columns.q1.required).toBe(true);
    expect(latest.columns.q1.dataType).toBe('date');
    expect(() => latest.columns.q1.readSchema.parse(null)).toThrow('non-null');
    expect(() => select(latest).where(eq(latest.columns.q1, null as never))).toThrow();
    expect(compileAst(select(latest).ast).binds).toEqual(['1970-01-01']);
    const names = pivot(sales, 'N', {
      aggregate: 'min',
      value: 'region',
      for: 'quarter',
      in: { q1: 'Q1' },
    });
    expect(names.columns.q1.wireType).toBeUndefined();
    expect(names.columns.q1.readSchema.parse(null)).toBeNull();
    expect(totals.columns.q1.dataType).toBe('decimal');
  });

  it('keeps output columns usable in predicates and nullability assertions', () => {
    const query = select(totals).where(eq(totals.columns.q1, '5'));
    expect(query.compile().binds).toEqual(['5']);
    expect(query.compile().sql).toContain('WHERE ("q1" = ?)');
    const q1 = totals.columns.q1.notNull();
    expect(q1.required).toBe(true);
    expect(() => q1.readSchema.parse(null)).toThrow();
    const region = totals.columns.region.notNull();
    expect(region.required).toBe(true);
    expect(compileAst(select(totals, { region }).ast).sql).toContain('"region" AS "region"');
    expect(() => region.readSchema.parse(null)).toThrow();
  });

  it('composes with joins, derived queries, and CTE sources', () => {
    const joined = select(sales)
      .leftJoin(totals, eq(sales.columns.id, totals.columns.id))
      .select({ id: sales.columns.id, q1: totals.columns.q1 });
    expect(compileAst(joined.ast).sql).toContain(
      `SELECT "SALES"."ID" AS "id", "P"."q1" AS "q1" FROM "SALES" LEFT JOIN (${input}) PIVOT (SUM("amount") FOR "quarter" IN ('Q1', 'it''s \\\\ odd')) AS "P" ("id", "region", "day", "q1", "q2") ON ("SALES"."ID" = "P"."id")) AS "__sflib_result"`,
    );
    expect(
      resultSchema(joined.selection, joined.nullableSources).parse({ id: '1', q1: null }),
    ).toEqual({
      id: 1n,
      q1: null,
    });
    const derived = select(sales, {
      quarter: sales.columns.quarter,
      amount: sales.columns.amount,
    }).as('S');
    const narrow = pivot(derived, 'P', {
      aggregate: 'sum',
      value: 'amount',
      for: 'quarter',
      in: { q1: 'Q1' },
    });
    expect(compileAst(select(narrow).ast).sql).toContain(
      'SELECT "q1" AS "q1" FROM (SELECT "S"."quarter" AS "quarter", "S"."amount" AS "amount" FROM (SELECT "QUARTER" AS "quarter", "AMOUNT" AS "amount" FROM "SALES") AS "S") PIVOT (SUM("amount") FOR "quarter" IN (\'Q1\')) AS "P" ("q1")',
    );
    const shared = select(sales).asCte('W');
    const fromCte = pivot(shared, 'P', {
      aggregate: 'count',
      value: 'amount',
      for: 'quarter',
      in: { q1: 'Q1' },
    });
    expect(compileAst(select(fromCte).ast).sql).toContain(`(WITH "W" AS (${input}) SELECT`);
    const nested = select(totals, { q1: totals.columns.q1 }).as('T');
    expect(compileAst(select(nested).ast).sql).toContain(') AS "T"');
  });

  it('rejects invalid declarations', () => {
    const base = { aggregate: 'sum', value: 'amount', for: 'quarter', in: { q1: 'Q1' } } as const;
    const loose = pivot as unknown as (source: unknown, name: string, options: object) => unknown;
    expect(() => loose(sales, 'X', { ...base, value: 'missing' })).toThrow(
      'Unknown PIVOT value column: missing',
    );
    expect(() => loose(sales, 'X', { ...base, for: 'toString' })).toThrow(
      'Unknown PIVOT for column: toString',
    );
    expect(() => loose(sales, 'X', { ...base, for: 'amount' })).toThrow('must differ');
    expect(() => loose(sales, 'X', { ...base, value: 'region' })).toThrow('numeric');
    expect(() => loose(sales, 'X', { ...base, aggregate: 'avg' })).toThrow('Unsupported');
    expect(() => loose(sales, 'X', { ...base, default: null })).toThrow('cannot be null');
    expect(() => loose(sales, 'X', { ...base, default: 'abc' })).toThrow('decimal text');
    expect(() => loose(sales, 'X', { ...base, in: {} })).toThrow('at least one value');
    expect(() => loose(sales, 'X', { ...base, in: { id: 'Q1' } })).toThrow(
      'collides with a grouping column: id',
    );
    expect(() => loose(sales, 'X', { ...base, in: JSON.parse('{"__proto__":"Q1"}') })).toThrow(
      'Reserved',
    );
    expect(() => loose(sales, 'X', { ...base, in: { '': 'Q1' } })).toThrow('Identifiers');
    expect(() => loose(sales, 'X', { ...base, in: { a: 'Q1', b: 'Q1' } })).toThrow(
      'Duplicate PIVOT value: Q1',
    );
    expect(() => loose(sales, 'X', { ...base, for: 'region', in: { a: null } })).toThrow(
      'non-null scalars',
    );
    const events = snowflakeTable('EVENTS', { id: integer('ID').notNull(), data: variant('DATA') });
    expect(() =>
      loose(events, 'X', { aggregate: 'count', value: 'id', for: 'data', in: { a: { x: 1 } } }),
    ).toThrow('non-null scalars');
    const items = flatten(events.columns.data, 'F');
    expect(() =>
      loose(items, 'X', { aggregate: 'count', value: 'seq', for: 'key', in: { a: 'k' } }),
    ).toThrow('cannot depend on other sources');
  });
});

describe('dynamic PIVOT', () => {
  it('compiles IN (ANY) as an unvalidated raw query', () => {
    const query = dynamicPivot(sales, 'Y', {
      aggregate: 'sum',
      value: 'amount',
      for: 'quarter',
      default: '0',
    });
    expect(query.kind).toBe('raw');
    expect(query.compile()).toEqual({
      sql: `SELECT * FROM (${input}) PIVOT (SUM("amount") FOR "quarter" IN (ANY) DEFAULT ON NULL (?)) AS "Y"`,
      binds: ['0'],
    });
    const ordered = dynamicPivot(sales, 'Y', {
      aggregate: 'count',
      value: 'amount',
      for: 'quarter',
      order: 'desc',
    });
    expect(ordered.compile().sql).toContain('IN (ANY ORDER BY "quarter" DESC))');
    const ascending = dynamicPivot(sales, 'Y', {
      aggregate: 'count',
      value: 'amount',
      for: 'quarter',
      order: 'asc',
    });
    expect(sql`SELECT COUNT(*) FROM (${ascending}) WHERE "id" = ${1}`.compile()).toEqual({
      sql: `SELECT COUNT(*) FROM (SELECT * FROM (${input}) PIVOT (COUNT("amount") FOR "quarter" IN (ANY ORDER BY "quarter" ASC)) AS "Y") WHERE "id" = ?`,
      binds: [1],
    });
  });
});

describe('UNPIVOT', () => {
  const long = unpivot(months, 'U', { value: 'amount', for: 'month', in: ['jan', 'feb'] });
  const monthsInput = 'SELECT "ID" AS "id", "JAN" AS "jan", "FEB" AS "feb" FROM "MONTHS"';

  it('compiles the column list and derives output domains', () => {
    expect(compileAst(select(long).ast).sql).toContain(
      `SELECT "id" AS "id", "amount" AS "amount", "month" AS "month" FROM (${monthsInput}) UNPIVOT ("amount" FOR "month" IN ("jan", "feb")) AS "U")`,
    );
    expect(Object.keys(long.columns)).toEqual(['id', 'amount', 'month']);
    expect(resultSchema(long.columns).parse({ id: '1', amount: '2', month: 'feb' })).toEqual({
      id: 1n,
      amount: 2n,
      month: 'feb',
    });
    expect(() => long.columns.amount.readSchema.parse(null)).toThrow('non-null');
    expect(() => long.columns.month.readSchema.parse('mar')).toThrow();
    expect(long.columns.amount.wireType).toBe('integer');
    expect(long.columns.amount.dataType).toBe('integer');
    expect(long.columns.month.notNull().required).toBe(true);
    const query = select(long).where(eq(long.columns.amount, 5n));
    expect(query.compile().binds).toEqual(['5']);
    expect(() => select(long).where(eq(long.columns.month, 'mar' as never))).toThrow();
  });

  it('keeps nulls only when requested', () => {
    const withNulls = unpivot(months, 'N', {
      value: 'amount',
      for: 'month',
      in: ['jan', 'feb'],
      includeNulls: true,
    });
    expect(compileAst(select(withNulls).ast).sql).toContain(' UNPIVOT INCLUDE NULLS (');
    expect(withNulls.columns.amount.readSchema.parse(null)).toBeNull();
    expect(withNulls.columns.amount.required).toBe(false);
    const required = unpivot(months, 'R', {
      value: 'amount',
      for: 'month',
      in: ['jan'],
      includeNulls: true,
    });
    expect(required.columns.amount.required).toBe(true);
  });

  it('accepts text and variant domains and validates each member schema', () => {
    const notes = snowflakeTable('NOTES', {
      a: variant('A', z.object({ x: z.number() })).notNull(),
      b: variant('B', z.object({ y: z.string() })).notNull(),
      c: text('C'),
      d: text('D'),
    });
    const payloads = unpivot(notes, 'V', { value: 'payload', for: 'source', in: ['a', 'b'] });
    expect(payloads.columns.payload.readSchema.parse('{"y":"ok"}')).toEqual({ y: 'ok' });
    expect(() => payloads.columns.payload.readSchema.parse('{"z":1}')).toThrow();
    const encoded = select(payloads)
      .where(eq(payloads.columns.payload, { y: 'ok' }))
      .compile();
    expect(encoded.sql).toContain('PARSE_JSON(?)');
    expect(encoded.binds).toEqual(['{"y":"ok"}']);
    const texts = unpivot(notes, 'T', { value: 'note', for: 'source', in: ['c', 'd'] });
    expect(texts.columns.note.wireType).toBeUndefined();
  });

  it('rejects incompatible or colliding declarations', () => {
    const loose = unpivot as unknown as (source: unknown, name: string, options: object) => unknown;
    const base = { value: 'amount', for: 'month', in: ['jan', 'feb'] };
    expect(() => loose(months, 'X', { ...base, in: [] })).toThrow('at least one column');
    expect(() => loose(months, 'X', { ...base, in: ['jan', 'jan'] })).toThrow('distinct');
    expect(() => loose(months, 'X', { ...base, in: ['jan', 'mar'] })).toThrow(
      'Unknown UNPIVOT column: mar',
    );
    expect(() => loose(sales, 'X', { ...base, in: ['id', 'region'] })).toThrow('share one type');
    expect(() => loose(months, 'X', { ...base, value: 'id' })).toThrow(
      'Duplicate output column: id',
    );
    expect(() => loose(months, 'X', { ...base, for: 'amount' })).toThrow(
      'Duplicate output column: amount',
    );
  });
});

describe('PIVOT AST compilation', () => {
  const from: SelectNode = {
    kind: 'select',
    from: identifier('T'),
    projections: [{ column: identifier('A'), alias: 'A' }],
  };
  const node = (patch: Partial<PivotNode>): SelectNode => ({
    kind: 'select',
    from: {
      kind: 'pivot',
      source: from,
      aggregate: 'SUM',
      value: identifier('A'),
      for: identifier('B'),
      values: ['x'],
      alias: identifier('P'),
      ...patch,
    },
    projections: [],
  });

  it('guards literal rendering and aggregate names', () => {
    expect(compileAst(node({})).sql).toBe(
      `SELECT * FROM (SELECT "A" AS "A" FROM "T") PIVOT (SUM("A") FOR "B" IN ('x')) AS "P"`,
    );
    expect(() => compileAst(node({ aggregate: 'AVG' as never }))).toThrow('Unsupported PIVOT');
    expect(() => compileAst(node({ values: [Number.NaN] }))).toThrow('finite');
    expect(() => compileAst(node({ values: ['a\0b'] }))).toThrow('NUL');
    expect(compileAst(node({ values: [-2.5], columns: [identifier('c')] })).sql).toContain(
      'IN (-2.5)) AS "P" ("c")',
    );
  });
});
