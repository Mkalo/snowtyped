import type { RowStatement, StatementOption } from 'snowflake-sdk';
import { describe, expect, it, vi } from 'vitest';
import * as z from 'zod';
import {
  asc,
  binary,
  boolean,
  count,
  date,
  decimal,
  desc,
  eq,
  integer,
  jsonPath,
  lower,
  rowNumber,
  select,
  snowflakeTable,
  text,
  timestamp,
  variant,
} from '../../src/index.js';
import { resultSchema, type Selection } from '../../src/schema.js';
import { createClient } from '../../src/snowflake/index.js';

const a = snowflakeTable('A', {
  id: integer('ID').notNull(),
  name: text('NAME'),
  amount: decimal('AMOUNT').notNull(),
  day: date('DAY').notNull(),
  at: timestamp('AT').notNull(),
  json: variant('JSON', z.object({ ok: z.boolean() })).notNull(),
});
const b = snowflakeTable('B', {
  id: integer('ID').notNull(),
  name: text('NAME').notNull(),
  amount: decimal('AMOUNT'),
  json: variant('JSON'),
});
const c = snowflakeTable('C', { id: integer('ID').notNull(), name: text('NAME') });
const left = select(a, { id: a.columns.id, name: a.columns.name });
const right = select(b, { name: b.columns.name, id: b.columns.id });
const third = select(c, { id: c.columns.id, name: c.columns.name });
type Query = { readonly selection: Selection; readonly nullableSources: ReadonlySet<symbol> };

describe('set operation composition', () => {
  it('compiles each operator with aligned branches and serializes only at the outer boundary', () => {
    expect(left.union(right.where(eq(b.columns.id, 5n))).compile()).toEqual({
      sql: 'SELECT TO_VARCHAR("__sflib_result"."id") AS "id", "__sflib_result"."name" AS "name" FROM ((SELECT "ID" AS "id", "NAME" AS "name" FROM "A") UNION (SELECT "ID" AS "id", "NAME" AS "name" FROM "B" WHERE ("ID" = ?))) AS "__sflib_result"',
      binds: ['5'],
    });
    expect(left.unionAll(right).compile().sql).toContain(') UNION ALL (');
    expect(left.intersect(right).compile().sql).toContain(') INTERSECT (');
    expect(left.except(right).compile().sql).toContain(') EXCEPT (');
    expect(right.union(left).ast.right).toMatchObject({
      projections: [{ alias: 'name' }, { alias: 'id' }],
    });
    expect(
      select(a, { name: a.columns.name })
        .union(select(b, { name: b.columns.name }))
        .compile().sql,
    ).toBe('(SELECT "NAME" AS "name" FROM "A") UNION (SELECT "NAME" AS "name" FROM "B")');
    expect(Object.keys(right.union(left).selection)).toEqual(['name', 'id']);
    expect(Object.isFrozen(left.union(right).ast)).toBe(true);
  });

  it('groups by builder structure rather than keyword precedence', () => {
    const chained = left.union(right).intersect(third).compile().sql;
    expect(chained).toContain(
      'FROM (((SELECT "ID" AS "id", "NAME" AS "name" FROM "A") UNION (SELECT "ID" AS "id", "NAME" AS "name" FROM "B")) INTERSECT (SELECT "ID" AS "id", "NAME" AS "name" FROM "C"))',
    );
    const nested = left.union(right.intersect(third)).compile().sql;
    expect(nested).toContain(
      'FROM ((SELECT "ID" AS "id", "NAME" AS "name" FROM "A") UNION ((SELECT "ID" AS "id", "NAME" AS "name" FROM "B") INTERSECT (SELECT "ID" AS "id", "NAME" AS "name" FROM "C")))',
    );
    expect(left.intersect(right).unionAll(third).except(left).ast).toMatchObject({
      operator: 'EXCEPT',
      left: { operator: 'UNION ALL', left: { operator: 'INTERSECT' } },
    });
    const reordered = select(c, { name: c.columns.name, id: c.columns.id });
    expect(left.except(right.union(reordered)).ast.right).toMatchObject({
      columns: [{ alias: 'id', wireType: 'integer' }, { alias: 'name' }],
      left: { projections: [{ alias: 'id' }, { alias: 'name' }] },
      right: { projections: [{ alias: 'id' }, { alias: 'name' }] },
    });
  });

  it('orders and paginates the combined result natively and validates those clauses', () => {
    const combined = left.unionAll(right);
    const query = combined
      .orderBy(desc(combined.columns.id, 'LAST'), asc(lower(combined.columns.name)))
      .limit(2)
      .offset(1);
    expect(query.compile().sql).toMatch(
      /AS "__sflib_result" ORDER BY "__sflib_result"\."id" DESC NULLS LAST, LOWER\("__sflib_result"\."name"\) ASC LIMIT 2 OFFSET 1$/,
    );
    expect(query.limit(0).offset(0).compile().sql).toMatch(/LIMIT 0 OFFSET 0$/);
    const json = select(a, { json: a.columns.json }).union(select(b, { json: b.columns.json }));
    expect(
      json
        .orderBy(asc(jsonPath(json.columns.json, 'rank')))
        .compile()
        .sql.endsWith('ORDER BY GET("__sflib_result"."json", ?) ASC'),
    ).toBe(true);
    const branch = select(a, { name: a.columns.name })
      .where(eq(a.columns.name, 'x'))
      .orderBy(asc(a.columns.id))
      .limit(1);
    const bound = branch
      .union(select(b, { name: b.columns.name }).where(eq(b.columns.name, 'y')))
      .limit(3);
    expect(bound.compile()).toEqual({
      sql: 'SELECT "__sflib_result"."name" AS "name" FROM ((SELECT "NAME" AS "name" FROM "A" WHERE ("NAME" = ?) ORDER BY "A"."ID" ASC LIMIT 1) UNION (SELECT "NAME" AS "name" FROM "B" WHERE ("NAME" = ?))) AS "__sflib_result" LIMIT 3',
      binds: ['x', 'y'],
    });
    expect(bound.intersect(branch).compile().sql).toContain(
      '(SELECT "__sflib_result"."name" AS "name" FROM ((SELECT',
    );
    expect(
      json
        .orderBy(asc(jsonPath(json.columns.json, 'rank')))
        .union(select(a, { json: a.columns.json }).where(eq(a.columns.id, 1n)))
        .compile().binds,
    ).toEqual(['rank', '1']);
    for (const value of [-1, 0.5, Infinity]) {
      expect(() => combined.limit(value)).toThrow('LIMIT');
      expect(() => combined.offset(value)).toThrow('OFFSET');
    }
    // @ts-expect-error Exercise the runtime scope boundary for base-table ordering.
    expect(() => combined.orderBy(asc(a.columns.id))).toThrow('does not belong');
    expect(() => left.union(right).orderBy(asc(combined.columns.id))).toThrow('does not belong');
    expect(() => combined.orderBy(asc(count(combined.columns.id)))).toThrow('scalar');
    expect(combined.limit(1).orderBy(asc(combined.columns.name)).compile().sql).toContain(
      'ORDER BY "__sflib_result"."name" ASC LIMIT 1',
    );
  });

  it('hoists branch CTEs into one leading WITH and rejects conflicting definitions', () => {
    const shared = select(b, { id: b.columns.id, name: b.columns.name }).asCte('shared');
    const fromShared = select(shared, { id: shared.columns.id, name: shared.columns.name });
    const query = fromShared.union(left).union(fromShared);
    expect(query.compile().sql).toMatch(
      /^WITH "shared" AS \(SELECT "ID" AS "id", "NAME" AS "name" FROM "B"\) SELECT .* FROM \(\(\(SELECT "shared"\."id" AS "id", "shared"\."name" AS "name" FROM "shared"\) UNION/,
    );
    expect(query.compile().sql.match(/WITH/g)).toHaveLength(1);
    expect(query.ast.left).not.toHaveProperty('with');
    const other = select(c, { id: c.columns.id, name: c.columns.name }).asCte('shared');
    expect(() =>
      fromShared.union(select(other, { id: other.columns.id, name: other.columns.name })),
    ).toThrow('same name');
  });

  it('rejects incompatible projections, domains, unchecked branches, and foreign operands', () => {
    // @ts-expect-error Exercise the runtime alias boundary.
    expect(() => left.union(select(b, { id: b.columns.id }))).toThrow('same projection aliases');
    expect(() =>
      // @ts-expect-error Exercise the runtime alias boundary.
      left.union(select(b, { id: b.columns.id, other: b.columns.name })),
    ).toThrow('same projection aliases');
    expect(() =>
      // @ts-expect-error Exercise the runtime SQL type boundary.
      select(a, { value: a.columns.day }).union(select(a, { value: a.columns.at })),
    ).toThrow('column value combines different domains: DATE and TIMESTAMP_NTZ.');
    expect(() =>
      // @ts-expect-error Exercise the runtime SQL type boundary.
      select(a, { value: a.columns.name }).union(select(b, { value: b.columns.amount })),
    ).toThrow('different domains');
    const flags = snowflakeTable('F', {
      name: text('NAME'),
      flag: boolean('FLAG'),
      data: binary('DATA'),
    });
    for (const [l, r] of [
      [flags.columns.name, flags.columns.flag],
      [flags.columns.name, flags.columns.data],
      [flags.columns.flag, flags.columns.data],
    ] as const)
      expect(() => select(flags, { value: l }).union(select(flags, { value: r }) as never)).toThrow(
        'different domains',
      );
    expect(
      select(flags, { value: flags.columns.name })
        .union(select(a, { value: lower(a.columns.name) }))
        .compile().sql,
    ).toContain('UNION');
    expect(() =>
      select(a, { value: a.columns.amount }).except(
        // @ts-expect-error Exercise the runtime domain boundary.
        select(a, { value: a.columns.id }),
      ),
    ).toThrow('different domains');
    const unchecked = select(a, { id: a.columns.id, name: a.columns.name }).qualify(
      eq(a.columns.id, 1n),
    );
    expect(() => unchecked.union(left)).toThrow('window function');
    expect(() => left.union(unchecked)).toThrow('window function');
    const rank = rowNumber({ orderBy: [asc(a.columns.id)] });
    expect(
      select(a, { id: a.columns.id, rank })
        .qualify(eq(rank, 1n))
        .union(select(a, { id: a.columns.id, rank }))
        .compile().sql,
    ).toContain('QUALIFY');
    for (const value of [null, 'query', { kind: 'select', rowType: { id: 1n, name: null } }])
      expect(() => left.union(value as never)).toThrow('built by select()');
  });
});

describe('combined row domains and nullability', () => {
  it('derives nullability per operator, including outer-join branches', () => {
    const values = (query: Query, row: unknown) =>
      resultSchema(query.selection, query.nullableSources).safeParse(row).success;
    const union = left.union(right);
    expect(values(union, { id: '1', name: null })).toBe(true);
    const intersect = left.intersect(right);
    expect(values(intersect, { id: '1', name: null })).toBe(false);
    expect(values(intersect, { id: '1', name: 'Ada' })).toBe(true);
    expect(values(left.intersect(third), { id: '1', name: null })).toBe(true);
    const except = right.except(left);
    expect(values(except, { name: null, id: '1' })).toBe(false);
    expect(values(left.except(right), { id: '1', name: null })).toBe(true);
    const joined = select(c)
      .leftJoin(b, eq(c.columns.id, b.columns.id))
      .select({ id: c.columns.id, name: b.columns.name });
    expect(values(right.union(joined), { name: null, id: '2' })).toBe(true);
    expect(values(right.intersect(joined), { name: null, id: '2' })).toBe(false);
    expect(values(joined.except(right), { id: '2', name: null })).toBe(true);
    expect(resultSchema(union.selection).parse({ id: '9007199254740993', name: 'x' })).toEqual({
      id: 9007199254740993n,
      name: 'x',
    });
  });

  it('keeps exact numeric and VARIANT decoding and validates each branch shape', () => {
    const amounts = select(a, { amount: a.columns.amount }).union(
      select(b, { amount: b.columns.amount }),
    );
    const schema = resultSchema(amounts.selection);
    expect(schema.parse({ amount: '1.5000' })).toEqual({ amount: '1.5000' });
    expect(schema.parse({ amount: null })).toEqual({ amount: null });
    expect(() => schema.parse({ amount: '1e3' })).toThrow();
    expect(amounts.compile().sql).toContain('TO_VARCHAR("__sflib_result"."amount")');
    const shaped = select(a, { json: a.columns.json });
    const loose = select(b, { json: b.columns.json });
    expect(shaped.union(loose).compile().sql).toContain('TO_JSON("__sflib_result"."json")');
    expect(resultSchema(shaped.union(loose).selection).parse({ json: '[1]' })).toEqual({
      json: [1],
    });
    expect(() => resultSchema(shaped.except(loose).selection).parse({ json: '[1]' })).toThrow();
    expect(() => resultSchema(shaped.intersect(loose).selection).parse({ json: null })).toThrow();
    expect(resultSchema(shaped.union(shaped).selection).parse({ json: '{"ok":true}' })).toEqual({
      json: { ok: true },
    });
  });

  it('turns combined queries into derived tables and CTEs that keep output domains', () => {
    const combined = left.union(right);
    const derived = combined.as('combined');
    expect(derived.columns.name.readSchema.parse(null)).toBeNull();
    expect(derived.columns.id.notNull().refs[0]).toBe(derived.ref);
    expect(select(derived).where(eq(derived.columns.name, null)).compile().sql).toBe(
      'SELECT TO_VARCHAR("__sflib_result"."id") AS "id", "__sflib_result"."name" AS "name" FROM (SELECT "combined"."id" AS "id", "combined"."name" AS "name" FROM ((SELECT "ID" AS "id", "NAME" AS "name" FROM "A") UNION (SELECT "ID" AS "id", "NAME" AS "name" FROM "B")) AS "combined" WHERE ("combined"."name" IS NULL)) AS "__sflib_result"',
    );
    const shared = select(b, { id: b.columns.id, name: b.columns.name }).asCte('shared');
    const cte = select(shared, { id: shared.columns.id, name: shared.columns.name })
      .intersect(left)
      .asCte('result');
    expect(select(cte).compile().sql).toMatch(
      /FROM \(WITH "result" AS \(WITH "shared" AS \(SELECT .*\) \(SELECT "shared"\."id"/,
    );
    expect(cte.columns.name.readSchema.parse('x')).toBe('x');
    expect(() => cte.columns.name.readSchema.parse(null)).toThrow();
    expect(select(a).as('legacy').columns.json.readSchema.parse('{"ok":false}')).toEqual({
      ok: false,
    });
  });

  it('executes combined queries with derived validation', async () => {
    const statement = {
      getQueryId: () => 'query',
      getColumns: () => undefined,
    } as unknown as RowStatement;
    const connection = {
      execute: vi.fn((options: StatementOption) => {
        options.complete?.(undefined, statement, [
          ['1', null],
          ['2', 'Ada'],
        ]);
        return statement;
      }),
    };
    const db = createClient(connection);
    const query = left.union(right);
    expect((await db.execute(query)).rows).toEqual([
      { id: 1n, name: null },
      { id: 2n, name: 'Ada' },
    ]);
    await expect(db.execute(left.intersect(right))).rejects.toThrow();
  });
});
