import { describe, expect, it } from 'vitest';
import {
  alias,
  and,
  asc,
  count,
  deleteFrom,
  eq,
  exists,
  gt,
  inSubquery,
  integer,
  lower,
  max,
  notExists,
  rowNumber,
  type SelectQuery,
  scalar,
  select,
  snowflakeTable,
  sum,
  text,
  update,
  variant,
} from '../../src/index.js';
import { resultSchema } from '../../src/schema.js';

const users = snowflakeTable('USERS', {
  id: integer('ID').notNull(),
  name: text('NAME').notNull(),
});
const orders = snowflakeTable('ORDERS', {
  id: integer('ID').notNull(),
  userId: integer('USER_ID').notNull(),
  total: integer('TOTAL'),
  data: variant('DATA'),
});
const items = snowflakeTable('ITEMS', { orderId: integer('ORDER_ID').notNull() });
const userOrders = select(orders, { id: orders.columns.id })
  .correlate(users)
  .where(eq(orders.columns.userId, users.columns.id));

describe('subqueries', () => {
  it('compiles correlated EXISTS and NOT EXISTS with qualified inner references', () => {
    expect(select(users, { id: users.columns.id }).where(exists(userOrders)).compile()).toEqual({
      sql: 'SELECT TO_VARCHAR("__sflib_result"."id") AS "id" FROM (SELECT "ID" AS "id" FROM "USERS" WHERE (EXISTS (SELECT "ORDERS"."ID" AS "id" FROM "ORDERS" WHERE ("ORDERS"."USER_ID" = "USERS"."ID")))) AS "__sflib_result"',
      binds: [],
    });
    const query = select(users, { name: users.columns.name, none: notExists(userOrders) });
    expect(query.compile().sql).toBe(
      'SELECT "NAME" AS "name", (NOT EXISTS (SELECT "ORDERS"."ID" AS "id" FROM "ORDERS" WHERE ("ORDERS"."USER_ID" = "USERS"."ID"))) AS "none" FROM "USERS"',
    );
    expect(resultSchema(query.selection).parse({ name: 'Ada', none: false })).toEqual({
      name: 'Ada',
      none: false,
    });
    expect(() => resultSchema(query.selection).parse({ name: 'Ada', none: null })).toThrow();
    expect(exists(userOrders).refs).toEqual([users.ref]);
    expect(userOrders.outerSources).toEqual([users.ref]);
  });

  it('keeps bindings in textual order through nested subqueries', () => {
    const inner = select(items, { id: items.columns.orderId })
      .correlate(orders)
      .where(and(eq(items.columns.orderId, orders.columns.id), gt(items.columns.orderId, 2n)));
    const middle = select(orders, { id: orders.columns.id })
      .correlate(users)
      .where(and(eq(orders.columns.userId, users.columns.id), eq(orders.columns.total, 1n)))
      .where(and(eq(orders.columns.userId, users.columns.id), exists(inner)));
    const query = select(users, { name: users.columns.name })
      .where(and(eq(users.columns.name, 'a'), exists(middle), eq(users.columns.id, 3n)))
      .limit(1);
    expect(query.compile()).toEqual({
      sql: 'SELECT "NAME" AS "name" FROM "USERS" WHERE (("NAME" = ?) AND (EXISTS (SELECT "ORDERS"."ID" AS "id" FROM "ORDERS" WHERE (("ORDERS"."USER_ID" = "USERS"."ID") AND (EXISTS (SELECT "ITEMS"."ORDER_ID" AS "id" FROM "ITEMS" WHERE (("ITEMS"."ORDER_ID" = "ORDERS"."ID") AND ("ITEMS"."ORDER_ID" > ?))))))) AND ("ID" = ?)) LIMIT 1',
      binds: ['a', '2', '3'],
    });
  });

  it('serializes scalar subqueries only at the outer boundary and reads empty results as NULL', () => {
    const highest = scalar(select(orders, { top: max(orders.columns.total) }));
    const query = select(users, { id: users.columns.id, top: highest });
    expect(query.compile().sql).toBe(
      'SELECT TO_VARCHAR("__sflib_result"."id") AS "id", TO_VARCHAR("__sflib_result"."top") AS "top" FROM (SELECT "ID" AS "id", (SELECT MAX("ORDERS"."TOTAL") AS "top" FROM "ORDERS") AS "top" FROM "USERS") AS "__sflib_result"',
    );
    expect(resultSchema(query.selection).parse({ id: '1', top: null })).toEqual({
      id: 1n,
      top: null,
    });
    const name = scalar(select(users, { name: users.columns.name }).limit(1));
    expect(name.wireType).toBeUndefined();
    expect(name.readSchema.parse(null)).toBeNull();
    expect(highest.encode(null)).toEqual({ kind: 'parameter', value: null });
    expect(
      select(orders, { id: orders.columns.id })
        .where(eq(highest, 5n))
        .where(eq(highest, null))
        .compile(),
    ).toMatchObject({ binds: [] });
    expect(
      select(orders, { id: orders.columns.id }).where(eq(highest, 5n)).compile().binds,
    ).toEqual(['5']);
    const payload = scalar(select(orders, { data: orders.columns.data }).limit(1));
    expect(
      select(orders, { id: orders.columns.id })
        .where(eq(payload, { ok: true }))
        .compile().sql,
    ).toContain('= PARSE_JSON(?)');
  });

  it('accepts correlated scalar subqueries only as ungrouped aggregates', () => {
    const spent = scalar(
      select(orders, { spent: sum(orders.columns.total) })
        .correlate(users)
        .where(eq(orders.columns.userId, users.columns.id)),
    );
    expect(select(users, { name: users.columns.name, spent }).compile().sql).toBe(
      'SELECT "__sflib_result"."name" AS "name", TO_VARCHAR("__sflib_result"."spent") AS "spent" FROM (SELECT "NAME" AS "name", (SELECT SUM("ORDERS"."TOTAL") AS "spent" FROM "ORDERS" WHERE ("ORDERS"."USER_ID" = "USERS"."ID")) AS "spent" FROM "USERS") AS "__sflib_result"',
    );
    const correlated = select(orders).correlate(users);
    expect(() => scalar(correlated.select({ id: orders.columns.id }))).toThrow('aggregate');
    const total = correlated.select({ n: count() });
    expect(() => scalar(total.groupBy(orders.columns.userId))).toThrow('GROUP BY');
    expect(() => scalar(total.limit(1))).toThrow('LIMIT');
    expect(() => scalar(total.offset(1))).toThrow('OFFSET');
    expect(scalar(total.groupBy()).refs).toEqual([users.ref]);
    expect(() => scalar(select(orders) as never)).toThrow('exactly one column');
  });

  it('compiles IN subqueries with the operand first', () => {
    const buyers = select(orders, { id: orders.columns.userId }).where(
      gt(orders.columns.total, 10n),
    );
    expect(
      select(users, { name: users.columns.name })
        .where(inSubquery(users.columns.id, buyers, true))
        .compile(),
    ).toEqual({
      sql: 'SELECT "NAME" AS "name" FROM "USERS" WHERE ("ID" NOT IN (SELECT "ORDERS"."USER_ID" AS "id" FROM "ORDERS" WHERE ("ORDERS"."TOTAL" > ?)))',
      binds: ['10'],
    });
    const nested = inSubquery(
      scalar(
        select(items, { id: max(items.columns.orderId) }).where(gt(items.columns.orderId, 1n)),
      ),
      select(orders, { id: orders.columns.id })
        .correlate(users)
        .where(eq(orders.columns.userId, users.columns.id)),
    );
    expect(nested.refs).toEqual([users.ref]);
    expect(select(users).where(nested).compile().sql).toContain(
      '((SELECT MAX("ITEMS"."ORDER_ID") AS "id" FROM "ITEMS" WHERE ("ITEMS"."ORDER_ID" > ?)) IN (SELECT',
    );
    expect(inSubquery(count(), buyers).phase).toBe('aggregate');
    expect(() => inSubquery(users.columns.id, select(orders) as never)).toThrow(
      'exactly one column',
    );
  });

  it('scopes correlated sources to the immediately enclosing query', () => {
    const correlated = select(orders).correlate(users);
    // @ts-expect-error ITEMS is neither a local nor a correlated source.
    expect(() => correlated.where(eq(items.columns.orderId, 1n))).toThrow('table scope');
    // @ts-expect-error Outer references require correlate().
    expect(() => select(orders).where(eq(users.columns.id, 1n))).toThrow('table scope');
    // @ts-expect-error The subquery correlates with ITEMS, which the outer query lacks.
    expect(() => select(users).where(exists(userOrders.correlate(items)))).toThrow('table scope');
    const skip = select(items, { id: items.columns.orderId })
      .correlate(users)
      .where(eq(items.columns.orderId, users.columns.id));
    const middle = select(orders).correlate(users);
    expect(() => middle.where(exists(skip))).toThrow('immediately enclosing');
    expect(() => middle.select({ found: exists(skip) })).toThrow('immediately enclosing');
    expect(() => select(users).where(exists(skip))).not.toThrow();
  });

  it('allows outer references across inner clauses and joins', () => {
    const o = alias(orders, 'o');
    const inner = select(o, { id: o.columns.id })
      .correlate(users)
      .innerJoin(items, eq(items.columns.orderId, users.columns.id))
      .groupBy(o.columns.id, users.columns.id)
      .having(gt(count(), 0n))
      .qualify(eq(rowNumber({ orderBy: [asc(users.columns.name)] }), 1n))
      .orderBy(asc(lower(users.columns.name)));
    expect(exists(inner).expression).toMatchObject({ kind: 'exists', negate: false });
    expect(select(users).where(exists(inner)).compile().sql).toContain(
      'INNER JOIN "ITEMS" ON ("ITEMS"."ORDER_ID" = "USERS"."ID") GROUP BY "o"."ID", "USERS"."ID"',
    );
    expect(() => exists(select(o).qualify(gt(o.columns.id, 1n)))).toThrow('QUALIFY');
  });

  it('rejects ambiguous or standalone correlated queries', () => {
    expect(() => (select(orders).correlate as () => unknown)()).toThrow('at least one');
    expect(() => select(users).correlate(users)).toThrow('distinct names');
    expect(() => select(orders).correlate(alias(users, 'ORDERS'))).toThrow('distinct names');
    expect(() => userOrders.correlate(users)).toThrow('distinct names');
    expect(() => userOrders.innerJoin(users, eq(users.columns.id, orders.columns.id))).toThrow(
      'distinct names',
    );
    const standalone = userOrders as unknown as SelectQuery<{ id: typeof orders.columns.id }>;
    expect(() => standalone.compile()).toThrow('only be used as a subquery');
    expect(() => standalone.as('x')).toThrow('only be used as a subquery');
    expect(() => standalone.asCte('x')).toThrow('only be used as a subquery');
    expect(() => exists({ ...userOrders })).toThrow('built by select()');
  });

  it('correlates mutation filters with their target table', () => {
    expect(deleteFrom(users).where(notExists(userOrders)).compile().sql).toBe(
      'DELETE FROM "USERS" WHERE (NOT EXISTS (SELECT "ORDERS"."ID" AS "id" FROM "ORDERS" WHERE ("ORDERS"."USER_ID" = "USERS"."ID")))',
    );
    const orderCount = scalar(
      select(orders, { n: count() })
        .correlate(users)
        .where(eq(orders.columns.userId, users.columns.id)),
    );
    expect(update(users, { name: 'x' }).where(gt(orderCount, 1n)).compile().binds).toEqual([
      'x',
      '1',
    ]);
  });
});
