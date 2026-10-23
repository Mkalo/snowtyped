import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as z from 'zod';
import {
  alias,
  and,
  array,
  asc,
  binary,
  count,
  date,
  decimal,
  deleteFrom,
  desc,
  eq,
  flatten,
  float,
  generateSchema,
  gt,
  gte,
  inArray,
  insert,
  integer,
  introspect,
  isNull,
  jsonPath,
  lower,
  mergeInto,
  object,
  rowNumber,
  select,
  snowflakeTable,
  sql,
  sum,
  text,
  time,
  timestamp,
  timeTravel,
  update,
  variant,
} from '../../src/index.js';
import { createPool } from '../../src/snowflake/index.js';
import { createFixture, integrationConfig } from '../support/snowflake.js';

describe('complete query and execution paths against Snowflake', () => {
  const fixture = createFixture(integrationConfig());
  const db = fixture.client;
  const database = fixture.table.node.parts[0] as string;
  const namespace = { database, schema: fixture.schemaName };
  const customers = fixture.table;
  const orders = snowflakeTable(
    'ORDERS',
    {
      id: integer('ID').notNull(),
      customerId: integer('CUSTOMER_ID').notNull(),
      amount: decimal('AMOUNT').notNull(),
    },
    namespace,
  );
  const writes = snowflakeTable(
    'WRITES',
    { id: integer('ID').notNull(), name: text('NAME').notNull() },
    namespace,
  );
  const staged = snowflakeTable(
    'STAGED',
    { id: integer('ID').notNull(), name: text('NAME').notNull() },
    namespace,
  );
  const events = snowflakeTable(
    'EVENTS',
    {
      id: integer('ID').notNull(),
      payload: variant(
        'PAYLOAD',
        z.object({ items: z.array(z.number()), tag: z.string() }),
      ).notNull(),
    },
    namespace,
  );
  const trades = snowflakeTable('TRADES', { at: integer('AT_VALUE').notNull() }, namespace);
  const quotes = snowflakeTable(
    'QUOTES',
    { at: integer('AT_VALUE').notNull(), price: decimal('PRICE').notNull() },
    namespace,
  );
  const types = snowflakeTable(
    'TYPES',
    {
      id: integer('ID').notNull(),
      value: float('VALUE').notNull(),
      day: date('DAY').notNull(),
      clock: time('CLOCK').notNull(),
      at: timestamp('AT_VALUE').notNull(),
      data: binary('DATA').notNull(),
      payload: variant('PAYLOAD', z.object({ ok: z.boolean() })).notNull(),
    },
    namespace,
  );
  const constrained = snowflakeTable(
    'CONSTRAINED',
    {
      id: integer('ID', { precision: 3 }).notNull(),
      amount: decimal('AMOUNT', { precision: 5, scale: 2 }),
      code: text('CODE', { length: 3 }),
      data: binary('DATA', { length: 2 }),
      clock: time('CLOCK', { precision: 3 }),
      at: timestamp('AT_VALUE', 'ltz', { precision: 0 }),
    },
    namespace,
  );
  const docs = snowflakeTable(
    'DOCS',
    {
      id: integer('ID').notNull(),
      tags: array('TAGS', z.string()).notNull(),
      items: array('ITEMS'),
      meta: object('META', z.strictObject({ ok: z.boolean(), note: z.string().nullable() })),
      extra: object('EXTRA'),
    },
    namespace,
  );
  const nullable = snowflakeTable(
    'NULLABLE_TYPES',
    {
      id: integer('ID').notNull(),
      data: binary('DATA'),
      payload: variant('PAYLOAD', z.object({ ok: z.boolean() })),
      at: timestamp('AT_VALUE'),
      day: date('DAY'),
    },
    namespace,
  );
  const nullSource = snowflakeTable('NULL_SOURCE', { id: integer('ID').notNull() }, namespace);
  const doubles = snowflakeTable(
    'DOUBLES',
    { id: integer('ID').notNull(), value: float('VALUE').notNull() },
    namespace,
  );
  const name = (table: { node: { parts: readonly string[] } }) =>
    sql.identifier(...(table.node.parts as [string, ...string[]]));

  beforeAll(async () => {
    await fixture.seed();
    await db.queryRaw(
      sql`CREATE TABLE ${name(orders)} (ID NUMBER(38,0) NOT NULL, CUSTOMER_ID NUMBER(38,0) NOT NULL, AMOUNT NUMBER(38,4) NOT NULL)`,
    );
    await db.execute(
      insert(orders, [
        { id: 1n, customerId: 9007199254740993n, amount: '10.0000' },
        { id: 2n, customerId: 9007199254740993n, amount: '20.0000' },
        { id: 3n, customerId: 2n, amount: '5.0000' },
      ]),
    );
    await db.queryRaw(
      sql`CREATE TABLE ${name(writes)} (ID NUMBER(38,0) NOT NULL, NAME VARCHAR NOT NULL)`,
    );
    await db.queryRaw(
      sql`CREATE TABLE ${name(staged)} (ID NUMBER(38,0) NOT NULL, NAME VARCHAR NOT NULL)`,
    );
    await db.execute(
      insert(staged, [
        { id: 100n, name: 'updated' },
        { id: 101n, name: 'inserted' },
      ]),
    );
    await db.queryRaw(
      sql`CREATE TABLE ${name(events)} (ID NUMBER(38,0) NOT NULL, PAYLOAD VARIANT NOT NULL)`,
    );
    await db.execute(insert(events, { id: 1n, payload: { items: [10, 20], tag: 'demo' } }));
    await db.queryRaw(sql`CREATE TABLE ${name(trades)} (AT_VALUE NUMBER(38,0) NOT NULL)`);
    await db.queryRaw(
      sql`CREATE TABLE ${name(quotes)} (AT_VALUE NUMBER(38,0) NOT NULL, PRICE NUMBER(38,4) NOT NULL)`,
    );
    await db.execute(insert(trades, [{ at: 0n }, { at: 3n }]));
    await db.execute(
      insert(quotes, [
        { at: 1n, price: '10.0000' },
        { at: 2n, price: '11.0000' },
      ]),
    );
    await db.queryRaw(
      sql`CREATE TABLE ${name(types)} (ID NUMBER(38,0) NOT NULL, VALUE DOUBLE NOT NULL, DAY DATE NOT NULL, CLOCK TIME(9) NOT NULL, AT_VALUE TIMESTAMP_NTZ(9) NOT NULL, DATA BINARY NOT NULL, PAYLOAD VARIANT NOT NULL)`,
    );
    await db.queryRaw(
      sql`CREATE TABLE ${name(constrained)} (ID NUMBER(3,0) NOT NULL, AMOUNT NUMBER(5,2), CODE VARCHAR(3), DATA BINARY(2), CLOCK TIME(3), AT_VALUE TIMESTAMP_LTZ(0))`,
    );
    await db.queryRaw(
      sql`CREATE TABLE ${name(docs)} (ID NUMBER(38,0) NOT NULL, TAGS ARRAY NOT NULL, ITEMS ARRAY, META OBJECT, EXTRA OBJECT)`,
    );
    await db.queryRaw(
      sql`CREATE TABLE ${name(nullable)} (ID NUMBER(38,0) NOT NULL, DATA BINARY, PAYLOAD VARIANT, AT_VALUE TIMESTAMP_NTZ(9), DAY DATE)`,
    );
    await db.queryRaw(sql`CREATE TABLE ${name(nullSource)} (ID NUMBER(38,0) NOT NULL)`);
  });
  afterAll(() => fixture.cleanup());

  it('executes both typed and unknown raw tags with safe identifier and value composition', async () => {
    const value = await db.queryRaw<{ VALUE: string }[]>`SELECT ${42} AS VALUE`;
    expect(value).toEqual([{ VALUE: '42' }]);
    const filter = sql`NAME = ${"Ada'; DROP TABLE CUSTOMERS; --"}`;
    expect(await db.queryRaw(sql`SELECT * FROM ${name(customers)} WHERE ${filter}`)).toEqual([]);
  });

  it('composes filters, ordering, pagination, and functions', async () => {
    const query = select(customers, { name: lower(customers.columns.name) })
      .where(and(inArray(customers.columns.id, [2n, 3n]), gt(customers.columns.id, 1n)))
      .orderBy(desc(lower(customers.columns.name)))
      .limit(1)
      .offset(1)
      .distinct();
    expect((await db.execute(query)).rows).toEqual([{ name: 'grace' }]);
  });

  it('derives nullable outer-join outputs and respects aliases', async () => {
    const c = alias(customers, 'c');
    const o = alias(orders, 'o');
    const query = select(c)
      .leftJoin(o, eq(c.columns.id, o.columns.customerId))
      .select({ name: c.columns.name, amount: o.columns.amount })
      .where(eq(c.columns.id, 3n));
    expect((await db.execute(query)).rows).toEqual([{ name: 'Linus', amount: null }]);
    const matched = select(c)
      .innerJoin(o, eq(c.columns.id, o.columns.customerId))
      .select({ name: c.columns.name, amount: o.columns.amount })
      .where(eq(o.columns.id, 3n));
    expect((await db.execute(matched)).rows).toEqual([{ name: 'Grace', amount: '5.0000' }]);
  });

  it('groups and validates aggregate results and HAVING predicates', async () => {
    const total = sum(orders.columns.amount);
    const query = select(orders, { customer: orders.columns.customerId, count: count(), total })
      .groupBy(orders.columns.customerId)
      .having(gt(count(), 1n));
    expect((await db.execute(query)).rows).toEqual([
      { customer: 9007199254740993n, count: 2n, total: '30.0000' },
    ]);
  });

  it('runs QUALIFY with a typed window expression', async () => {
    const ranking = rowNumber({
      partitionBy: [orders.columns.customerId],
      orderBy: [desc(orders.columns.amount)],
    });
    const query = select(orders, { id: orders.columns.id, rank: ranking })
      .qualify(eq(ranking, 1n))
      .orderBy(asc(orders.columns.id));
    expect((await db.execute(query)).rows).toEqual([
      { id: 2n, rank: 1n },
      { id: 3n, rank: 1n },
    ]);
  });

  it('orders grouped queries by windows over aggregates', async () => {
    const rank = rowNumber({ orderBy: [desc(sum(orders.columns.amount))] });
    const projected = select(orders, { customer: orders.columns.customerId, rank })
      .groupBy(orders.columns.customerId)
      .orderBy(desc(rank));
    expect((await db.execute(projected)).rows).toEqual([
      { customer: 2n, rank: 2n },
      { customer: 9007199254740993n, rank: 1n },
    ]);
    expect((await db.execute(projected.limit(1))).rows).toEqual([{ customer: 2n, rank: 2n }]);
    const hidden = select(orders, { customer: orders.columns.customerId })
      .groupBy(orders.columns.customerId)
      .orderBy(asc(rank));
    expect((await db.execute(hidden)).rows).toEqual([
      { customer: 9007199254740993n },
      { customer: 2n },
    ]);
  });

  it('orders by a column that shares its name with another projection alias', async () => {
    const byName = [{ NAME: null }, { NAME: 'grace@example.test' }, { NAME: 'linus@example.test' }];
    const { email, id, name } = customers.columns;
    expect((await db.execute(select(customers, { NAME: email }).orderBy(asc(name)))).rows).toEqual(
      byName,
    );
    expect(
      (
        await db.execute(
          select(customers, { NAME: email })
            .orderBy(asc(lower(name)))
            .limit(1),
        )
      ).rows,
    ).toEqual(byName.slice(0, 1));
    expect(
      (await db.execute(select(customers, { NAME: email, ID: name }).orderBy(asc(id)))).rows.map(
        (row) => row.ID,
      ),
    ).toEqual(['Grace', 'Linus', 'Ada']);
    expect((await db.execute(select(customers, { NAME: id }).orderBy(desc(name)))).rows).toEqual([
      { NAME: 3n },
      { NAME: 2n },
      { NAME: 9007199254740993n },
    ]);
  });

  it('composes derived sources and CTEs with validated wire decoding', async () => {
    const source = select(orders, {
      customer: orders.columns.customerId,
      total: sum(orders.columns.amount),
    }).groupBy(orders.columns.customerId);
    const derived = source.as('totals');
    expect(
      (await db.execute(select(derived).where(eq(derived.columns.customer, 2n)))).rows,
    ).toEqual([{ customer: 2n, total: '5.0000' }]);
    const cte = source.asCte('totals');
    expect((await db.execute(select(cte).where(gt(cte.columns.total, '10.0000')))).rows).toEqual([
      { customer: 9007199254740993n, total: '30.0000' },
    ]);
    expect((await db.execute(select(cte).where(eq(cte.columns.customer, 2n)))).rows).toEqual([
      { customer: 2n, total: '5.0000' },
    ]);
  });

  it('supports validated VARIANT declarations, JSON paths, and correlated FLATTEN', async () => {
    expect((await db.execute(select(events))).rows).toEqual([
      { id: 1n, payload: { items: [10, 20], tag: 'demo' } },
    ]);
    const flattened = flatten(jsonPath(events.columns.payload, 'items'), 'f');
    const query = select(events)
      .lateralJoin(flattened)
      .select({
        id: events.columns.id,
        value: flattened.columns.value,
        index: flattened.columns.index,
      })
      .orderBy(asc(flattened.columns.index));
    expect((await db.execute(query)).rows).toEqual([
      { id: 1n, value: 10, index: 0n },
      { id: 1n, value: 20, index: 1n },
    ]);
  });

  it('models ASOF joins including unmatched right-hand rows', async () => {
    const query = select(trades)
      .asofJoin(quotes, gte(trades.columns.at, quotes.columns.at))
      .select({ at: trades.columns.at, price: quotes.columns.price })
      .orderBy(asc(trades.columns.at));
    expect((await db.execute(query)).rows).toEqual([
      { at: 0n, price: null },
      { at: 3n, price: '11.0000' },
    ]);
  });

  it('executes parameterized time travel', async () => {
    const historical = timeTravel(customers, { offset: 0 });
    expect(
      (await db.execute(select(historical, { name: historical.columns.name }))).rows,
    ).toHaveLength(3);
  });

  it('honors the UTC offset of time-travel timestamps', async () => {
    const history = snowflakeTable('HISTORY', { id: integer('ID').notNull() }, namespace);
    await db.queryRaw(sql`CREATE TABLE ${name(history)} (ID NUMBER(38,0) NOT NULL)`);
    await db.execute(insert(history, { id: 1n }));
    await db.queryRaw(sql`SELECT SYSTEM$WAIT(1)`);
    const [moment] = await db.queryRaw<{ AT: string }[]>(
      sql`SELECT TO_VARCHAR(CONVERT_TIMEZONE('Etc/GMT+7', CURRENT_TIMESTAMP()), 'YYYY-MM-DD"T"HH24:MI:SS.FF9TZH:TZM') AS AT`,
    );
    const timestamp = moment?.AT as string;
    expect(timestamp).toMatch(/-07:00$/);
    await db.queryRaw(sql`SELECT SYSTEM$WAIT(1)`);
    await db.execute(insert(history, { id: 2n }));
    for (const mode of ['AT', 'BEFORE'] as const) {
      const snapshot = timeTravel(history, { timestamp }, mode);
      expect((await db.execute(select(snapshot))).rows).toEqual([{ id: 1n }]);
    }
  });

  it('supports INSERT, UPDATE, DELETE, and MERGE', async () => {
    await db.execute(insert(writes, { id: 100n, name: 'old' }));
    await db.execute(update(writes, { name: 'changed' }).where(eq(writes.columns.id, 100n)));
    expect((await db.execute(select(writes))).rows).toEqual([{ id: 100n, name: 'changed' }]);
    const merge = mergeInto(writes, staged, eq(writes.columns.id, staged.columns.id))
      .whenMatchedUpdate({ name: staged.columns.name })
      .whenNotMatchedInsert({ id: staged.columns.id, name: staged.columns.name });
    expect((await db.execute(merge)).queryId).toBeTruthy();
    expect((await db.execute(select(writes).orderBy(asc(writes.columns.id)))).rows).toEqual([
      { id: 100n, name: 'updated' },
      { id: 101n, name: 'inserted' },
    ]);
    await db.execute(deleteFrom(writes).where(eq(writes.columns.id, 101n)));
    expect((await db.execute(select(writes))).rows).toHaveLength(1);
  });

  it('round-trips floating, temporal, binary, and shaped JSON columns', async () => {
    await db.execute(
      insert(types, {
        id: 1n,
        value: 1.25,
        day: '2026-10-22',
        clock: '12:34:56.123456789',
        at: '2026-10-22 12:34:56.123456789',
        data: new Uint8Array([0, 42, 255]),
        payload: { ok: true },
      }),
    );
    const row = (await db.execute(select(types))).rows[0];
    expect(row?.value).toBe(1.25);
    expect(row?.day).toContain('2026-10-22');
    expect(row?.clock).toContain('12:34:56.123456789');
    expect(row?.at).toContain('123456789');
    expect([...(row?.data ?? [])]).toEqual([0, 42, 255]);
    expect(row?.payload).toEqual({ ok: true });
  });

  it('round-trips constraint boundaries and rejects values Snowflake would narrow', async () => {
    for (const row of [
      {
        id: 999n,
        amount: '999.99',
        code: '😀😀😀',
        data: new Uint8Array([0, 255]),
        clock: '23:59:59.999',
        at: '2026-10-22 12:34:56',
      },
      { id: -999n, amount: '-999.99', code: 'abc', clock: '00:00:00.100000' },
      { id: 0n },
    ])
      await db.execute(insert(constrained, row));
    const rows = (await db.execute(select(constrained).orderBy(asc(constrained.columns.id)))).rows;
    expect(rows.map((row) => ({ ...row, data: row.data && [...row.data] }))).toMatchObject([
      { id: -999n, amount: '-999.99', code: 'abc', data: null, clock: '00:00:00.100000000' },
      { id: 0n, amount: null, code: null, data: null, clock: null, at: null },
      {
        id: 999n,
        amount: '999.99',
        code: '😀😀😀',
        data: [0, 255],
        clock: '23:59:59.999000000',
        at: expect.stringContaining('2026-10-22 12:34:56.000000000'),
      },
    ]);
    for (const values of [
      { id: 1000n },
      { id: 1n, amount: '1.234' },
      { id: 1n, amount: '1000' },
      { id: 1n, code: 'abcd' },
      { id: 1n, data: new Uint8Array(3) },
      { id: 1n, clock: '12:00:00.0001' },
      { id: 1n, at: '2026-10-22 12:34:56.7' },
      { id: 1n, at: '1700000000123' },
    ])
      expect(() => insert(constrained, values)).toThrow('does not fit');
    await db.execute(insert(constrained, { id: 1n, at: '1700000000000' }));
    expect(
      await db.queryRaw(
        sql`SELECT TO_CHAR(CONVERT_TIMEZONE('UTC', AT_VALUE), 'YYYY-MM-DD HH24:MI:SS.FF3') AS AT FROM ${name(constrained)} WHERE ID = ${1}`,
      ),
    ).toEqual([{ AT: '2023-11-14 22:13:20.000' }]);
    await db.queryRaw(
      sql`UPDATE ${name(constrained)} SET AMOUNT = ${'1.23'}, CODE = ${'abc'} WHERE ID = ${0}`,
    );
    const narrower = snowflakeTable(
      'CONSTRAINED',
      { id: integer('ID').notNull(), code: text('CODE', { length: 2 }) },
      namespace,
    );
    await expect(db.execute(select(narrower).where(eq(narrower.columns.id, 0n)))).rejects.toThrow(
      'VARCHAR(2)',
    );
    const tables = await introspect(db, namespace);
    const code = generateSchema(tables.filter((table) => table.name === 'CONSTRAINED'));
    for (const declaration of [
      '"ID": integer("ID", { precision: 3 }).notNull()',
      '"AMOUNT": decimal("AMOUNT", { precision: 5, scale: 2 })',
      '"CODE": text("CODE", { length: 3 })',
      '"DATA": binary("DATA")',
      '"CLOCK": time("CLOCK", { precision: 3 })',
      '"AT_VALUE": timestamp("AT_VALUE", "ltz", { precision: 0 })',
    ])
      expect(code).toContain(declaration);
  });

  it('round-trips semi-structured ARRAY and OBJECT columns', async () => {
    await db.execute(
      insert(docs, [
        { id: 1n, tags: [], items: null, meta: null },
        {
          id: 2n,
          tags: ['a', 'b'],
          items: [1, null, { nested: [true] }],
          meta: { ok: true, note: null },
          extra: { empty: {} },
        },
      ]),
    );
    await db.execute(
      update(docs, { items: ['updated'], meta: { ok: false, note: 'x' } }).where(
        eq(docs.columns.id, 1n),
      ),
    );
    await db.execute(
      mergeInto(docs, staged, eq(docs.columns.id, staged.columns.id)).whenNotMatchedInsert({
        id: staged.columns.id,
        tags: ['merged'],
        extra: { k: 1 },
      }),
    );
    const rows = (await db.execute(select(docs).orderBy(asc(docs.columns.id)))).rows;
    expect(rows).toEqual([
      { id: 1n, tags: [], items: ['updated'], meta: { ok: false, note: 'x' }, extra: null },
      {
        id: 2n,
        tags: ['a', 'b'],
        items: [1, null, { nested: [true] }],
        meta: { ok: true, note: null },
        extra: { empty: {} },
      },
      { id: 100n, tags: ['merged'], items: null, meta: null, extra: { k: 1 } },
      { id: 101n, tags: ['merged'], items: null, meta: null, extra: { k: 1 } },
    ]);
    const matched = await db.execute(
      select(docs)
        .select({ id: docs.columns.id })
        .where(eq(docs.columns.meta, { ok: true, note: null })),
    );
    expect(matched.rows).toEqual([{ id: 2n }]);
    const items = select(docs)
      .select({ items: docs.columns.items })
      .where(eq(docs.columns.id, 100n));
    await db.queryRaw(
      sql`UPDATE ${name(docs)} SET ITEMS = PARSE_JSON(${'[1.50, 2.5e-3, 9007199254740991, 1e300]'}) WHERE ID = ${100}`,
    );
    expect((await db.execute(items)).rows).toEqual([
      { items: [1.5, 0.0025, 9007199254740991, 1e300] },
    ]);
    await db.queryRaw(
      sql`UPDATE ${name(docs)} SET ITEMS = ARRAY_CONSTRUCT(1, NULL, ${'undefined'}) WHERE ID = ${100}`,
    );
    expect((await db.execute(items)).rows).toEqual([{ items: [1, null, 'undefined'] }]);
    await db.queryRaw(
      sql`UPDATE ${name(docs)} SET ITEMS = ARRAY_CONSTRUCT(5e-324::DOUBLE, PARSE_JSON(${'1e-310'}), PI()) WHERE ID = ${100}`,
    );
    expect((await db.execute(items)).rows).toEqual([{ items: [5e-324, 1e-310, Math.PI] }]);
    for (const json of ['[12345678901234567890]', '[0.1234567890123456789]']) {
      await db.queryRaw(
        sql`UPDATE ${name(docs)} SET ITEMS = PARSE_JSON(${json}) WHERE ID = ${100}`,
      );
      await expect(db.execute(items)).rejects.toThrow('does not fit a JavaScript number');
    }
    await db.queryRaw(sql`UPDATE ${name(docs)} SET TAGS = ARRAY_CONSTRUCT(1) WHERE ID = ${101}`);
    await expect(db.execute(select(docs))).rejects.toThrow();

    const structured = snowflakeTable('STRUCTURED', { id: integer('ID') }, namespace);
    await db.queryRaw(
      sql`CREATE TABLE ${name(structured)} (ID NUMBER, SA ARRAY(NUMBER), SO OBJECT(city VARCHAR))`,
    );
    try {
      const tables = await introspect(db, namespace);
      const code = generateSchema(tables.filter((table) => table.name === 'DOCS'));
      for (const declaration of [
        '"TAGS": array("TAGS").notNull()',
        '"ITEMS": array("ITEMS")',
        '"META": object("META")',
      ])
        expect(code).toContain(declaration);
      const table = tables.find((entry) => entry.name === 'STRUCTURED');
      expect(table?.columns.map((column) => column.dataType)).toEqual([
        'NUMBER',
        'ARRAY(NUMBER)',
        'OBJECT(CITY VARCHAR)',
      ]);
      expect(() => generateSchema(tables.filter((entry) => entry.name === 'STRUCTURED'))).toThrow(
        'ARRAY(NUMBER)',
      );
    } finally {
      await db.queryRaw(sql`DROP TABLE ${name(structured)}`);
    }
  });

  it('writes NULL to typed columns alone and mixed with values', async () => {
    const empty = { data: null, payload: null, at: null, day: null };
    await db.execute(insert(nullable, { id: 1n, ...empty }));
    await db.execute(
      insert(nullable, [
        {
          id: 2n,
          data: new Uint8Array([1, 2]),
          payload: { ok: true },
          at: '2026-10-23 01:02:03.000000000',
          day: '2026-10-23',
        },
        { id: 3n, ...empty },
        { id: 4n },
      ]),
    );
    await db.execute(insert(nullable, [{ id: 5n }, { id: 6n, payload: { ok: false } }]));
    const read = async () =>
      (await db.execute(select(nullable).orderBy(asc(nullable.columns.id)))).rows.map((row) => ({
        ...row,
        data: row.data && [...row.data],
      }));
    expect(await read()).toEqual([
      { id: 1n, ...empty },
      {
        id: 2n,
        data: [1, 2],
        payload: { ok: true },
        at: '2026-10-23 01:02:03.000000000',
        day: '2026-10-23',
      },
      { id: 3n, ...empty },
      { id: 4n, ...empty },
      { id: 5n, ...empty },
      { id: 6n, ...empty, payload: { ok: false } },
    ]);
    await db.execute(update(nullable, empty).where(eq(nullable.columns.id, 2n)));
    await db.execute(insert(nullSource, [{ id: 1n }, { id: 7n }]));
    await db.execute(
      mergeInto(
        nullable,
        nullSource,
        eq(nullable.columns.id, nullSource.columns.id),
      ).whenNotMatchedInsert({
        id: nullSource.columns.id,
        payload: null,
      }),
    );
    const rows = await read();
    expect(rows.find((row) => row.id === 2n)).toEqual({ id: 2n, ...empty });
    expect(rows.filter((row) => row.id >= 7n)).toEqual([{ id: 7n, ...empty }]);
  });

  it('reads every DOUBLE exactly, including extremes and subnormals', async () => {
    const values = [
      123456789.12345679,
      0.30000000000000004,
      Number.MAX_VALUE,
      -Number.MAX_VALUE,
      Number.MIN_VALUE,
      2.225073858507201e-308,
      2.2250738585072014e-308,
      9007199254740991,
    ];
    await db.queryRaw(
      sql`CREATE TABLE ${name(doubles)} (ID NUMBER(38,0) NOT NULL, VALUE DOUBLE NOT NULL)`,
    );
    await db.execute(
      insert(
        doubles,
        values.map((value, index) => ({ id: BigInt(index), value })),
      ),
    );
    const rows = (await db.execute(select(doubles).orderBy(asc(doubles.columns.id)))).rows;
    expect(rows.map((row) => row.value)).toEqual(values);
  });

  it('streams schema-validated results and raw rows', async () => {
    const rows = [];
    for await (const row of db.stream(select(customers, { id: customers.columns.id })))
      rows.push(row);
    expect(rows).toHaveLength(3);
    expect(typeof rows[0]?.id).toBe('bigint');
    const raw = [];
    for await (const row of db.streamRaw<{ ID: string }>(sql`SELECT ID FROM ${name(customers)}`))
      raw.push(row);
    expect(raw).toHaveLength(3);
    for await (const _row of db.stream(select(customers))) break;
  });

  it('cancels a live request on timeout', async () => {
    await expect(async () => {
      for await (const _row of db.streamRaw(sql`SELECT SYSTEM$WAIT(10)`, { timeoutMs: 50 })) {
        /* consume */
      }
    }).rejects.toThrow();
  });

  it('cancels live buffered raw queries on deadline and abort', async () => {
    const cancelled = sql`
      SELECT QUERY_TEXT, ERROR_CODE
      FROM TABLE(INFORMATION_SCHEMA.QUERY_HISTORY_BY_SESSION())
      WHERE QUERY_TEXT LIKE 'SELECT SYSTEM$WAIT(10) AS RAW!_%' ESCAPE '!'
      ORDER BY QUERY_TEXT
    `;
    const started = Date.now();
    await expect(
      db.queryRaw(sql`SELECT SYSTEM$WAIT(10) AS RAW_DEADLINE`, { timeoutMs: 1_000 }),
    ).rejects.toMatchObject({ name: 'TimeoutError' });
    const controller = new AbortController();
    const reason = new Error('live abort');
    const pending = db.queryRaw(sql`SELECT SYSTEM$WAIT(10) AS RAW_ABORT`, {
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(reason), 1_000);
    await expect(pending).rejects.toBe(reason);
    expect(Date.now() - started).toBeLessThan(10_000);
    await vi.waitFor(
      async () =>
        expect(await db.queryRaw(cancelled)).toEqual([
          { QUERY_TEXT: 'SELECT SYSTEM$WAIT(10) AS RAW_ABORT', ERROR_CODE: '604' },
          { QUERY_TEXT: 'SELECT SYSTEM$WAIT(10) AS RAW_DEADLINE', ERROR_CODE: '604' },
        ]),
      { timeout: 8_000, interval: 500 },
    );
    const pool = await createPool(integrationConfig(), { max: 1 });
    try {
      await expect(
        pool.queryRaw(sql`SELECT SYSTEM$WAIT(10) AS RAW_POOLED`, { timeoutMs: 1_000 }),
      ).rejects.toMatchObject({ name: 'TimeoutError' });
      await vi.waitFor(
        async () =>
          expect(await pool.queryRaw(cancelled)).toEqual([
            { QUERY_TEXT: 'SELECT SYSTEM$WAIT(10) AS RAW_POOLED', ERROR_CODE: '604' },
          ]),
        { timeout: 8_000, interval: 500 },
      );
    } finally {
      await pool.close();
    }
  });

  it('commits and rolls back DML on a pinned session', async () => {
    await db.transaction(async (tx) => {
      await tx.execute(insert(writes, { id: 200n, name: 'committed' }));
    });
    expect((await db.execute(select(writes).where(eq(writes.columns.id, 200n)))).rows).toHaveLength(
      1,
    );
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(insert(writes, { id: 201n, name: 'rolled back' }));
        throw new Error('rollback fixture');
      }),
    ).rejects.toThrow('rollback fixture');
    expect((await db.execute(select(writes).where(eq(writes.columns.id, 201n)))).rows).toEqual([]);
  });

  it('uses the official SDK connection pool and releases streams', async () => {
    const pool = await createPool(integrationConfig(), { max: 2 });
    try {
      expect((await pool.execute(select(customers))).rows).toHaveLength(3);
      expect(await pool.queryRaw<{ VALUE: string }[]>`SELECT 42 AS VALUE`).toEqual([
        { VALUE: '42' },
      ]);
      for await (const _row of pool.stream(select(customers))) break;
      expect(
        await pool.transaction(
          async (tx) => (await tx.queryRaw<{ VALUE: string }[]>`SELECT 1 AS VALUE`)[0]?.VALUE,
        ),
      ).toBe('1');
    } finally {
      await pool.close();
    }
  });

  it('destroys a pooled connection whose ROLLBACK failed', async () => {
    const pool = await createPool(integrationConfig(), { max: 1 });
    try {
      let aborted: string | undefined;
      const failure = await pool
        .transaction(async (tx) => {
          const [row] = await tx.queryRaw<{ ID: string }[]>`SELECT CURRENT_SESSION() AS ID`;
          aborted = row?.ID;
          await tx.queryRaw`SELECT SYSTEM$ABORT_SESSION(${Number(aborted)})`;
          throw new Error('aborted session fixture');
        })
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(AggregateError);
      expect((failure as AggregateError).errors[0]).toHaveProperty(
        'message',
        'aborted session fixture',
      );
      const [row] = await pool.queryRaw<{ ID: string }[]>`SELECT CURRENT_SESSION() AS ID`;
      expect(row?.ID).toBeDefined();
      expect(row?.ID).not.toBe(aborted);
    } finally {
      await pool.close();
    }
  });

  it('introspects the dedicated schema and produces schema declarations', async () => {
    const tables = await introspect(db, namespace);
    expect(
      tables
        .find((table) => table.name === 'CUSTOMERS')
        ?.columns.find((column) => column.name === 'ID'),
    ).toMatchObject({ dataType: 'NUMBER', scale: 0, nullable: false });
    const code = generateSchema(tables);
    expect(code).toContain('snowflakeTable("CUSTOMERS"');
    expect(code).toContain('integer("ID").notNull()');
  });

  it('keeps null checks valid for required columns', async () => {
    expect((await db.execute(select(customers).where(isNull(customers.columns.id)))).rows).toEqual(
      [],
    );
  });
  it('preserves native numeric ordering under DISTINCT and wire serialization', async () => {
    const rows = (
      await db.execute(
        select(customers, { id: customers.columns.id })
          .distinct()
          .orderBy(asc(customers.columns.id)),
      )
    ).rows;
    expect(rows).toEqual([{ id: 2n }, { id: 3n }, { id: 9007199254740993n }]);
    const hidden = (
      await db.execute(
        select(customers, { id: customers.columns.id }).orderBy(asc(customers.columns.name)),
      )
    ).rows;
    expect(hidden).toEqual([{ id: 9007199254740993n }, { id: 2n }, { id: 3n }]);
  });
});
