import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as z from 'zod';
import {
  alias,
  array,
  asc,
  avg,
  caseWhen,
  count,
  date,
  dateAdd,
  datePart,
  decimal,
  desc,
  eq,
  exists,
  float,
  gt,
  gte,
  inArray,
  insert,
  integer,
  jsonPath,
  lower,
  lt,
  matchRecognize,
  max,
  object,
  over,
  pivot,
  rowNumber,
  rowPattern,
  scalar,
  select,
  snowflakeTable,
  sql,
  structured,
  structuredType,
  sum,
  text,
  timestamp,
  update,
  variant,
  vector,
} from '../../src/index.js';
import { createFixture, integrationConfig } from '../support/snowflake.js';

describe('semantic validation accepts valid Snowflake behavior', () => {
  const fixture = createFixture(integrationConfig());
  const db = fixture.client;
  const database = fixture.table.node.parts[0] as string;
  const facts = snowflakeTable(
    'FACTS',
    {
      id: integer('ID').notNull(),
      grp: text('GRP').notNull(),
      amount: decimal('AMOUNT').notNull(),
      ratio: float('RATIO').notNull(),
      day: date('DAY').notNull(),
      at: timestamp('AT_VALUE', 'tz').notNull(),
      payload: variant('PAYLOAD', z.object({ tag: z.string(), n: z.number() })).notNull(),
    },
    { database, schema: fixture.schemaName },
  );
  const c = facts.columns;

  beforeAll(async () => {
    await fixture.seed();
    await db.queryRaw(
      sql`CREATE TABLE ${sql.identifier(...(facts.node.parts as [string, ...string[]]))} (ID NUMBER(38,0) NOT NULL, GRP VARCHAR NOT NULL, AMOUNT NUMBER(38,2) NOT NULL, RATIO DOUBLE NOT NULL, DAY DATE NOT NULL, AT_VALUE TIMESTAMP_TZ(9) NOT NULL, PAYLOAD VARIANT NOT NULL)`,
    );
    await db.execute(
      insert(facts, [
        {
          id: 1n,
          grp: 'A',
          amount: '1.00',
          ratio: 1,
          day: '2024-01-01',
          at: '2024-01-01 00:00:00 +00:00',
          payload: { tag: 'Alpha', n: 1 },
        },
        {
          id: 2n,
          grp: 'a',
          amount: '2.50',
          ratio: 2,
          day: '2024-01-02',
          at: '2024-01-01 12:00:00 +00:00',
          payload: { tag: 'beta', n: 2 },
        },
        {
          id: 3n,
          grp: 'B',
          amount: '3.00',
          ratio: 3.5,
          day: '2024-01-03',
          at: '2024-01-04 00:00:00 +00:00',
          payload: { tag: 'gamma', n: 3 },
        },
      ]),
    );
  });
  afterAll(() => fixture.cleanup());

  it('compares numeric types, dates with timestamps, and VARIANT paths with literals', async () => {
    const query = select(facts, { id: c.id }).where(eq(c.id, c.amount)).orderBy(asc(c.id));
    expect((await db.execute(query)).rows).toEqual([{ id: 1n }, { id: 3n }]);
    expect(
      (await db.execute(select(facts, { id: c.id }).where(lt(c.amount, c.ratio)))).rows,
    ).toEqual([{ id: 3n }]);
    expect(
      (await db.execute(select(facts, { id: c.id }).where(gte(c.day, c.at)).orderBy(asc(c.id))))
        .rows,
    ).toEqual([{ id: 1n }, { id: 2n }]);
    const tag = jsonPath(c.payload, 'tag');
    expect((await db.execute(select(facts, { id: c.id }).where(eq(tag, 'beta')))).rows).toEqual([
      { id: 2n },
    ]);
    expect(
      (
        await db.execute(
          select(facts, { id: c.id })
            .where(inArray(jsonPath(c.payload, 'n'), [1, 3]))
            .orderBy(asc(c.id)),
        )
      ).rows,
    ).toEqual([{ id: 1n }, { id: 3n }]);
    expect(
      (await db.execute(select(facts, { id: c.id }).where(eq(c.grp, jsonPath(c.payload, 'tag')))))
        .rows,
    ).toEqual([]);
  });

  it('groups by expressions and windows over grouped aggregates', async () => {
    const query = select(facts, {
      key: lower(c.grp),
      total: sum(c.amount),
      share: over(sum(count())),
      rank: rowNumber({ orderBy: [desc(count())] }),
    })
      .groupBy(lower(c.grp))
      .having(gt(count(), 0n))
      .orderBy(asc(lower(c.grp)));
    expect((await db.execute(query)).rows).toEqual([
      { key: 'a', total: '3.50', share: '3', rank: 1n },
      { key: 'b', total: '3.00', share: '3', rank: 2n },
    ]);
    const implicit = select(facts, { n: count() }).having(gt(count(), 2n));
    expect((await db.execute(implicit)).rows).toEqual([{ n: 3n }]);
  });

  it('orders grouped queries by projected or hidden window functions', async () => {
    const rank = rowNumber({ orderBy: [asc(c.grp)] });
    const projected = select(facts, { grp: c.grp, rank }).groupBy(c.grp).orderBy(desc(rank));
    expect((await db.execute(projected)).rows.map((row) => row.grp)).toEqual(['a', 'B', 'A']);
    const hidden = select(facts, { grp: c.grp, n: count() }).groupBy(c.grp).orderBy(desc(rank));
    expect((await db.execute(hidden)).rows.map((row) => row.grp)).toEqual(['a', 'B', 'A']);
  });

  it('compares, indexes, groups, and orders semi-structured and VECTOR values', async () => {
    const docs = snowflakeTable(
      'DOCS',
      {
        id: integer('ID').notNull(),
        list: array('LIST', z.number()).notNull(),
        doc: object('DOC').notNull(),
        embedding: vector('EMBEDDING', 'int', 2).notNull(),
        json: variant('JSON').notNull(),
      },
      { database, schema: fixture.schemaName },
    );
    const d = docs.columns;
    await db.queryRaw(
      sql`CREATE TABLE ${sql.identifier(...(docs.node.parts as [string, ...string[]]))} (ID NUMBER(38,0) NOT NULL, LIST ARRAY NOT NULL, DOC OBJECT NOT NULL, EMBEDDING VECTOR(INT, 2) NOT NULL, JSON VARIANT NOT NULL)`,
    );
    await db.execute(
      insert(docs, [
        { id: 1n, list: [1, 2], doc: { k: 'b' }, embedding: [1, 2], json: [1, 2] },
        { id: 2n, list: [1, 2], doc: { k: 'a' }, embedding: [3, 4], json: {} },
        { id: 3n, list: [3], doc: { k: 'c' }, embedding: [1, 2], json: [3] },
      ]),
    );
    const paths = select(docs, { first: jsonPath(d.list, 0), key: jsonPath(d.doc, 'k') })
      .where(eq(d.list, d.json))
      .orderBy(asc(d.id));
    expect((await db.execute(paths)).rows).toEqual([
      { first: 1, key: 'b' },
      { first: 3, key: 'c' },
    ]);
    const grouped = select(docs, { list: d.list, n: count() })
      .groupBy(d.list)
      .orderBy(desc(count()));
    expect((await db.execute(grouped)).rows).toEqual([
      { list: [1, 2], n: 2n },
      { list: [3], n: 1n },
    ]);
    const vectors = select(docs, { id: d.id })
      .where(eq(d.embedding, d.embedding))
      .orderBy(asc(d.doc));
    expect((await db.execute(vectors)).rows).toEqual([{ id: 2n }, { id: 1n }, { id: 3n }]);
  });

  it('compares, indexes, groups, and orders structured values', async () => {
    const tagged = snowflakeTable(
      'TAGGED',
      {
        id: integer('ID').notNull(),
        tags: structured('TAGS', structuredType.array(structuredType.integer()).notNull()),
      },
      { database, schema: fixture.schemaName },
    );
    const d = tagged.columns;
    await db.queryRaw(
      sql`CREATE TABLE ${sql.identifier(...(tagged.node.parts as [string, ...string[]]))} (ID NUMBER(38,0) NOT NULL, TAGS ARRAY(NUMBER(38,0)))`,
    );
    await db.execute(
      insert(tagged, [
        { id: 1n, tags: [2n, 1n] },
        { id: 2n, tags: [1n] },
        { id: 3n, tags: [2n, 1n] },
      ]),
    );
    const grouped = select(tagged, { tags: d.tags, first: jsonPath(d.tags, 0), n: count() })
      .where(eq(d.tags, [2n, 1n]))
      .groupBy(d.tags)
      .orderBy(asc(d.tags));
    expect((await db.execute(grouped)).rows).toEqual([{ tags: [2n, 1n], first: 2, n: 2n }]);
    const ordered = select(tagged, { id: d.id }).orderBy(asc(d.tags), asc(d.id));
    expect((await db.execute(ordered)).rows).toEqual([{ id: 2n }, { id: 1n }, { id: 3n }]);
  });

  it('groups by expression helpers and compares their SQL types', async () => {
    const year = datePart('year', c.day);
    const grouped = select(facts, {
      year,
      mean: avg(c.amount),
      size: caseWhen(gt(count(), 1n), 'many').else('one'),
    }).groupBy(year);
    expect((await db.execute(grouped)).rows).toEqual([
      { year: 2024n, mean: '2.16666667', size: 'many' },
    ]);
    const shifted = select(facts, { id: c.id })
      .where(lt(dateAdd('hour', 1n, c.day), c.at))
      .orderBy(asc(c.id));
    expect((await db.execute(shifted)).rows).toEqual([{ id: 3n }]);
  });

  it('keeps SQL types through set operations', async () => {
    const days = select(facts, { day: c.day })
      .where(eq(c.id, 1n))
      .union(select(facts, { day: c.day }).where(eq(c.id, 3n)))
      .as('DAYS');
    const query = select(days)
      .innerJoin(facts, gte(days.columns.day, c.at))
      .select({ day: days.columns.day, id: c.id })
      .orderBy(asc(days.columns.day), asc(c.id));
    expect((await db.execute(query)).rows).toEqual([
      { day: '2024-01-01', id: 1n },
      { day: '2024-01-03', id: 1n },
      { day: '2024-01-03', id: 2n },
    ]);
  });

  it('keeps SQL types through PIVOT', async () => {
    const source = select(facts, { grp: c.grp, day: c.day }).as('SRC');
    const latest = pivot(source, 'LATEST', {
      aggregate: 'max',
      value: 'day',
      for: 'grp',
      in: { lower: 'a', upper: 'B' },
    });
    const query = select(latest).where(
      lt(latest.columns.lower, dateAdd('hour', 1n, latest.columns.upper)),
    );
    expect((await db.execute(query)).rows).toEqual([{ lower: '2024-01-02', upper: '2024-01-03' }]);
  });

  it('keeps SQL types through MATCH_RECOGNIZE', async () => {
    const up = rowPattern.variable('up');
    const rising = matchRecognize(facts, 'RISING', {
      orderBy: (row) => [asc(row.id)],
      pattern: rowPattern.oneOrMore(up),
      define: ({ row, lag }) => ({ up: gt(row.amount, lag(row.amount)) }),
      measures: ({ row, last }) => ({ lastDay: last(row.day) }),
    });
    const query = select(rising).where(
      gt(dateAdd('hour', 1n, rising.columns.lastDay), rising.columns.lastDay),
    );
    expect((await db.execute(query)).rows).toEqual([{ lastDay: '2024-01-03' }]);
  });

  it('keeps SQL types through subqueries and groups correlated ones', async () => {
    const other = alias(facts, 'OTHER');
    const latest = scalar(select(other, { day: max(other.columns.day) }));
    const before = select(facts, { id: c.id }).where(lt(c.at, latest)).orderBy(asc(c.id));
    expect((await db.execute(before)).rows).toEqual([{ id: 1n }, { id: 2n }]);
    const sameGroup = select(other, { grp: other.columns.grp })
      .correlate(facts)
      .where(eq(lower(other.columns.grp), lower(c.grp)))
      .groupBy(other.columns.grp)
      .having(gt(c.amount, '2'));
    const query = select(facts, { id: c.id }).where(exists(sameGroup)).orderBy(asc(c.id));
    expect((await db.execute(query)).rows).toEqual([{ id: 2n }, { id: 3n }]);
  });

  it('assigns across compatible SQL types', async () => {
    await db.execute(update(facts, { at: c.day }).where(eq(c.id, 3n)));
    const query = select(facts, { at: c.at }).where(eq(c.id, 3n));
    expect((await db.execute(query)).rows[0]?.at).toMatch(/^2024-01-03 00:00:00\.000000000/);
  });
});
