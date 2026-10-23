import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  alias,
  and,
  asc,
  count,
  decimal,
  desc,
  eq,
  flatten,
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
  min,
  ne,
  not,
  or,
  over,
  type Predicate,
  rowNumber,
  type Selection,
  type SelectQuery,
  select,
  snowflakeTable,
  sql,
  sum,
  text,
  timeTravel,
  upper,
  variant,
} from '../../src/index.js';
import { createFixture, integrationConfig, tableIdentifier } from '../support/snowflake.js';

const ADA = 9007199254740993n;
const json = (value: unknown) =>
  JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? `${item}n` : item));
const unordered = <T>(rows: readonly T[]) => [...rows].sort((a, b) => (json(a) < json(b) ? -1 : 1));

describe('query semantics against Snowflake', () => {
  const fixture = createFixture(integrationConfig());
  const db = fixture.client;
  const namespace = { database: fixture.table.node.parts[0] as string, schema: fixture.schemaName };
  const customers = fixture.table;
  const c = customers.columns;
  const orders = snowflakeTable(
    'ORDERS',
    {
      id: integer('ID').notNull(),
      customerId: integer('CUSTOMER_ID').notNull(),
      amount: decimal('AMOUNT').notNull(),
    },
    namespace,
  );
  const o = orders.columns;
  const colors = snowflakeTable('COLORS', { name: text('NAME').notNull() }, namespace);
  const events = snowflakeTable(
    'EVENTS',
    { id: integer('ID').notNull(), payload: variant('PAYLOAD').notNull() },
    namespace,
  );
  const trades = snowflakeTable(
    'TRADES',
    { symbol: text('SYMBOL').notNull(), at: integer('AT_VALUE').notNull() },
    namespace,
  );
  const quotes = snowflakeTable(
    'QUOTES',
    {
      symbol: text('SYMBOL').notNull(),
      at: integer('AT_VALUE').notNull(),
      price: decimal('PRICE').notNull(),
    },
    namespace,
  );
  const history = snowflakeTable(
    'HISTORY',
    { id: integer('ID').notNull(), label: text('LABEL').notNull() },
    namespace,
  );
  const rows = async <S extends Selection, Scope extends string, Nullable extends string>(
    query: SelectQuery<S, Scope, Nullable>,
  ) => (await db.execute(query)).rows;
  const ids = async (where: Predicate<'CUSTOMERS'>) =>
    (await rows(select(customers, { id: c.id }).where(where))).map((row) => row.id).sort();

  beforeAll(async () => {
    await fixture.seed();
    await db.queryRaw(
      sql`CREATE TABLE ${tableIdentifier(orders)} (ID NUMBER(38,0) NOT NULL, CUSTOMER_ID NUMBER(38,0) NOT NULL, AMOUNT NUMBER(38,4) NOT NULL)`,
    );
    await db.execute(
      insert(orders, [
        { id: 1n, customerId: ADA, amount: '10.0000' },
        { id: 2n, customerId: ADA, amount: '20.0000' },
        { id: 3n, customerId: 2n, amount: '5.0000' },
        { id: 4n, customerId: 999n, amount: '7.5000' },
      ]),
    );
    await db.queryRaw(sql`CREATE TABLE ${tableIdentifier(colors)} (NAME VARCHAR NOT NULL)`);
    await db.execute(insert(colors, [{ name: 'red' }, { name: 'blue' }]));
    await db.queryRaw(
      sql`CREATE TABLE ${tableIdentifier(events)} (ID NUMBER(38,0) NOT NULL, PAYLOAD VARIANT NOT NULL)`,
    );
    await db.execute(
      insert(events, [
        {
          id: 1n,
          payload: {
            items: [10, 20],
            tag: 'demo',
            meta: { 'a.b': 1, nested: { deep: 'x' }, empty: null },
          },
        },
        { id: 2n, payload: { items: [], tag: 'empty', meta: {} } },
      ]),
    );
    await db.queryRaw(
      sql`CREATE TABLE ${tableIdentifier(trades)} (SYMBOL VARCHAR NOT NULL, AT_VALUE NUMBER(38,0) NOT NULL)`,
    );
    await db.queryRaw(
      sql`CREATE TABLE ${tableIdentifier(quotes)} (SYMBOL VARCHAR NOT NULL, AT_VALUE NUMBER(38,0) NOT NULL, PRICE NUMBER(38,4) NOT NULL)`,
    );
    await db.execute(
      insert(trades, [
        { symbol: 'A', at: 1n },
        { symbol: 'A', at: 5n },
        { symbol: 'B', at: 5n },
      ]),
    );
    await db.execute(
      insert(quotes, [
        { symbol: 'A', at: 0n, price: '1.0000' },
        { symbol: 'A', at: 4n, price: '2.0000' },
        { symbol: 'B', at: 6n, price: '3.0000' },
        { symbol: 'B', at: 1n, price: '4.0000' },
      ]),
    );
    await db.queryRaw(
      sql`CREATE TABLE ${tableIdentifier(history)} (ID NUMBER(38,0) NOT NULL, LABEL VARCHAR NOT NULL)`,
    );
  });
  afterAll(() => fixture.cleanup());

  it('applies each comparison operator to exact integers and decimals', async () => {
    expect(await ids(eq(c.id, ADA))).toEqual([ADA]);
    expect(await ids(eq(c.id, ADA - 1n))).toEqual([]);
    expect(await ids(ne(c.id, 2n))).toEqual([3n, ADA]);
    expect(await ids(gt(c.id, 2n))).toEqual([3n, ADA]);
    expect(await ids(gte(c.id, 3n))).toEqual([3n, ADA]);
    expect(await ids(lt(c.id, 3n))).toEqual([2n]);
    expect(await ids(lte(c.id, 3n))).toEqual([2n, 3n]);
    expect(await ids(eq(c.balance, '12345678901234567890.1234'))).toEqual([ADA]);
    expect(await ids(lt(c.balance, '0'))).toEqual([2n]);
    expect(await ids(gt(c.balance, '0'))).toEqual([ADA]);
    expect(await ids(eq(c.name, c.name))).toEqual([2n, 3n, ADA]);
  });

  it('follows SQL three-valued logic for nullable comparisons', async () => {
    expect(await ids(eq(c.email, null))).toEqual([ADA]);
    expect(await ids(ne(c.email, null))).toEqual([2n, 3n]);
    expect(await ids(isNotNull(c.email))).toEqual([2n, 3n]);
    expect(await ids(isNull(c.email))).toEqual([ADA]);
    expect(await ids(ne(c.email, 'grace@example.test'))).toEqual([3n]);
    expect(await ids(not(eq(c.email, 'grace@example.test')))).toEqual([3n]);
    expect(await ids(or(isNull(c.email), eq(c.active, false)))).toEqual([2n, ADA]);
  });

  it('composes AND, OR, and NOT with nesting', async () => {
    expect(await ids(and(eq(c.active, true), gt(c.id, 2n)))).toEqual([3n, ADA]);
    expect(await ids(or(eq(c.name, 'Ada'), eq(c.name, 'Linus')))).toEqual([3n, ADA]);
    expect(await ids(not(or(eq(c.name, 'Ada'), eq(c.name, 'Linus'))))).toEqual([2n]);
    expect(
      await ids(
        or(and(eq(c.active, true), isNull(c.email)), and(eq(c.active, false), lt(c.id, 3n))),
      ),
    ).toEqual([2n, ADA]);
    expect(await ids(and(eq(c.active, true)))).toEqual([3n, ADA]);
  });

  it('matches membership lists, including empty and negated lists', async () => {
    expect(await ids(inArray(c.id, [2n, ADA, 404n]))).toEqual([2n, ADA]);
    expect(await ids(inArray(c.id, [2n], true))).toEqual([3n, ADA]);
    expect(await ids(inArray(c.id, []))).toEqual([]);
    expect(await ids(inArray(c.id, [], true))).toEqual([2n, 3n, ADA]);
    expect(await ids(inArray(c.name, ['Grace', "Ada'--"]))).toEqual([2n]);
    expect(await ids(inArray(c.email, ['grace@example.test'], true))).toEqual([3n]);
  });

  it('matches LIKE and ILIKE patterns with wildcards and string functions', async () => {
    expect(await ids(like(c.name, 'G%'))).toEqual([2n]);
    expect(await ids(like(c.name, 'g%'))).toEqual([]);
    expect(await ids(ilike(c.name, 'g%'))).toEqual([2n]);
    expect(await ids(like(c.name, 'L_nus'))).toEqual([3n]);
    expect(await ids(like(c.email, '%@example.test'))).toEqual([2n, 3n]);
    expect(await ids(eq(upper(c.name), 'ADA'))).toEqual([ADA]);
    expect(
      await rows(
        select(customers, { lower: lower(c.name), upper: upper(c.email) }).where(eq(c.id, 2n)),
      ),
    ).toEqual([{ lower: 'grace', upper: 'GRACE@EXAMPLE.TEST' }]);
    expect(await rows(select(customers, { upper: upper(c.email) }).where(eq(c.id, ADA)))).toEqual([
      { upper: null },
    ]);
  });

  it('orders by multiple keys and explicit NULLS placement', async () => {
    const emails = (direction: typeof asc, nulls?: 'FIRST' | 'LAST') =>
      rows(select(customers, { email: c.email }).orderBy(direction(c.email, nulls)));
    expect(await emails(asc, 'FIRST')).toEqual([
      { email: null },
      { email: 'grace@example.test' },
      { email: 'linus@example.test' },
    ]);
    expect(await emails(asc, 'LAST')).toEqual([
      { email: 'grace@example.test' },
      { email: 'linus@example.test' },
      { email: null },
    ]);
    expect(await emails(desc, 'LAST')).toEqual([
      { email: 'linus@example.test' },
      { email: 'grace@example.test' },
      { email: null },
    ]);
    expect(await emails(desc, 'FIRST')).toEqual([
      { email: null },
      { email: 'linus@example.test' },
      { email: 'grace@example.test' },
    ]);
    expect(
      await rows(select(customers, { id: c.id }).orderBy(desc(c.active), asc(c.name))),
    ).toEqual([{ id: ADA }, { id: 3n }, { id: 2n }]);
    expect(
      await rows(select(customers, { id: c.id }).orderBy(asc(c.email, 'FIRST'), desc(c.id))),
    ).toEqual([{ id: ADA }, { id: 2n }, { id: 3n }]);
  });

  it('paginates ordered results with LIMIT and OFFSET', async () => {
    const ordered = select(customers, { id: c.id }).orderBy(asc(c.id));
    expect(await rows(ordered.limit(2))).toEqual([{ id: 2n }, { id: 3n }]);
    expect(await rows(ordered.limit(2).offset(1))).toEqual([{ id: 3n }, { id: ADA }]);
    expect(await rows(ordered.limit(5).offset(2))).toEqual([{ id: ADA }]);
    expect(await rows(ordered.limit(0))).toEqual([]);
    expect(await rows(ordered.limit(10).offset(3))).toEqual([]);
  });

  it('removes duplicates with DISTINCT, alone and with ordering', async () => {
    expect(unordered(await rows(select(customers, { active: c.active }).distinct()))).toEqual([
      { active: false },
      { active: true },
    ]);
    expect(
      await rows(
        select(orders, { customer: o.customerId }).distinct().orderBy(desc(o.customerId)).limit(2),
      ),
    ).toEqual([{ customer: ADA }, { customer: 999n }]);
  });

  it('computes COUNT, SUM, MIN, and MAX over typed columns', async () => {
    expect(
      await rows(
        select(customers, {
          all: count(),
          emails: count(c.email),
          states: count(c.active, true),
          minId: min(c.id),
          maxId: max(c.id),
          minName: min(c.name),
          maxName: max(c.name),
          minBalance: min(c.balance),
          maxBalance: max(c.balance),
          total: sum(c.balance),
          firstEmail: min(c.email),
        }),
      ),
    ).toEqual([
      {
        all: 3n,
        emails: 2n,
        states: 2n,
        minId: 2n,
        maxId: ADA,
        minName: 'Ada',
        maxName: 'Linus',
        minBalance: '-42.5000',
        maxBalance: '12345678901234567890.1234',
        total: '12345678901234567847.6234',
        firstEmail: 'grace@example.test',
      },
    ]);
  });

  it('returns COUNT zero and NULL aggregates over empty input', async () => {
    expect(
      await rows(
        select(orders, {
          count: count(),
          total: sum(o.amount),
          low: min(o.amount),
          high: max(o.id),
        }).where(eq(o.id, 404n)),
      ),
    ).toEqual([{ count: 0n, total: null, low: null, high: null }]);
    expect(
      await rows(
        select(orders, { customer: o.customerId, count: count() })
          .where(eq(o.id, 404n))
          .groupBy(o.customerId),
      ),
    ).toEqual([]);
  });

  it('groups by one or more expressions and filters groups with HAVING', async () => {
    expect(
      unordered(
        await rows(
          select(orders, { customer: o.customerId, orders: count(), total: sum(o.amount) }).groupBy(
            o.customerId,
          ),
        ),
      ),
    ).toEqual(
      unordered([
        { customer: ADA, orders: 2n, total: '30.0000' },
        { customer: 2n, orders: 1n, total: '5.0000' },
        { customer: 999n, orders: 1n, total: '7.5000' },
      ]),
    );
    expect(
      unordered(
        await rows(
          select(customers, { active: c.active, missing: isNull(c.email), count: count() }).groupBy(
            c.active,
            isNull(c.email),
          ),
        ),
      ),
    ).toEqual(
      unordered([
        { active: true, missing: true, count: 1n },
        { active: true, missing: false, count: 1n },
        { active: false, missing: false, count: 1n },
      ]),
    );
    expect(
      await rows(
        select(orders, { customer: o.customerId })
          .groupBy(o.customerId)
          .having(and(gt(sum(o.amount), '6'), lt(count(), 2n)))
          .orderBy(asc(o.customerId)),
      ),
    ).toEqual([{ customer: 999n }]);
  });

  it('evaluates partitioned, ordered, and unpartitioned window aggregates', async () => {
    const query = select(orders, {
      id: o.id,
      customerTotal: over(sum(o.amount), { partitionBy: [o.customerId] }),
      running: over(sum(o.amount), { partitionBy: [o.customerId], orderBy: [asc(o.id)] }),
      all: over(count()),
      cheapest: over(min(o.amount)),
      position: rowNumber({ orderBy: [desc(o.amount)] }),
    }).orderBy(asc(o.id));
    expect(await rows(query)).toEqual([
      {
        id: 1n,
        customerTotal: '30.0000',
        running: '10.0000',
        all: 4n,
        cheapest: '5.0000',
        position: 2n,
      },
      {
        id: 2n,
        customerTotal: '30.0000',
        running: '30.0000',
        all: 4n,
        cheapest: '5.0000',
        position: 1n,
      },
      {
        id: 3n,
        customerTotal: '5.0000',
        running: '5.0000',
        all: 4n,
        cheapest: '5.0000',
        position: 4n,
      },
      {
        id: 4n,
        customerTotal: '7.5000',
        running: '7.5000',
        all: 4n,
        cheapest: '5.0000',
        position: 3n,
      },
    ]);
  });

  it('filters with QUALIFY on unprojected windows and ranks grouped aggregates', async () => {
    const first = rowNumber({ partitionBy: [o.customerId], orderBy: [asc(o.id)] });
    expect(
      await rows(select(orders, { id: o.id }).qualify(eq(first, 1n)).orderBy(asc(o.id))),
    ).toEqual([{ id: 1n }, { id: 3n }, { id: 4n }]);
    const rank = rowNumber({ orderBy: [desc(sum(o.amount))] });
    expect(
      await rows(
        select(orders, { customer: o.customerId, total: sum(o.amount), rank })
          .groupBy(o.customerId)
          .qualify(lte(rank, 2n))
          .orderBy(desc(sum(o.amount))),
      ),
    ).toEqual([
      { customer: ADA, total: '30.0000', rank: 1n },
      { customer: 999n, total: '7.5000', rank: 2n },
    ]);
  });

  it('returns exact projection aliases including case, spaces, and quotes', async () => {
    expect(
      await rows(
        select(customers, {
          'Customer Name': c.name,
          customerName: lower(c.name),
          'say "hi"': upper(c.name),
        }).where(eq(c.id, 2n)),
      ),
    ).toEqual([{ 'Customer Name': 'Grace', customerName: 'grace', 'say "hi"': 'GRACE' }]);
  });

  it('distinguishes aliased self-joins', async () => {
    const left = alias(customers, 'left side');
    const right = alias(customers, 'RIGHT');
    const pairs = await rows(
      select(left)
        .crossJoin(right)
        .select({ a: left.columns.name, b: right.columns.name })
        .where(lt(left.columns.id, right.columns.id)),
    );
    expect(unordered(pairs)).toEqual(
      unordered([
        { a: 'Grace', b: 'Linus' },
        { a: 'Grace', b: 'Ada' },
        { a: 'Linus', b: 'Ada' },
      ]),
    );
  });

  it('executes inner, left, right, full, and cross joins with derived nullability', async () => {
    const pick = { name: c.name, order: o.id };
    const on = eq(o.customerId, c.id);
    expect(unordered(await rows(select(orders).innerJoin(customers, on).select(pick)))).toEqual(
      unordered([
        { name: 'Ada', order: 1n },
        { name: 'Ada', order: 2n },
        { name: 'Grace', order: 3n },
      ]),
    );
    expect(unordered(await rows(select(customers).leftJoin(orders, on).select(pick)))).toEqual(
      unordered([
        { name: 'Ada', order: 1n },
        { name: 'Ada', order: 2n },
        { name: 'Grace', order: 3n },
        { name: 'Linus', order: null },
      ]),
    );
    expect(unordered(await rows(select(orders).rightJoin(customers, on).select(pick)))).toEqual(
      unordered([
        { name: 'Ada', order: 1n },
        { name: 'Ada', order: 2n },
        { name: 'Grace', order: 3n },
        { name: 'Linus', order: null },
      ]),
    );
    expect(unordered(await rows(select(orders).fullJoin(customers, on).select(pick)))).toEqual(
      unordered([
        { name: 'Ada', order: 1n },
        { name: 'Ada', order: 2n },
        { name: 'Grace', order: 3n },
        { name: 'Linus', order: null },
        { name: null, order: 4n },
      ]),
    );
    expect(
      unordered(
        await rows(
          select(customers)
            .crossJoin(colors)
            .select({ name: c.name, color: colors.columns.name })
            .where(eq(c.id, 2n)),
        ),
      ),
    ).toEqual(
      unordered([
        { name: 'Grace', color: 'blue' },
        { name: 'Grace', color: 'red' },
      ]),
    );
    expect(
      await rows(
        select(customers).leftJoin(orders, on).select({ name: c.name }).where(isNull(o.id)),
      ),
    ).toEqual([{ name: 'Linus' }]);
  });

  it('chains joins across base tables and derived sources', async () => {
    const totals = select(orders, { customer: o.customerId, total: sum(o.amount) })
      .groupBy(o.customerId)
      .as('totals');
    const query = select(customers)
      .innerJoin(orders, eq(o.customerId, c.id))
      .innerJoin(totals, eq(totals.columns.customer, c.id))
      .select({ order: o.id, name: c.name, share: totals.columns.total })
      .orderBy(asc(o.id));
    expect(await rows(query)).toEqual([
      { order: 1n, name: 'Ada', share: '30.0000' },
      { order: 2n, name: 'Ada', share: '30.0000' },
      { order: 3n, name: 'Grace', share: '5.0000' },
    ]);
  });

  it('preserves outer-join nullability and native types through nested derived tables', async () => {
    const joined = select(customers)
      .leftJoin(orders, eq(o.customerId, c.id))
      .select({ name: c.name, amount: o.amount })
      .as('joined');
    expect(await rows(select(joined).where(isNull(joined.columns.amount)))).toEqual([
      { name: 'Linus', amount: null },
    ]);
    const totals = select(orders, { customer: o.customerId, total: sum(o.amount) })
      .groupBy(o.customerId)
      .as('t1');
    const big = select(totals, { customer: totals.columns.customer })
      .where(gt(totals.columns.total, '6'))
      .as('t2');
    expect(unordered(await rows(select(big)))).toEqual(
      unordered([{ customer: 999n }, { customer: ADA }]),
    );
    const page = select(orders, { customer: o.customerId })
      .distinct()
      .orderBy(asc(o.customerId))
      .limit(2)
      .as('page');
    expect(await rows(select(page).orderBy(desc(page.columns.customer)))).toEqual([
      { customer: 999n },
      { customer: 2n },
    ]);
  });

  it('joins several CTEs and includes each definition once', async () => {
    const totals = select(orders, { customer: o.customerId, total: sum(o.amount) })
      .groupBy(o.customerId)
      .asCte('totals');
    const active = select(customers, { id: c.id, name: c.name })
      .where(eq(c.active, true))
      .asCte('active customers');
    const query = select(active)
      .leftJoin(totals, eq(totals.columns.customer, active.columns.id))
      .select({ name: active.columns.name, total: totals.columns.total });
    expect(unordered(await rows(query))).toEqual(
      unordered([
        { name: 'Ada', total: '30.0000' },
        { name: 'Linus', total: null },
      ]),
    );
    expect(query.compile().sql.match(/ AS \(SELECT/g)).toHaveLength(2);
  });

  it('reads JSON paths by key, index, and literal dotted key', async () => {
    const p = events.columns.payload;
    const query = select(events, {
      id: events.columns.id,
      tag: jsonPath(p, 'tag'),
      second: jsonPath(p, 'items', 1),
      dotted: jsonPath(p, 'meta', 'a.b'),
      deep: jsonPath(p, 'meta', 'nested', 'deep'),
      explicitNull: jsonPath(p, 'meta', 'empty'),
      missing: jsonPath(p, "x'); DROP TABLE EVENTS; --"),
    }).orderBy(asc(events.columns.id));
    expect(await rows(query)).toEqual([
      {
        id: 1n,
        tag: 'demo',
        second: 20,
        dotted: 1,
        deep: 'x',
        explicitNull: null,
        missing: null,
      },
      {
        id: 2n,
        tag: 'empty',
        second: null,
        dotted: null,
        deep: null,
        explicitNull: null,
        missing: null,
      },
    ]);
    expect(
      await rows(select(events, { id: events.columns.id }).where(isNull(jsonPath(p, 'items', 0)))),
    ).toEqual([{ id: 2n }]);
  });

  it('expands FLATTEN with path, OUTER, OBJECT mode, and RECURSIVE options', async () => {
    const p = events.columns.payload;
    const items = flatten(p, 'items', { path: 'items' });
    expect(
      await rows(
        select(events)
          .lateralJoin(items)
          .select({
            id: events.columns.id,
            seq: items.columns.seq,
            index: items.columns.index,
            value: items.columns.value,
            path: items.columns.path,
          })
          .orderBy(asc(items.columns.index)),
      ),
    ).toEqual([
      { id: 1n, seq: expect.any(BigInt), index: 0n, value: 10, path: 'items[0]' },
      { id: 1n, seq: expect.any(BigInt), index: 1n, value: 20, path: 'items[1]' },
    ]);
    const outer = flatten(jsonPath(p, 'items'), 'outer items', { outer: true });
    expect(
      await rows(
        select(events)
          .lateralJoin(outer)
          .select({ id: events.columns.id, value: outer.columns.value, index: outer.columns.index })
          .where(eq(events.columns.id, 2n)),
      ),
    ).toEqual([{ id: 2n, value: null, index: null }]);
    const keys = flatten(jsonPath(p, 'meta'), 'keys', { mode: 'OBJECT' });
    expect(
      unordered(
        await rows(
          select(events)
            .lateralJoin(keys)
            .select({ key: keys.columns.key, value: keys.columns.value, this: keys.columns.this })
            .where(eq(events.columns.id, 1n)),
        ),
      ).map((row) => [row.key, row.value]),
    ).toEqual([
      ['a.b', 1],
      ['empty', null],
      ['nested', { deep: 'x' }],
    ]);
    const all = flatten(p, 'all', { recursive: true });
    const paths = (
      await rows(
        select(events)
          .lateralJoin(all)
          .select({ path: all.columns.path })
          .where(eq(events.columns.id, 1n)),
      )
    ).map((row) => row.path);
    expect(paths).toEqual(
      expect.arrayContaining(['items[1]', "meta['a.b']", 'meta.nested.deep', 'tag']),
    );
  });

  it('matches ASOF joins with and without key predicates in both directions', async () => {
    const t = trades.columns;
    const q = quotes.columns;
    const asof = (match: Predicate<'TRADES' | 'QUOTES'>, keyed: boolean) =>
      rows(
        select(trades)
          .asofJoin(quotes, match, keyed ? eq(t.symbol, q.symbol) : undefined)
          .select({ symbol: t.symbol, at: t.at, price: q.price })
          .orderBy(asc(t.symbol), asc(t.at)),
      );
    expect(await asof(gte(t.at, q.at), true)).toEqual([
      { symbol: 'A', at: 1n, price: '1.0000' },
      { symbol: 'A', at: 5n, price: '2.0000' },
      { symbol: 'B', at: 5n, price: '4.0000' },
    ]);
    expect(await asof(lte(t.at, q.at), true)).toEqual([
      { symbol: 'A', at: 1n, price: '2.0000' },
      { symbol: 'A', at: 5n, price: null },
      { symbol: 'B', at: 5n, price: '3.0000' },
    ]);
    expect(await asof(lt(t.at, q.at), false)).toEqual([
      { symbol: 'A', at: 1n, price: '2.0000' },
      { symbol: 'A', at: 5n, price: '3.0000' },
      { symbol: 'B', at: 5n, price: '3.0000' },
    ]);
  });

  it('reads AT and BEFORE snapshots by statement, offset, and timestamp', async () => {
    await db.execute(insert(history, { id: 1n, label: 'first' }));
    const [moment] = await db.queryRaw<[{ OFFSET: string; LOCAL: string }]>`
      SELECT TO_VARCHAR(CURRENT_TIMESTAMP(), 'YYYY-MM-DD"T"HH24:MI:SS.FF9TZH:TZM') AS OFFSET,
        TO_VARCHAR(CURRENT_TIMESTAMP(), 'YYYY-MM-DD HH24:MI:SS.FF9') AS LOCAL`;
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const second = await db.execute(insert(history, { id: 2n, label: 'second' }));
    const snapshot = async (table: typeof history) =>
      (await rows(select(table, { id: table.columns.id }))).map((row) => row.id).sort();
    expect(await snapshot(timeTravel(history, { statement: second.queryId }))).toEqual([1n, 2n]);
    expect(await snapshot(timeTravel(history, { statement: second.queryId }, 'BEFORE'))).toEqual([
      1n,
    ]);
    expect(await snapshot(timeTravel(history, { timestamp: moment.OFFSET }))).toEqual([1n]);
    expect(await snapshot(timeTravel(history, { timestamp: moment.LOCAL }))).toEqual([1n]);
    expect(await snapshot(timeTravel(history, { offset: 0 }))).toEqual([1n, 2n]);
    const before = alias(timeTravel(history, { statement: second.queryId }, 'BEFORE'), 'before');
    expect(
      await rows(
        select(history)
          .leftJoin(before, eq(before.columns.id, history.columns.id))
          .select({ added: history.columns.label })
          .where(isNull(before.columns.id)),
      ),
    ).toEqual([{ added: 'second' }]);
  });
});
