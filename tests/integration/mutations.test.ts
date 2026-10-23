import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  asc,
  deleteFrom,
  deleteUsing,
  eq,
  gt,
  insert,
  insertFrom,
  integer,
  lower,
  mergeInto,
  select,
  snowflakeTable,
  sql,
  text,
  updateFrom,
} from '../../src/index.js';
import { createFixture, integrationConfig } from '../support/snowflake.js';

describe('mutation sources and conditional MERGE against Snowflake', () => {
  const fixture = createFixture(integrationConfig());
  const db = fixture.client;
  const namespace = { database: fixture.table.node.parts[0] as string, schema: fixture.schemaName };
  const customers = fixture.table;
  const accounts = snowflakeTable(
    'ACCOUNTS',
    { id: integer('ID').notNull(), label: text('LABEL') },
    namespace,
  );
  const changes = snowflakeTable(
    'CHANGES',
    {
      id: integer('ID').notNull(),
      label: text('LABEL').notNull(),
      action: text('ACTION').notNull(),
    },
    namespace,
  );
  const rows = async () =>
    (await db.execute(select(accounts).orderBy(asc(accounts.columns.id)))).rows;

  beforeAll(async () => {
    await fixture.seed();
    await db.queryRaw(
      sql`CREATE TABLE ${sql.identifier(...(accounts.node.parts as [string, ...string[]]))} (ID NUMBER(38,0) NOT NULL, LABEL VARCHAR)`,
    );
    await db.queryRaw(
      sql`CREATE TABLE ${sql.identifier(...(changes.node.parts as [string, ...string[]]))} (ID NUMBER(38,0) NOT NULL, LABEL VARCHAR NOT NULL, ACTION VARCHAR NOT NULL)`,
    );
    await db.execute(
      insert(changes, [
        { id: 1n, label: 'One', action: 'update' },
        { id: 2n, label: 'Two', action: 'delete' },
        { id: 3n, label: 'Three', action: 'keep' },
        { id: 4n, label: 'Four', action: 'insert' },
        { id: 5n, label: 'Five', action: 'skip' },
      ]),
    );
  });
  beforeEach(async () => {
    await db.execute(deleteFrom(accounts));
    await db.execute(
      insert(accounts, [
        { id: 1n, label: 'a' },
        { id: 2n, label: 'b' },
        { id: 3n, label: 'c' },
      ]),
    );
  });
  afterAll(() => fixture.cleanup());

  it('inserts rows selected from another table with bound filters', async () => {
    const source = select(customers, {
      id: customers.columns.id,
      label: lower(customers.columns.name),
    }).where(eq(customers.columns.active, true));
    const result = await db.execute(insertFrom(accounts, source));
    expect(result.affectedRows).toBe(2);
    expect((await rows()).filter((row) => row.id > 3n)).toEqual([
      { id: 9007199254740993n, label: 'ada' },
    ]);
  });

  it('updates from and deletes using a scoped source', async () => {
    const updated = await db.execute(
      updateFrom(accounts, changes, eq(accounts.columns.id, changes.columns.id), {
        label: changes.columns.label,
      }).where(gt(changes.columns.id, 1n)),
    );
    expect(updated.affectedRows).toBe(2);
    const doomed = select(changes, { id: changes.columns.id })
      .where(eq(changes.columns.action, 'delete'))
      .as('DOOMED');
    const deleted = await db.execute(
      deleteUsing(accounts, doomed, eq(accounts.columns.id, doomed.columns.id)),
    );
    expect(deleted.affectedRows).toBe(1);
    expect(await rows()).toEqual([
      { id: 1n, label: 'a' },
      { id: 3n, label: 'Three' },
    ]);
  });

  it('applies ordered conditional MERGE branches', async () => {
    const merge = mergeInto(accounts, changes, eq(accounts.columns.id, changes.columns.id))
      .whenMatchedUpdate({ label: changes.columns.label }, eq(changes.columns.action, 'update'))
      .whenMatchedDelete(eq(changes.columns.action, 'delete'))
      .whenMatchedUpdate({ label: 'kept' })
      .whenNotMatchedInsert(
        { id: changes.columns.id, label: changes.columns.label },
        eq(changes.columns.action, 'insert'),
      );
    const result = await db.execute(merge);
    expect(result.affectedRows).toBe(4);
    expect(await rows()).toEqual([
      { id: 1n, label: 'One' },
      { id: 3n, label: 'kept' },
      { id: 4n, label: 'Four' },
    ]);
  });

  it('rolls back sourced mutations with the transaction', async () => {
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(
          insertFrom(
            accounts,
            select(changes, { id: changes.columns.id }).where(gt(changes.columns.id, 3n)),
          ),
        );
        await tx.execute(
          mergeInto(
            accounts,
            changes,
            eq(accounts.columns.id, changes.columns.id),
          ).whenMatchedDelete(),
        );
        throw new Error('rollback fixture');
      }),
    ).rejects.toThrow('rollback fixture');
    expect(await rows()).toHaveLength(3);
  });
});
