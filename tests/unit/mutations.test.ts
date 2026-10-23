import { describe, expect, it } from 'vitest';
import { compileAst, identifier, type MergeNode } from '../../src/ast.js';
import {
  alias,
  count,
  deleteUsing,
  eq,
  flatten,
  gt,
  insertFrom,
  integer,
  jsonPath,
  lower,
  mergeInto,
  rowNumber,
  select,
  snowflakeTable,
  text,
  updateFrom,
  variant,
} from '../../src/index.js';

const target = snowflakeTable(
  'TARGET',
  { id: integer('ID').notNull(), label: text('LABEL') },
  { schema: 'APP' },
);
const source = snowflakeTable('SOURCE', {
  id: integer('ID').notNull(),
  label: text('LABEL'),
  data: variant('DATA'),
});
const other = snowflakeTable('OTHER', { id: integer('ID').notNull() });

describe('INSERT from SELECT', () => {
  it('compiles the native source query after the bound target columns', () => {
    const query = select(source, {
      label: lower(source.columns.label),
      id: source.columns.id,
    }).where(gt(source.columns.id, 10n));
    expect(insertFrom(target, query).compile()).toEqual({
      sql: 'INSERT INTO "APP"."TARGET" ("LABEL", "ID") SELECT LOWER("LABEL") AS "label", "ID" AS "id" FROM "SOURCE" WHERE ("ID" > ?)',
      binds: ['10'],
    });
  });

  it('keeps CTEs, joins, and aggregates of the source query', () => {
    const totals = select(source, { id: source.columns.id }).asCte('TOTALS');
    const query = select(totals)
      .innerJoin(other, eq(totals.columns.id, other.columns.id))
      .select({ id: count() })
      .groupBy(other.columns.id);
    expect(insertFrom(target, query).compile().sql).toBe(
      'INSERT INTO "APP"."TARGET" ("ID") WITH "TOTALS" AS (SELECT "ID" AS "id" FROM "SOURCE") SELECT COUNT(*) AS "id" FROM "TOTALS" INNER JOIN "OTHER" ON ("TOTALS"."id" = "OTHER"."ID") GROUP BY "OTHER"."ID"',
    );
  });

  it('validates target columns and the source query', () => {
    expect(() =>
      insertFrom(target, select(source, { label: source.columns.label }) as never),
    ).toThrow('missing required column: id');
    expect(() =>
      insertFrom(
        target,
        select(source, { id: source.columns.id, extra: source.columns.id }) as never,
      ),
    ).toThrow('Unknown mutation column: extra');
    expect(() =>
      insertFrom(
        target,
        select(source, { id: source.columns.id }).qualify(gt(source.columns.id, 1n)),
      ),
    ).toThrow('QUALIFY');
    expect(() =>
      insertFrom(select(source).as('D') as never, select(source, { id: source.columns.id })),
    ).toThrow('base table');
  });
});

describe('UPDATE FROM and DELETE USING', () => {
  it('qualifies the aliased target and binds in statement order', () => {
    const join = eq(target.columns.id, source.columns.id);
    const query = updateFrom(target, source, join, {
      label: source.columns.label,
      id: 5n,
    }).where(eq(source.columns.label, 'new'));
    expect(query.compile()).toEqual({
      sql: 'UPDATE "APP"."TARGET" AS "TARGET" SET "LABEL" = "SOURCE"."LABEL", "ID" = ? FROM "SOURCE" WHERE (("TARGET"."ID" = "SOURCE"."ID") AND ("SOURCE"."LABEL" = ?))',
      binds: ['5', 'new'],
    });
    expect(updateFrom(target, source, join, { label: 'x' }).compile().sql).toBe(
      'UPDATE "APP"."TARGET" AS "TARGET" SET "LABEL" = ? FROM "SOURCE" WHERE ("TARGET"."ID" = "SOURCE"."ID")',
    );
    expect(query.where(gt(target.columns.id, 1n)).compile().sql).toMatch(
      /WHERE \(\("TARGET"."ID" = "SOURCE"."ID"\) AND \("TARGET"."ID" > \?\)\)$/,
    );
  });

  it('accepts derived sources and aliased targets', () => {
    const renamed = alias(target, 't');
    const derived = select(source, { id: source.columns.id })
      .where(eq(source.columns.label, 'stale'))
      .as('D');
    expect(
      deleteUsing(renamed, derived, eq(renamed.columns.id, derived.columns.id)).compile(),
    ).toEqual({
      sql: 'DELETE FROM "APP"."TARGET" AS "t" USING (SELECT "ID" AS "id" FROM "SOURCE" WHERE ("LABEL" = ?)) AS "D" WHERE ("t"."ID" = "D"."id")',
      binds: ['stale'],
    });
    expect(
      deleteUsing(target, source, eq(target.columns.id, source.columns.id))
        .where(eq(source.columns.label, 'gone'))
        .compile().sql,
    ).toBe(
      'DELETE FROM "APP"."TARGET" AS "TARGET" USING "SOURCE" WHERE (("TARGET"."ID" = "SOURCE"."ID") AND ("SOURCE"."LABEL" = ?))',
    );
  });

  it('enforces source kinds, names, and scope', () => {
    const join = eq(target.columns.id, source.columns.id);
    const otherJoin = eq(target.columns.id, other.columns.id);
    expect(() => updateFrom(target, other, otherJoin, { id: source.columns.id } as never)).toThrow(
      'scope',
    );
    expect(() => deleteUsing(target, other, join as never)).toThrow('scope');
    expect(() =>
      deleteUsing(target, other, otherJoin).where(eq(source.columns.id, 1n) as never),
    ).toThrow('scope');
    expect(() => deleteUsing(target, source, gt(count(), 0n))).toThrow('scalar');
    expect(() => deleteUsing(target, source, join).where(gt(count(), 0n))).toThrow('scalar');
    expect(() => deleteUsing(target, alias(source, 'TARGET'), join as never)).toThrow(
      'distinct names',
    );
    expect(() => deleteUsing(target, select(source).asCte('S'), join as never)).toThrow(
      'tables or derived',
    );
    expect(() =>
      deleteUsing(target, flatten(jsonPath(source.columns.data, 'x'), 'F'), join as never),
    ).toThrow('tables or derived');
    expect(() => updateFrom(select(target).as('D'), source, join as never, { id: 1n })).toThrow(
      'base table',
    );
  });
});

describe('conditional MERGE branches', () => {
  const merge = mergeInto(target, source, eq(target.columns.id, source.columns.id));

  it('compiles ordered conditional branches and keeps binds in clause order', () => {
    const query = merge
      .whenMatchedUpdate({ label: 'first' }, eq(source.columns.label, 'a'))
      .whenNotMatchedInsert({ id: source.columns.id, label: 'new' }, gt(source.columns.id, 1n))
      .whenMatchedDelete(eq(target.columns.label, 'b'))
      .whenMatchedUpdate({ label: source.columns.label })
      .whenNotMatchedInsert({ id: source.columns.id });
    expect(query.compile()).toEqual({
      sql:
        'MERGE INTO "APP"."TARGET" AS "TARGET" USING "SOURCE" ON ("TARGET"."ID" = "SOURCE"."ID")' +
        ' WHEN MATCHED AND ("SOURCE"."LABEL" = ?) THEN UPDATE SET "LABEL" = ?' +
        ' WHEN NOT MATCHED AND ("SOURCE"."ID" > ?) THEN INSERT ("ID", "LABEL") VALUES ("SOURCE"."ID", ?)' +
        ' WHEN MATCHED AND ("TARGET"."LABEL" = ?) THEN DELETE' +
        ' WHEN MATCHED THEN UPDATE SET "LABEL" = "SOURCE"."LABEL"' +
        ' WHEN NOT MATCHED THEN INSERT ("ID", "LABEL") VALUES ("SOURCE"."ID", ?)',
      binds: ['a', 'first', '1', 'new', 'b', null],
    });
  });

  it('replaces an unconditional branch and rejects unreachable branches', () => {
    const fallback = merge.whenMatchedUpdate({ label: 'x' }).whenMatchedDelete();
    expect(fallback.compile().sql).toMatch(/ON \(.*\) WHEN MATCHED THEN DELETE$/);
    expect(() => fallback.whenMatchedUpdate({ label: 'y' }, eq(source.columns.id, 1n))).toThrow(
      'Unreachable',
    );
    expect(
      merge
        .whenMatchedDelete(eq(source.columns.id, 1n))
        .whenMatchedUpdate({ label: 'x' })
        .whenMatchedDelete()
        .compile().sql,
    ).toMatch(/WHEN MATCHED AND \("SOURCE"."ID" = \?\) THEN DELETE WHEN MATCHED THEN DELETE$/);
    const inserting = merge.whenNotMatchedInsert({ id: 1n });
    expect(() => inserting.whenNotMatchedInsert({ id: 2n }, eq(source.columns.id, 2n))).toThrow(
      'Unreachable',
    );
    expect(
      fallback.whenNotMatchedInsert({ id: 1n }, eq(source.columns.id, 1n)).compile().sql,
    ).toContain('WHEN MATCHED THEN DELETE WHEN NOT MATCHED AND');
  });

  it('limits NOT MATCHED branches to the source scope and conditions to scalars', () => {
    expect(() => merge.whenNotMatchedInsert({ id: target.columns.id } as never)).toThrow('scope');
    expect(() =>
      merge.whenNotMatchedInsert({ id: 1n }, eq(target.columns.id, 1n) as never),
    ).toThrow('scope');
    expect(() => merge.whenMatchedDelete(eq(other.columns.id, 1n) as never)).toThrow('scope');
    expect(() => merge.whenMatchedDelete(eq(rowNumber(), 1n))).toThrow('scalar');
    expect(() => merge.whenMatchedUpdate({})).toThrow('at least one');
    expect(() => mergeInto(target, select(source).asCte('S'), eq(target.columns.id, 1n))).toThrow(
      'tables or derived',
    );
  });

  it('compiles legacy single-action MERGE nodes before explicit branches', () => {
    const { branches: _, ...node } = merge.whenMatchedDelete().ast as MergeNode;
    expect(
      compileAst({
        ...node,
        deleteMatched: true,
        matched: [{ column: identifier('LABEL'), value: { kind: 'parameter', value: 'x' } }],
        insert: { columns: [identifier('ID')], values: [{ kind: 'parameter', value: 1 }] },
      }).sql,
    ).toMatch(
      /WHEN MATCHED THEN DELETE WHEN MATCHED THEN UPDATE SET "LABEL" = \? WHEN NOT MATCHED THEN INSERT \("ID"\) VALUES \(\?\)$/,
    );
  });
});
