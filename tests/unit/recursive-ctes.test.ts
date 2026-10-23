import type { RowStatement, StatementOption } from 'snowflake-sdk';
import { describe, expect, it, vi } from 'vitest';
import * as z from 'zod';
import {
  alias,
  asc,
  count,
  eq,
  flatten,
  gte,
  integer,
  recursiveCte,
  rowNumber,
  select,
  snowflakeTable,
  text,
  variant,
} from '../../src/index.js';
import type { SetColumns } from '../../src/query.js';
import type { Table } from '../../src/schema.js';
import { createClient } from '../../src/snowflake/index.js';

const employees = snowflakeTable('EMPLOYEES', {
  id: integer('ID').notNull(),
  managerId: integer('MANAGER_ID'),
  name: text('NAME').notNull(),
  title: text('TITLE'),
  tags: variant('TAGS', z.array(z.string())).notNull(),
});
const teams = snowflakeTable('TEAMS', { id: integer('ID').notNull(), lead: integer('LEAD') });
const e = employees.columns;
const anchor = select(employees, { id: e.id, managerId: e.managerId, name: e.name }).where(
  eq(e.id, 7n),
);
// biome-ignore lint/suspicious/noExplicitAny: runtime checks are exercised without static types.
const untyped = recursiveCte as (...args: any[]) => Table;
function reports<N extends string>(
  self: Table<SetColumns<{ id: bigint; managerId: bigint | null; name: string }, N>, N>,
) {
  return select(employees, { name: e.name, id: e.id, managerId: e.managerId }).innerJoin(
    self,
    eq(e.managerId, self.columns.id),
  );
}
const chain = recursiveCte('CHAIN', anchor, (self) => reports(self).where(eq(e.name, 'x')));

describe('recursive CTEs', () => {
  it('compiles WITH RECURSIVE with a column list, aligned branches, and ordered binds', () => {
    expect(select(chain).where(eq(chain.columns.name, 'Ada')).compile()).toEqual({
      sql: 'SELECT TO_VARCHAR("__sflib_result"."id") AS "id", TO_VARCHAR("__sflib_result"."managerId") AS "managerId", "__sflib_result"."name" AS "name" FROM (WITH RECURSIVE "CHAIN" ("id", "managerId", "name") AS ((SELECT "ID" AS "id", "MANAGER_ID" AS "managerId", "NAME" AS "name" FROM "EMPLOYEES" WHERE ("ID" = ?)) UNION ALL (SELECT "EMPLOYEES"."ID" AS "id", "EMPLOYEES"."MANAGER_ID" AS "managerId", "EMPLOYEES"."NAME" AS "name" FROM "EMPLOYEES" INNER JOIN "CHAIN" ON ("EMPLOYEES"."MANAGER_ID" = "CHAIN"."id") WHERE ("EMPLOYEES"."NAME" = ?))) SELECT "CHAIN"."id" AS "id", "CHAIN"."managerId" AS "managerId", "CHAIN"."name" AS "name" FROM "CHAIN" WHERE ("CHAIN"."name" = ?)) AS "__sflib_result"',
      binds: ['7', 'x', 'Ada'],
    });
    expect(chain.source).toMatchObject({
      kind: 'cte',
      self: { kind: 'self-reference', columns: ['id', 'managerId', 'name'] },
      query: { operator: 'UNION ALL' },
    });
    const fromSelf = recursiveCte('FROM_SELF', anchor, (self) =>
      select(self).where(eq(self.columns.id, 0n)),
    );
    expect(select(fromSelf).compile().sql).toContain(
      'UNION ALL (SELECT "id" AS "id", "managerId" AS "managerId", "name" AS "name" FROM "FROM_SELF" WHERE ("id" = ?))',
    );
  });

  it('types the self-reference from the anchor and widens declared nullable columns', () => {
    expect(chain.columns.managerId.readSchema.parse(null)).toBeNull();
    expect(() => chain.columns.name.readSchema.parse(null)).toThrow();
    const titled = recursiveCte(
      'TITLED',
      select(employees, { id: e.id, title: e.name }),
      (self) => {
        expect(self.columns.title.readSchema.parse(null)).toBeNull();
        return select(employees, { id: e.id, title: e.title }).innerJoin(
          self,
          eq(e.managerId, self.columns.id),
        );
      },
      { nullable: ['title'] },
    );
    expect(titled.columns.title.readSchema.parse(null)).toBeNull();
    expect(() =>
      untyped('TITLED', select(employees, { id: e.id, title: e.name }), (self: Table) =>
        select(employees, { id: e.id, title: e.title }).innerJoin(
          self,
          eq(e.managerId, self.columns.id as typeof e.id),
        ),
      ),
    ).toThrow('column title can be NULL; declare it nullable');
    expect(() => untyped('CHAIN', anchor, reports, { nullable: ['missing'] })).toThrow(
      'no column missing',
    );
  });

  it('hoists CTEs used by either branch ahead of the recursive definition', () => {
    const bosses = select(employees, { id: e.id }).asCte('bosses');
    const seeded = recursiveCte('SEEDED', select(bosses, { id: bosses.columns.id }), (self) =>
      select(teams, { id: teams.columns.id }).innerJoin(
        self,
        eq(teams.columns.lead, self.columns.id),
      ),
    );
    expect(select(seeded).crossJoin(bosses).compile().sql).toMatch(
      /FROM \(WITH RECURSIVE "bosses" AS \(SELECT "ID" AS "id" FROM "EMPLOYEES"\), "SEEDED" \("id"\) AS \(\(SELECT "bosses"\."id" AS "id" FROM "bosses"\) UNION ALL/,
    );
    const other = select(teams, { id: teams.columns.id }).asCte('bosses');
    expect(() => select(other).crossJoin(seeded).compile()).toThrow(
      'cannot define different CTEs with the same name',
    );
    const nested = recursiveCte('NESTED', select(bosses), (self) =>
      select(seeded).innerJoin(self, eq(seeded.columns.id, self.columns.id)).crossJoin(chain),
    );
    expect(select(nested).compile().sql).toMatch(
      /FROM \(WITH RECURSIVE "bosses" AS .*, "SEEDED" \("id"\) AS .*, "CHAIN" \("id", "managerId", "name"\) AS .*, "NESTED" \("id"\) AS .*CROSS JOIN "CHAIN".* SELECT /,
    );
    expect(() => untyped('NESTED', select(seeded), (self: Table) => select(self))).toThrow(
      'anchor cannot read another recursive CTE',
    );
    const wrapped = select(seeded).as('wrapped');
    expect(() => untyped('NESTED', select(wrapped), (self: Table) => select(self))).toThrow(
      'anchor cannot read another recursive CTE',
    );
    expect(
      select(nested)
        .compile()
        .sql.match(/RECURSIVE/g),
    ).toHaveLength(1);
  });

  it('composes with derived tables, CTEs, and set operations', () => {
    const derived = select(chain, { id: chain.columns.id }).as('derived');
    expect(select(derived).compile().sql).toContain(
      'FROM (WITH RECURSIVE "CHAIN" ("id", "managerId", "name") AS (',
    );
    const outer = select(chain, { id: chain.columns.id }).asCte('outer');
    expect(select(outer).compile().sql).toMatch(/FROM \(WITH "outer" AS \(WITH RECURSIVE "CHAIN"/);
    const combined = select(chain, { id: chain.columns.id }).union(
      select(teams, { id: teams.columns.id }),
    );
    expect(combined.orderBy(asc(combined.columns.id)).compile().sql).toMatch(
      /^WITH RECURSIVE "CHAIN" .* UNION \(SELECT "ID" AS "id" FROM "TEAMS"\)\) AS "__sflib_result" ORDER BY/,
    );
  });

  it('rejects references outside the recursive branch', () => {
    let leaked: Table | undefined;
    recursiveCte('LEAK', anchor, (self) => {
      leaked = self;
      return reports(self);
    });
    expect(() => select(leaked as Table).compile()).toThrow('only valid in its recursive branch');
    expect(() =>
      recursiveCte('OUTER', anchor, (outer) => {
        recursiveCte('INNER', select(outer), (inner) => select(inner));
        return reports(outer);
      }),
    ).toThrow('anchor cannot reference a recursive CTE being defined');
    expect(() =>
      recursiveCte('OUTER', anchor, (outer) => {
        recursiveCte('INNER', anchor, () => reports(outer));
        return reports(outer);
      }),
    ).toThrow('can only reference its own CTE');
    expect(() => untyped('NONE', anchor, () => anchor)).toThrow('reference its CTE exactly once');
    expect(() =>
      untyped('NESTED', anchor, (self: Table) => select(select(self).as('inner'))),
    ).toThrow('reference its CTE exactly once');
    expect(() =>
      untyped('TWICE', anchor, (self: Table) =>
        reports(self as never).crossJoin(select(self).as('inner')),
      ),
    ).toThrow('reference its CTE exactly once');
  });

  it('allows only joins that preserve the recursive reference', () => {
    const okLeft = recursiveCte('OK_LEFT', anchor, (self) =>
      select(self).leftJoin(teams, eq(teams.columns.lead, self.columns.id)),
    );
    expect(select(okLeft).compile().sql).toContain('FROM "OK_LEFT" LEFT JOIN "TEAMS"');
    const rightPreserved = recursiveCte('RIGHT', anchor, (self) =>
      select(teams).rightJoin(self, eq(teams.columns.lead, self.columns.id)).select({
        id: self.columns.id,
        managerId: self.columns.managerId,
        name: self.columns.name,
      }),
    );
    expect(select(rightPreserved).compile().sql).toContain('RIGHT JOIN "RIGHT"');
    const lateral = recursiveCte('LATERAL_OK', anchor, (self) => {
      const tag = flatten(e.tags, 'tag');
      return reports(self).lateralJoin(tag);
    });
    expect(select(lateral).compile().sql).toContain('LATERAL FLATTEN');
    const ordered = recursiveCte('ORDERED', anchor, (self) =>
      reports(self)
        .leftJoin(teams, eq(teams.columns.lead, e.id))
        .leftJoin(alias(teams, 'others'), eq(e.id, e.id)),
    );
    expect(select(ordered).compile().sql).toContain('LEFT JOIN "TEAMS"');
    const rejected = [
      (self: Table) =>
        select(self)
          .leftJoin(teams, eq(teams.columns.lead, self.columns.id as typeof e.id))
          .innerJoin(employees, eq(e.managerId, self.columns.id as typeof e.id))
          .select({ id: e.id, managerId: e.managerId, name: e.name }),
      (self: Table) =>
        select(employees, { id: e.id, managerId: e.managerId, name: e.name }).leftJoin(
          self,
          eq(e.managerId, self.columns.id as typeof e.id),
        ),
      (self: Table) => select(self).asofJoin(employees, gte(e.id, self.columns.id as typeof e.id)),
      (self: Table) =>
        select(self).rightJoin(teams, eq(teams.columns.lead, self.columns.id as typeof e.id)),
      (self: Table) =>
        select(self).fullJoin(teams, eq(teams.columns.lead, self.columns.id as typeof e.id)),
      (self: Table) =>
        select(employees, { id: e.id, managerId: e.managerId, name: e.name }).fullJoin(
          self,
          eq(e.managerId, self.columns.id as typeof e.id),
        ),
    ];
    for (const recursive of rejected)
      expect(() => untyped('JOINS', anchor, recursive)).toThrow(
        /preserved side|ASOF joins|must follow every other join/,
      );
    expect(() =>
      untyped('LATERAL', select(employees, { id: e.id, tags: e.tags }), (self: Table) =>
        select(self).lateralJoin(flatten(self.columns.tags as typeof e.tags, 'tag')),
      ),
    ).toThrow('FLATTEN cannot read the recursive reference');
  });

  it('rejects recursion forms Snowflake does not support', () => {
    expect(() => untyped('chain', anchor, reports)).toThrow('uppercase letters');
    expect(() => untyped('1CHAIN', anchor, reports)).toThrow('uppercase letters');
    expect(() => untyped('CHAIN', {}, reports)).toThrow('anchor must be built by select()');
    expect(() => untyped('CHAIN', anchor, () => ({}))).toThrow(
      'recursive branch must be built by select()',
    );
    expect(() =>
      untyped('CHAIN', anchor, (self: Table) => reports(self as never).union(anchor)),
    ).toThrow('must be a single SELECT');
    const restricted = [
      (query: ReturnType<typeof reports>) => query.distinct(),
      (query: ReturnType<typeof reports>) => query.groupBy(e.id),
      (query: ReturnType<typeof reports>) => query.having(eq(e.id, 1n)),
      (query: ReturnType<typeof reports>) =>
        query.qualify(eq(rowNumber({ orderBy: [asc(e.id)] }), 1n)),
      (query: ReturnType<typeof reports>) => query.orderBy(asc(e.id)),
      (query: ReturnType<typeof reports>) => query.limit(1),
      (query: ReturnType<typeof reports>) => query.offset(1),
      (query: ReturnType<typeof reports>) =>
        query.select({ id: count(), managerId: e.managerId, name: e.name }),
    ];
    for (const restrict of restricted)
      expect(() =>
        untyped('CHAIN', anchor, (self: Table) => restrict(reports(self as never))),
      ).toThrow('only scalar projections, filters, and joins');
    expect(() =>
      untyped('CHAIN', anchor, (self: Table) =>
        select(employees, { id: e.name, managerId: e.managerId, name: e.name }).innerJoin(
          self,
          eq(e.managerId, self.columns.id as typeof e.id),
        ),
      ),
    ).toThrow('combines different domains');
  });

  it('executes consumers with the contract as validation', async () => {
    const statement = {
      getQueryId: () => 'query',
      getColumns: () => undefined,
    } as unknown as RowStatement;
    const connection = {
      execute: vi.fn((options: StatementOption) => {
        options.complete?.(undefined, statement, [
          ['7', null, 'Ada'],
          ['8', '7', 'Grace'],
        ]);
        return statement;
      }),
    };
    expect((await createClient(connection).execute(select(chain))).rows).toEqual([
      { id: 7n, managerId: null, name: 'Ada' },
      { id: 8n, managerId: 7n, name: 'Grace' },
    ]);
  });
});
