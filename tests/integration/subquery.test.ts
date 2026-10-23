import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  and,
  asc,
  count,
  deleteFrom,
  eq,
  exists,
  gt,
  inSubquery,
  insert,
  integer,
  max,
  notExists,
  scalar,
  select,
  snowflakeTable,
  sql,
  sum,
  text,
} from '../../src/index.js';
import { createFixture, integrationConfig } from '../support/snowflake.js';

describe('subqueries against Snowflake', () => {
  const fixture = createFixture(integrationConfig());
  const db = fixture.client;
  const namespace = { database: fixture.table.node.parts[0] as string, schema: fixture.schemaName };
  const customers = fixture.table;
  const orders = snowflakeTable(
    'ORDERS',
    {
      id: integer('ID').notNull(),
      customerId: integer('CUSTOMER_ID').notNull(),
      amount: integer('AMOUNT').notNull(),
    },
    namespace,
  );
  const notes = snowflakeTable(
    'NOTES',
    { orderId: integer('ORDER_ID').notNull(), body: text('BODY').notNull() },
    namespace,
  );
  const name = (table: { node: { parts: readonly string[] } }) =>
    sql.identifier(...(table.node.parts as [string, ...string[]]));
  const customerOrders = select(orders, { id: orders.columns.id })
    .correlate(customers)
    .where(eq(orders.columns.customerId, customers.columns.id));

  beforeAll(async () => {
    await fixture.seed();
    await db.queryRaw(
      sql`CREATE TABLE ${name(orders)} (ID NUMBER(38,0) NOT NULL, CUSTOMER_ID NUMBER(38,0) NOT NULL, AMOUNT NUMBER(38,0) NOT NULL)`,
    );
    await db.queryRaw(
      sql`CREATE TABLE ${name(notes)} (ORDER_ID NUMBER(38,0) NOT NULL, BODY VARCHAR NOT NULL)`,
    );
    await db.execute(
      insert(orders, [
        { id: 1n, customerId: 9007199254740993n, amount: 10n },
        { id: 2n, customerId: 9007199254740993n, amount: 20n },
        { id: 3n, customerId: 2n, amount: 5n },
      ]),
    );
    await db.execute(insert(notes, { orderId: 3n, body: 'gift' }));
  });
  afterAll(() => fixture.cleanup());

  it('filters and projects correlated EXISTS and NOT EXISTS', async () => {
    const query = select(customers, {
      id: customers.columns.id,
      none: notExists(customerOrders),
    }).orderBy(asc(customers.columns.id));
    expect((await db.execute(query)).rows).toEqual([
      { id: 2n, none: false },
      { id: 3n, none: true },
      { id: 9007199254740993n, none: false },
    ]);
    const buyers = select(customers, { id: customers.columns.id })
      .where(exists(customerOrders))
      .orderBy(asc(customers.columns.id));
    expect((await db.execute(buyers)).rows).toEqual([{ id: 2n }, { id: 9007199254740993n }]);
  });

  it('reads correlated aggregates, including empty groups, as native values', async () => {
    const spent = scalar(
      select(orders, { total: sum(orders.columns.amount) })
        .correlate(customers)
        .where(eq(orders.columns.customerId, customers.columns.id)),
    );
    const placed = scalar(
      select(orders, { n: count() })
        .correlate(customers)
        .where(eq(orders.columns.customerId, customers.columns.id)),
    );
    const query = select(customers, { id: customers.columns.id, spent, placed })
      .where(gt(placed, 0n))
      .orderBy(asc(spent));
    expect((await db.execute(query)).rows).toEqual([
      { id: 2n, spent: '5', placed: 1n },
      { id: 9007199254740993n, spent: '30', placed: 2n },
    ]);
    const empty = select(customers, { id: customers.columns.id, spent, placed }).where(
      eq(customers.columns.id, 3n),
    );
    expect((await db.execute(empty)).rows).toEqual([{ id: 3n, spent: null, placed: 0n }]);
  });

  it('reads an empty uncorrelated scalar as NULL and surfaces multiple rows as an error', async () => {
    const none = scalar(select(orders, { id: orders.columns.id }).where(gt(orders.columns.id, 9n)));
    const top = scalar(select(orders, { id: max(orders.columns.customerId) }));
    const query = select(customers, { none, top }).where(eq(customers.columns.id, 2n));
    expect((await db.execute(query)).rows).toEqual([{ none: null, top: 9007199254740993n }]);
    const many = scalar(select(orders, { id: orders.columns.id }));
    await expect(db.execute(select(customers, { many }))).rejects.toThrow(/more than one row/i);
  });

  it('evaluates IN and NOT IN subqueries with bindings in order', async () => {
    const large = select(orders, { id: orders.columns.customerId }).where(
      gt(orders.columns.amount, 6n),
    );
    const query = select(customers, { id: customers.columns.id })
      .where(and(gt(customers.columns.id, 1n), inSubquery(customers.columns.id, large, true)))
      .orderBy(asc(customers.columns.id));
    expect(query.compile().binds).toEqual(['1', '6']);
    expect((await db.execute(query)).rows).toEqual([{ id: 2n }, { id: 3n }]);
  });

  it('nests correlations through each immediately enclosing query', async () => {
    const annotated = select(orders, { id: orders.columns.id })
      .correlate(customers)
      .where(
        and(
          eq(orders.columns.customerId, customers.columns.id),
          exists(
            select(notes, { id: notes.columns.orderId })
              .correlate(orders)
              .where(
                and(eq(notes.columns.orderId, orders.columns.id), eq(notes.columns.body, 'gift')),
              ),
          ),
        ),
      );
    const query = select(customers, { name: customers.columns.name }).where(exists(annotated));
    expect((await db.execute(query)).rows).toEqual([{ name: 'Grace' }]);
  });

  it('correlates mutation filters with the target table', async () => {
    const result = await db.execute(
      deleteFrom(orders).where(
        notExists(
          select(customers, { id: customers.columns.id })
            .correlate(orders)
            .where(
              and(
                eq(customers.columns.id, orders.columns.customerId),
                eq(customers.columns.active, false),
              ),
            ),
        ),
      ),
    );
    expect(result.affectedRows).toBe(2);
    expect((await db.execute(select(orders, { id: orders.columns.id }))).rows).toEqual([
      { id: 3n },
    ]);
  });
});
