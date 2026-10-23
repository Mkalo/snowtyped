import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  asc,
  count,
  deleteUsing,
  eq,
  insert,
  integer,
  isNotNull,
  mergeInto,
  ne,
  recursiveCte,
  select,
  snowflakeTable,
  sql,
  text,
  updateFrom,
} from '../../src/index.js';
import { createFixture, integrationConfig } from '../support/snowflake.js';

describe('recursive CTEs against Snowflake', () => {
  const fixture = createFixture(integrationConfig());
  const db = fixture.client;
  const namespace = { database: fixture.table.node.parts[0] as string, schema: fixture.schemaName };
  const employees = snowflakeTable(
    'EMPLOYEES',
    {
      id: integer('ID').notNull(),
      managerId: integer('MANAGER_ID'),
      name: text('NAME').notNull(),
      title: text('TITLE'),
    },
    namespace,
  );
  const teams = snowflakeTable(
    'TEAMS',
    { lead: integer('LEAD').notNull(), team: text('TEAM').notNull() },
    namespace,
  );
  const reach = snowflakeTable(
    'REACH',
    { id: integer('ID').notNull(), name: text('NAME') },
    namespace,
  );
  const e = employees.columns;
  const t = teams.columns;
  const name = (table: { node: { parts: readonly string[] } }) =>
    sql.identifier(...(table.node.parts as [string, ...string[]]));
  const root = (id: bigint) =>
    select(employees, { id: e.id, managerId: e.managerId, name: e.name }).where(eq(e.id, id));
  const reports = recursiveCte('REPORTS', root(1n), (self) =>
    select(employees, { id: e.id, managerId: e.managerId, name: e.name }).innerJoin(
      self,
      eq(e.managerId, self.columns.id),
    ),
  );

  beforeAll(async () => {
    await fixture.seed();
    await db.queryRaw(
      sql`CREATE TABLE ${name(employees)} (ID NUMBER(38,0) NOT NULL, MANAGER_ID NUMBER(38,0), NAME VARCHAR NOT NULL, TITLE VARCHAR)`,
    );
    await db.queryRaw(
      sql`CREATE TABLE ${name(teams)} (LEAD NUMBER(38,0) NOT NULL, TEAM VARCHAR NOT NULL)`,
    );
    await db.execute(
      insert(employees, [
        { id: 1n, managerId: null, name: 'Ada', title: 'CEO' },
        { id: 2n, managerId: 1n, name: 'Grace', title: 'CTO' },
        { id: 3n, managerId: 1n, name: 'Linus', title: null },
        { id: 4n, managerId: 2n, name: 'Barbara', title: 'Engineer' },
        { id: 9007199254740993n, managerId: 4n, name: 'Edsger', title: null },
        { id: 6n, managerId: null, name: 'Alan', title: 'Advisor' },
      ]),
    );
    await db.queryRaw(sql`CREATE TABLE ${name(reach)} (ID NUMBER(38,0) NOT NULL, NAME VARCHAR)`);
    await db.execute(
      insert(teams, [
        { lead: 2n, team: 'Platform' },
        { lead: 4n, team: 'Compiler' },
      ]),
    );
  });
  afterAll(() => fixture.cleanup());

  it('walks a seeded hierarchy down and up with bindings in both branches', async () => {
    const descendants = await db.execute(
      select(reports, { id: reports.columns.id, name: reports.columns.name }).orderBy(
        asc(reports.columns.id),
      ),
    );
    expect(descendants.rows).toEqual([
      { id: 1n, name: 'Ada' },
      { id: 2n, name: 'Grace' },
      { id: 3n, name: 'Linus' },
      { id: 4n, name: 'Barbara' },
      { id: 9007199254740993n, name: 'Edsger' },
    ]);
    const ancestors = recursiveCte('ANCESTORS', root(9007199254740993n), (self) =>
      select(employees, { id: e.id, managerId: e.managerId, name: e.name })
        .innerJoin(self, eq(e.id, self.columns.managerId))
        .where(ne(e.name, 'Grace')),
    );
    expect((await db.execute(select(ancestors).orderBy(asc(ancestors.columns.id)))).rows).toEqual([
      { id: 4n, managerId: 2n, name: 'Barbara' },
      { id: 9007199254740993n, managerId: 4n, name: 'Edsger' },
    ]);
  });

  it('validates declared nullable columns and preserved-side outer joins', async () => {
    const titles = recursiveCte(
      'TITLES',
      select(employees, { id: e.id, title: e.name }).where(eq(e.id, 1n)),
      (self) =>
        select(self)
          .innerJoin(employees, eq(e.managerId, self.columns.id))
          .leftJoin(teams, eq(t.lead, e.id))
          .select({ id: e.id, title: t.team }),
      { nullable: ['title'] },
    );
    expect((await db.execute(select(titles).orderBy(asc(titles.columns.id)))).rows).toEqual([
      { id: 1n, title: 'Ada' },
      { id: 2n, title: 'Platform' },
      { id: 3n, title: null },
      { id: 4n, title: 'Compiler' },
      { id: 9007199254740993n, title: null },
    ]);
    const led = recursiveCte(
      'LED',
      select(teams, { id: t.lead }).where(eq(t.team, 'Platform')),
      (self) =>
        select(employees)
          .rightJoin(self, eq(e.managerId, self.columns.id))
          .where(isNotNull(e.id))
          .select({ id: e.id }),
      { nullable: ['id'] },
    );
    expect((await db.execute(select(led).orderBy(asc(led.columns.id)))).rows).toEqual([
      { id: 2n },
      { id: 4n },
      { id: 9007199254740993n },
    ]);
  });

  it('feeds nested consumers, hoisted CTEs, and chained recursion', async () => {
    const roots = select(employees, { id: e.id, managerId: e.managerId, name: e.name })
      .where(eq(e.managerId, null))
      .asCte('roots');
    const forest = recursiveCte('FOREST', select(roots), (self) =>
      select(employees, { id: e.id, managerId: e.managerId, name: e.name }).innerJoin(
        self,
        eq(e.managerId, self.columns.id),
      ),
    );
    const derived = select(forest, { id: forest.columns.id }).as('derived');
    expect((await db.execute(select(derived, { total: count() }))).rows).toEqual([{ total: 6n }]);
    const outer = select(reports, { id: reports.columns.id }).asCte('outer');
    expect(
      (await db.execute(select(outer, { total: count() }).where(eq(outer.columns.id, 3n)))).rows,
    ).toEqual([{ total: 1n }]);
    const chained = recursiveCte(
      'CHAINED',
      select(employees, { id: e.id, name: e.name }).where(eq(e.id, 2n)),
      (self) =>
        select(reports, { id: reports.columns.id, name: reports.columns.name }).innerJoin(
          self,
          eq(reports.columns.managerId, self.columns.id),
        ),
    );
    const paired = select(chained)
      .crossJoin(forest)
      .where(eq(forest.columns.managerId, null))
      .select({ name: chained.columns.name, root: forest.columns.name })
      .orderBy(asc(chained.columns.id), asc(forest.columns.id));
    expect((await db.execute(paired)).rows).toEqual([
      { name: 'Grace', root: 'Ada' },
      { name: 'Grace', root: 'Alan' },
      { name: 'Barbara', root: 'Ada' },
      { name: 'Barbara', root: 'Alan' },
      { name: 'Edsger', root: 'Ada' },
      { name: 'Edsger', root: 'Alan' },
    ]);
    const combined = select(reports, { id: reports.columns.id }).except(
      select(forest, { id: forest.columns.id }).where(eq(forest.columns.managerId, 1n)),
    );
    const rows = [];
    for await (const row of db.stream(combined.orderBy(asc(combined.columns.id)))) rows.push(row);
    expect(rows).toEqual([{ id: 1n }, { id: 4n }, { id: 9007199254740993n }]);
  });

  it('uses a recursive CTE as a MERGE, UPDATE FROM, and DELETE USING source', async () => {
    const on = eq(reach.columns.id, reports.columns.id);
    const merged = await db.execute(
      mergeInto(reach, reports, on).whenNotMatchedInsert({ id: reports.columns.id, name: null }),
    );
    expect(merged.affectedRows).toBe(5);
    const updated = await db.execute(
      updateFrom(reach, reports, on, { name: reports.columns.name }),
    );
    expect(updated.affectedRows).toBe(5);
    const deleted = await db.execute(
      deleteUsing(reach, reports, on).where(ne(reports.columns.name, 'Ada')),
    );
    expect(deleted.affectedRows).toBe(4);
    expect((await db.execute(select(reach))).rows).toEqual([{ id: 1n, name: 'Ada' }]);
  });
});
