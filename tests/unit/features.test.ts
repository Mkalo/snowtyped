import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import { compileAst, identifier, type StatementNode } from '../../src/ast.js';
import { expression, scalarParameter } from '../../src/expressions.js';
import {
  alias,
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
  flatten,
  float,
  gt,
  gte,
  ilike,
  inArray,
  insert,
  integer,
  isNotNull,
  isNull,
  jsonPath,
  like,
  lower,
  lt,
  lte,
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
  timeTravel,
  update,
  upper,
  variant,
} from '../../src/index.js';
import { resultSchema, type Table } from '../../src/schema.js';

const a = snowflakeTable('A', {
  id: integer('ID').notNull(),
  name: text('NAME'),
  amount: decimal('AMOUNT'),
  json: variant('JSON'),
});
const b = snowflakeTable('B', { id: integer('ID').notNull(), amount: decimal('AMOUNT').notNull() });
const c = snowflakeTable('C', { id: integer('ID').notNull() });
const on = eq(a.columns.id, b.columns.id);

describe('composable expressions and clauses', () => {
  it('compiles all comparison, boolean, null, membership, and string operations with bindings', () => {
    const predicates = [
      eq(a.columns.id, 1n),
      ne(a.columns.id, 1n),
      gt(a.columns.id, 1n),
      gte(a.columns.id, 1n),
      lt(a.columns.id, 1n),
      lte(a.columns.id, 1n),
      like(a.columns.name, '%a%'),
      ilike(a.columns.name, '%A%'),
    ];
    const query = select(a).where(
      and(
        ...predicates,
        or(isNull(a.columns.name), not(isNotNull(a.columns.name))),
        inArray(a.columns.id, [1n, 2n]),
        inArray(a.columns.id, [3n], true),
      ),
    );
    expect(query.compile().sql).toContain(' AND ');
    expect(query.compile().sql).toContain(' OR ');
    expect(query.compile().sql).toContain(' NOT IN ');
    expect(query.compile().sql).toContain('NOT ("NAME" IS NOT NULL)');
    expect(query.compile().binds).toEqual([
      '1',
      '1',
      '1',
      '1',
      '1',
      '1',
      '%a%',
      '%A%',
      '1',
      '2',
      '3',
    ]);
    expect(select(a).where(ne(a.columns.name, null)).compile().sql).toContain('IS NOT NULL');
    expect(select(a).where(inArray(a.columns.id, [])).compile().sql).toContain('WHERE FALSE');
    expect(
      select(a)
        .where(inArray(a.columns.id, [], true))
        .compile().sql,
    ).toContain('WHERE TRUE');
    expect(() => and()).toThrow('at least one');
    expect(() => or()).toThrow('at least one');
  });

  it('derives correct aggregate and string-function validation', () => {
    const selection = {
      count: count(),
      unique: count(a.columns.id, true),
      min: min(a.columns.id),
      max: max(a.columns.id),
      total: sum(a.columns.amount),
      low: lower(a.columns.name),
      up: upper(a.columns.name),
    };
    const query = select(a, selection)
      .groupBy(a.columns.name)
      .having(gt(count(), 1n))
      .orderBy(asc(lower(a.columns.name), 'FIRST'), desc(min(a.columns.id), 'LAST'))
      .distinct()
      .limit(10)
      .offset(2);
    expect(query.compile().sql).toContain('COUNT(DISTINCT "ID")');
    expect(query.compile().sql).toContain('GROUP BY "NAME" HAVING');
    expect(query.compile().sql).toContain('NULLS FIRST');
    expect(query.compile().sql).toContain('LIMIT 10 OFFSET 2');
    expect(
      resultSchema(selection).parse({
        count: '2',
        unique: '2',
        min: null,
        max: '9',
        total: null,
        low: 'a',
        up: null,
      }),
    ).toEqual({ count: 2n, unique: 2n, min: null, max: 9n, total: null, low: 'a', up: null });
    expect(
      select(a, { low: min(a.columns.name), up: max(a.columns.name) }).compile().sql,
    ).toContain('MIN("NAME")');
    for (const value of [-1, 0.5, Infinity, NaN]) {
      expect(() => select(a).limit(value)).toThrow('LIMIT');
      expect(() => select(a).offset(value)).toThrow('OFFSET');
    }
    expect(select(a).limit(0).offset(0).compile().sql).toContain('LIMIT 0 OFFSET 0');
    expect(() => select(a).where(gt(count(), 0n))).toThrow('WHERE');
    expect(() => select(a).having(eq(rowNumber(), 1n))).toThrow('HAVING');
    expect(() => select(a).groupBy(count())).toThrow('GROUP BY');
  });

  it('places windows and QUALIFY correctly and checks the final projection', () => {
    const rank = rowNumber({ partitionBy: [a.columns.name], orderBy: [desc(a.columns.id)] });
    const query = select(a, { rank }).qualify(eq(rank, 1n));
    expect(query.compile().sql).toContain(
      'ROW_NUMBER() OVER (PARTITION BY "NAME" ORDER BY "ID" DESC)',
    );
    expect(select(a).qualify(eq(rank, 1n)).compile().sql).toContain('QUALIFY');
    expect(select(a, { rank: rowNumber() }).qualify(eq(a.columns.id, 1n)).compile().sql).toContain(
      'OVER ()',
    );
    expect(select(a, { value: over(count(a.columns.id)) }).compile().sql).toContain(
      'COUNT("ID") OVER ()',
    );
    expect(select(a, { value: over(min(a.columns.name)) }).compile().sql).toContain(
      'MIN("NAME") OVER ()',
    );
    expect(() => select(a).qualify(eq(a.columns.id, 1n)).compile()).toThrow('window function');
    expect(() =>
      query.select({ id: a.columns.id }).qualify(eq(a.columns.id, 1n)).compile(),
    ).toThrow('window function');
    expect(() => select(a).orderBy(asc(rank)).qualify(eq(a.columns.id, 1n)).compile()).toThrow(
      'window function',
    );
  });

  it('keeps expression defaults safe and rejects unsupported runtime parameters', () => {
    const literal = expression(scalarParameter(1), z.number());
    expect(literal.encode(2)).toEqual({ kind: 'parameter', value: 2 });
    expect(() => scalarParameter({})).toThrow('Unsupported');
    expect(() => scalarParameter(Infinity)).toThrow('Unsupported');
    expect(isNull(a.columns.name).readSchema.parse(true)).toBe(true);
    expect(select(a, { n: literal }).compile().binds).toEqual([1]);
    expect(() => select(a, Object.fromEntries([['__proto__', a.columns.id]]))).toThrow('Reserved');
  });

  it('serializes after relational operations and keeps hidden order keys native', () => {
    const query = select(a, { id: a.columns.id, __sflib_order_0: a.columns.name }).orderBy(
      asc(a.columns.amount),
    );
    expect(query.compile().sql).toContain('"AMOUNT" AS "__sflib_order_0_"');
    expect(query.compile().sql).toContain('ORDER BY "__sflib_result"."__sflib_order_0_" ASC');
    expect(
      select(a, { id: a.columns.id }).distinct().orderBy(asc(a.columns.id)).compile().sql,
    ).toContain('FROM (SELECT DISTINCT "ID" AS "id"');
    expect(() =>
      select(a, { id: a.columns.id }).distinct().orderBy(asc(a.columns.name)).compile(),
    ).toThrow('must be projected');
  });

  it('orders the native SELECT by projection aliases', () => {
    const rank = rowNumber({ orderBy: [desc(sum(b.columns.amount))] });
    expect(
      select(b, { id: b.columns.id, rank }).groupBy(b.columns.id).orderBy(desc(rank)).compile().sql,
    ).toBe(
      'SELECT TO_VARCHAR("__sflib_result"."id") AS "id", TO_VARCHAR("__sflib_result"."rank") AS "rank" FROM (SELECT "ID" AS "id", ROW_NUMBER() OVER (ORDER BY SUM("AMOUNT") DESC) AS "rank" FROM "B" GROUP BY "ID" ORDER BY "rank" DESC) AS "__sflib_result" ORDER BY "__sflib_result"."rank" DESC',
    );
    expect(
      select(b, { id: b.columns.id }).groupBy(b.columns.id).orderBy(asc(rank)).compile().sql,
    ).toContain('AS "__sflib_order_0" FROM "B" GROUP BY "ID" ORDER BY "__sflib_order_0" ASC)');
    const query = select(a, { name: a.columns.name })
      .where(eq(a.columns.id, 1n))
      .orderBy(desc(a.columns.name, 'LAST'), asc(lower(a.columns.name)))
      .compile();
    expect(query.sql).toBe(
      'SELECT "NAME" AS "name" FROM "A" WHERE ("ID" = ?) ORDER BY "name" DESC NULLS LAST, LOWER("A"."NAME") ASC',
    );
    expect(query.binds).toEqual(['1']);
  });

  it('qualifies unprojected ORDER BY columns so projection aliases cannot capture them', () => {
    expect(
      select(a, { NAME: lower(a.columns.name) })
        .orderBy(asc(a.columns.name), desc(rowNumber({ orderBy: [asc(a.columns.name)] })))
        .compile().sql,
    ).toBe(
      'SELECT LOWER("NAME") AS "NAME" FROM "A" ORDER BY "A"."NAME" ASC, ROW_NUMBER() OVER (ORDER BY "A"."NAME" ASC) DESC',
    );
    const x = alias(a, 'X');
    expect(
      select(x, { ID: lower(x.columns.name) })
        .orderBy(asc(x.columns.id))
        .compile().sql,
    ).toBe('SELECT LOWER("NAME") AS "ID" FROM "A" AS "X" ORDER BY "X"."ID" ASC');
    expect(select(x, { NAME: x.columns.id }).orderBy(asc(x.columns.name)).compile().sql).toContain(
      '"NAME" AS "__sflib_order_0" FROM "A" AS "X" ORDER BY "__sflib_order_0" ASC',
    );
  });
});

describe('relations and Snowflake source transformations', () => {
  it.each(['innerJoin', 'leftJoin', 'rightJoin', 'fullJoin'] as const)(
    'compiles %s and validates nullable source fields',
    (method) => {
      const query = select(a)
        [method](b, on)
        .select({ id: a.columns.id, other: b.columns.id, missing: isNull(b.columns.id) });
      expect(query.compile().sql).toContain('JOIN "B" ON ("A"."ID" = "B"."ID")');
      const parsed = resultSchema(query.selection, query.nullableSources).parse({
        id: method === 'rightJoin' || method === 'fullJoin' ? null : '1',
        other: method === 'leftJoin' || method === 'fullJoin' ? null : '2',
        missing: false,
      });
      expect(parsed.missing).toBe(false);
    },
  );

  it('supports cross joins, repeated immutable joins, CTE joins, and derived sources', () => {
    const renamed = alias(b, 'renamed');
    expect(renamed.columns.id.notNull().refs[0]).toBe(renamed.ref);
    const query = select(a).crossJoin(renamed).innerJoin(c, eq(a.columns.id, c.columns.id));
    expect(query.compile().sql).toContain('CROSS JOIN "B" AS "renamed" INNER JOIN "C"');
    const sub = select(b).as('sub');
    expect(select(sub).compile().sql).toContain('FROM (SELECT "ID" AS "id"');
    const cte = select(b).asCte('cte');
    expect(select(cte).compile().sql).toContain('WITH "cte" AS (SELECT');
    expect(select(a).crossJoin(cte).compile().sql).toContain('CROSS JOIN "cte"');
    const cte2 = select(c).asCte('cte2');
    expect(select(cte).crossJoin(cte2).compile().sql).toContain(', "cte2" AS');
    expect(sub.columns.id.notNull()).toBeDefined();
    const nullableSub = select(a).leftJoin(b, on).select({ id: b.columns.id }).as('nullable');
    expect(nullableSub.columns.id.readSchema.parse(null)).toBeNull();
    expect(select(nullableSub).where(eq(nullableSub.columns.id, null)).compile().sql).toContain(
      'IS NULL',
    );
    const aggregateSub = select(b, { total: sum(b.columns.amount) }).as('aggregate');
    expect(
      select(aggregateSub).where(gt(aggregateSub.columns.total, '10')).compile().binds,
    ).toEqual(['10']);
    expect(() => alias(sub, 'oops')).toThrow('base table');
    expect(() => select(a).crossJoin(a)).toThrow('distinct names');
    expect(() => select(a).crossJoin(snowflakeTable('A', { id: integer('ID') }))).toThrow(
      'distinct names',
    );
    expect(() => select(a).innerJoin(b, eq(rowNumber(), 1n))).toThrow('scalar');
  });

  it('compiles correlated FLATTEN options, JSON paths, and ASOF matching', () => {
    const f = flatten(jsonPath(a.columns.json, 'items', 0), 'f');
    const query = select(a).lateralJoin(f).select({ value: f.columns.value });
    expect(query.compile()).toMatchObject({ binds: ['items', 0, ''] });
    expect(query.compile().sql).toContain('LATERAL FLATTEN');
    expect(query.compile().sql).toContain('OUTER => FALSE');
    const custom = flatten(a.columns.json, 'custom', {
      path: 'items',
      outer: true,
      recursive: true,
      mode: 'ARRAY',
    });
    expect(select(a).lateralJoin(custom).compile().sql).toContain("MODE => 'ARRAY'");
    expect(() => flatten(count(), 'bad')).toThrow('scalar');
    expect(() => jsonPath(a.columns.json, -1)).toThrow('indexes');
    expect(() => jsonPath(a.columns.json, 0.5)).toThrow('indexes');
    expect(jsonPath(a.columns.json, 'key').readSchema.parse('{"ok":true}')).toEqual({ ok: true });
    expect(() => select(a).crossJoin(f)).toThrow('lateralJoin');
    expect(() => select(a).lateralJoin(b)).toThrow('FLATTEN');
    expect(() => select(b).lateralJoin(f)).toThrow('preceding source');
    expect(select(a).asofJoin(b, gte(a.columns.id, b.columns.id)).compile().sql).toContain(
      'MATCH_CONDITION',
    );
    expect(select(a).asofJoin(b, lte(a.columns.id, b.columns.id), on).compile().sql).toContain(
      ' ON ',
    );
    expect(() => select(a).asofJoin(b, on)).toThrow('inequality');
    expect(() => select(a).asofJoin(b, isNull(a.columns.id))).toThrow('inequality');
  });

  it('binds all time travel selectors without interpolating values', () => {
    for (const selector of [
      { offset: 0 },
      { timestamp: '2026-10-22T00:00:00Z' },
      { statement: 'query-id' },
    ]) {
      const table = timeTravel(a, selector);
      expect(select(table).compile().binds).toEqual(Object.values(selector));
    }
    expect(select(timeTravel(a, { offset: -10 }, 'BEFORE')).compile().sql).toContain(
      'BEFORE (OFFSET => ?)',
    );
    expect(
      select(timeTravel(a, { timestamp: '2026-10-22T00:00:00-07:00' })).compile().sql,
    ).toContain('AT (TIMESTAMP => ?::TIMESTAMP_TZ)');
    expect(select(timeTravel(a, { statement: 'query-id' })).compile().sql).toContain(
      'AT (STATEMENT => ?)',
    );
    expect(() => timeTravel(select(a).as('d'), { offset: 0 })).toThrow('base table');
    expect(() => timeTravel(a, { offset: 1 })).toThrow('nonpositive');
    expect(() => timeTravel(a, { offset: 0.5 })).toThrow('nonpositive');
    expect(() => timeTravel(a, { timestamp: '' })).toThrow('empty');
    expect(() => timeTravel(a, { offset: 0, statement: 'x' })).toThrow('exactly one');
    expect(() => timeTravel(a, { bad: 'x' } as unknown as { timestamp: string })).toThrow(
      'Unknown',
    );
  });
});

describe('all declared scalar domains and DML', () => {
  it('validates floating, temporal, binary, and JSON wire values', () => {
    expect(float('F').readSchema.parse('1.25')).toBe(1.25);
    expect(() => float('F').readSchema.parse('NaN')).toThrow();
    expect(date('D').valueSchema.parse('2026-10-22')).toBe('2026-10-22');
    expect(time('T').valueSchema.parse('12:34:56.123456789')).toContain('123456789');
    expect(timestamp('T').valueSchema.parse('2026-10-22')).toBe('2026-10-22');
    expect(variant('V').readSchema.parse('{"x":1}')).toEqual({ x: 1 });
    expect(variant('V', z.object({ ok: z.boolean() })).readSchema.parse('{"ok":true}')).toEqual({
      ok: true,
    });
    expect(() => variant('V', z.object({ ok: z.boolean() })).readSchema.parse('{}')).toThrow();
    expect(() => variant('V').encode(undefined)).toThrow('serializable');
    expect(variant('V').encode({ ok: true })).toMatchObject({
      kind: 'function',
      name: 'PARSE_JSON',
    });
    expect(variant('V').encode(null)).toEqual({
      kind: 'function',
      name: 'PARSE_JSON',
      args: [{ kind: 'parameter', value: null }],
    });
    expect(binary('B').readSchema.parse(new Uint8Array([42]))).toEqual(new Uint8Array([42]));
    expect(binary('B').encode(new Uint8Array([0, 255]))).toMatchObject({ name: 'TO_BINARY' });
    expect(binary('B').encode(null)).toEqual({
      kind: 'function',
      name: 'TO_BINARY',
      args: [
        { kind: 'parameter', value: null },
        { kind: 'parameter', value: 'HEX' },
      ],
    });
    const types = snowflakeTable('TYPES', {
      d: date('D'),
      t: time('T'),
      n: timestamp('N'),
      l: timestamp('L', 'ltz'),
      z: timestamp('Z', 'tz'),
      f: float('F'),
      v: variant('V'),
      b: binary('B'),
      active: boolean('ACTIVE'),
    });
    expect(select(types).compile().sql).toContain('HH24:MI:SS.FF9');
    expect(select(types).compile().sql).toContain('TO_JSON');
    expect(select(types).compile().sql).toContain('TZH:TZM');
  });

  it('reads floats exactly from a binary significand and exponent', () => {
    const read = float('F').readSchema;
    expect(read.parse('1152921504606846848p964')).toBe(Number.MAX_VALUE);
    expect(read.parse('-1152921504606846976p-1134')).toBe(-Number.MIN_VALUE);
    expect(read.parse('1152921504606846720p-1082')).toBe(2.225073858507201e-308);
    expect(read.parse('2120971487017661696p-34')).toBe(123456789.12345679);
    expect(read.parse('1383505805528216576p-62')).toBe(0.30000000000000004);
    expect(Object.is(read.parse('-0'), -0)).toBe(true);
    expect(() => read.parse('inf')).toThrow();
    const table = snowflakeTable('T', { f: float('F') });
    const scale = '(60 - FLOOR(LOG(2, ABS("__sflib_result"."f"))))';
    expect(select(table).compile().sql).toBe(
      `SELECT CASE WHEN ABS("__sflib_result"."f") > 0 AND ABS("__sflib_result"."f") < 'inf'::DOUBLE THEN TO_VARCHAR(("__sflib_result"."f" * POW(2, FLOOR(${scale} / 2)) * POW(2, ${scale} - FLOOR(${scale} / 2)))::NUMBER(38, 0)) || 'p' || TO_VARCHAR(-${scale}) ELSE TO_VARCHAR("__sflib_result"."f") END AS "f" FROM (SELECT "F" AS "f" FROM "T") AS "__sflib_result"`,
    );
  });

  it('encodes immutable insert rows and validates missing and unknown keys', () => {
    const table = snowflakeTable('T', { id: integer('ID').notNull(), name: text('NAME') });
    const rows = [
      { id: 1n, name: 'a' },
      { id: 2n, name: null },
    ];
    const query = insert(table, rows);
    const first = rows[0];
    if (first) first.name = 'changed';
    expect(query.compile()).toEqual({
      sql: 'INSERT INTO "T" ("ID", "NAME") SELECT ?, ? UNION ALL SELECT ?, ?',
      binds: ['1', 'a', '2', null],
    });
    expect(insert(table, { id: 3n }).compile().binds).toEqual(['3', null]);
    expect(() => insert(table, [])).toThrow('at least one row');
    expect(() => insert(table, { id: 1n, wrong: true } as unknown as { id: bigint })).toThrow(
      'Unknown',
    );
    expect(() => insert(table, {} as { id: bigint })).toThrow();
    expect(() => insert(select(table).as('derived'), { id: 1n, name: null })).toThrow('base table');
  });

  it('types NULL like the encoded values of VARIANT and BINARY columns', () => {
    const table = snowflakeTable('T', {
      id: integer('ID').notNull(),
      payload: variant('PAYLOAD'),
      data: binary('DATA'),
      day: date('DAY'),
    });
    expect(
      insert(table, [
        { id: 1n, payload: { a: 1 }, data: new Uint8Array([255]), day: '2026-10-23' },
        { id: 2n, payload: null, data: null, day: null },
        { id: 3n },
      ]).compile(),
    ).toEqual({
      sql:
        'INSERT INTO "T" ("ID", "PAYLOAD", "DATA", "DAY") SELECT ?, PARSE_JSON(?), TO_BINARY(?, ?), ?' +
        ' UNION ALL SELECT ?, PARSE_JSON(?), TO_BINARY(?, ?), ?' +
        ' UNION ALL SELECT ?, PARSE_JSON(?), TO_BINARY(?, ?), ?',
      binds: [
        ...['1', '{"a":1}', 'ff', 'HEX', '2026-10-23'],
        ...['2', null, null, 'HEX', null],
        ...['3', null, null, 'HEX', null],
      ],
    });
    expect(update(table, { payload: null, data: null }).compile()).toEqual({
      sql: 'UPDATE "T" SET "PAYLOAD" = PARSE_JSON(?), "DATA" = TO_BINARY(?, ?)',
      binds: [null, null, 'HEX'],
    });
    const source = snowflakeTable('S', { id: integer('ID').notNull() });
    expect(
      mergeInto(table, source, eq(table.columns.id, source.columns.id))
        .whenNotMatchedInsert({ id: source.columns.id })
        .compile(),
    ).toEqual({
      sql: 'MERGE INTO "T" AS "T" USING "S" ON ("T"."ID" = "S"."ID") WHEN NOT MATCHED THEN INSERT ("ID", "PAYLOAD", "DATA", "DAY") VALUES ("S"."ID", PARSE_JSON(?), TO_BINARY(?, ?), ?)',
      binds: [null, null, 'HEX', null],
    });
  });

  it('compiles update and delete filters and enforces scalar scope', () => {
    expect(update(a, { name: 'Ada' }).where(eq(a.columns.id, 1n)).compile()).toEqual({
      sql: 'UPDATE "A" SET "NAME" = ? WHERE ("ID" = ?)',
      binds: ['Ada', '1'],
    });
    expect(update(a, { name: lower(a.columns.name) }).compile().sql).toContain(
      'SET "NAME" = LOWER("NAME")',
    );
    expect(deleteFrom(a).compile().sql).toBe('DELETE FROM "A"');
    expect(deleteFrom(a).where(eq(a.columns.id, 1n)).compile().binds).toEqual(['1']);
    expect(() => update(a, {})).toThrow('at least one');
    expect(() => update(a, { bad: 1 } as never)).toThrow('Unknown');
    expect(() => update(a, { name: b.columns.amount } as never)).toThrow('scope');
    expect(() => deleteFrom(a).where(gt(count(), 0n))).toThrow('scalar');
  });

  it('compiles all MERGE actions and rejects invalid source/action combinations', () => {
    const target = snowflakeTable('TARGET', { id: integer('ID').notNull(), label: text('LABEL') });
    const source = snowflakeTable('SOURCE', { id: integer('ID').notNull(), label: text('LABEL') });
    const merge = mergeInto(target, source, eq(target.columns.id, source.columns.id));
    expect(() => merge.compile()).toThrow('action');
    const updateInsert = merge
      .whenMatchedUpdate({ label: source.columns.label })
      .whenNotMatchedInsert({ id: source.columns.id });
    expect(updateInsert.compile().sql).toContain(
      'WHEN MATCHED THEN UPDATE SET "LABEL" = "SOURCE"."LABEL"',
    );
    expect(updateInsert.compile().binds).toEqual([null]);
    expect(merge.whenMatchedUpdate({ label: 'x' }).whenMatchedDelete().compile().sql).toContain(
      'WHEN MATCHED THEN DELETE',
    );
    expect(merge.whenMatchedDelete().whenMatchedUpdate({ label: 'x' }).compile().binds).toEqual([
      'x',
    ]);
    expect(() => merge.whenNotMatchedInsert({ bad: 1 } as never)).toThrow('Unknown');
    expect(() => mergeInto(target, target, eq(target.columns.id, target.columns.id))).toThrow(
      'distinct names',
    );
    expect(() => mergeInto(target, source, eq(rowNumber(), 1n))).toThrow('scalar');
    const unknown = snowflakeTable('UNKNOWN', { id: integer('ID') });
    expect(() => mergeInto(target, source, eq(unknown.columns.id, 1n) as never)).toThrow('scope');
    expect(() => update(select(target).as('d') as Table, { id: 1n })).toThrow('base table');
  });

  it('retains compatibility for low-level legacy equality and cast nodes', () => {
    const valid = select(a).ast;
    expect(() => compileAst({ kind: 'unsupported' } as unknown as StatementNode)).toThrow(
      'Unsupported statement',
    );
    expect(() =>
      compileAst({ ...valid, from: { kind: 'unsupported' } } as unknown as StatementNode),
    ).toThrow('Unsupported relation');
    expect(() =>
      compileAst({
        ...valid,
        projections: [{ column: { kind: 'unsupported' }, alias: 'x' }],
      } as unknown as StatementNode),
    ).toThrow('Unsupported expression');
    const base = {
      kind: 'select' as const,
      from: identifier('T'),
      projections: [{ column: identifier('ID'), alias: 'id' }],
    };
    expect(
      compileAst({ ...base, where: { kind: 'equality', column: identifier('ID'), value: null } })
        .sql,
    ).toContain('IS NULL');
    expect(
      compileAst({ ...base, where: { kind: 'equality', column: identifier('ID'), value: 1 } })
        .binds,
    ).toEqual([1]);
    expect(
      compileAst({
        ...base,
        projections: [
          {
            column: { kind: 'cast', value: scalarParameter('1'), target: 'NUMBER(38,0)' },
            alias: 'id',
          },
        ],
      }).sql,
    ).toContain('CAST(? AS NUMBER(38,0))');
  });
});
