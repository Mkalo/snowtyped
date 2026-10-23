import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  asc,
  eq,
  float,
  insert,
  integer,
  lte,
  many,
  one,
  rowNumber,
  select,
  snowflakeTable,
  sql,
  text,
  timestamp,
  withRelations,
} from '../../src/index.js';
import { createFixture, integrationConfig, tableIdentifier } from '../support/snowflake.js';

describe('relation loading against Snowflake', () => {
  const fixture = createFixture(integrationConfig());
  const db = fixture.client;
  const namespace = { database: fixture.table.node.parts[0] as string, schema: fixture.schemaName };
  const users = snowflakeTable(
    'USERS',
    { id: integer('ID').notNull(), name: text('NAME').notNull() },
    namespace,
  );
  const posts = snowflakeTable(
    'POSTS',
    {
      id: integer('ID').notNull(),
      authorId: integer('AUTHOR_ID'),
      title: text('TITLE').notNull(),
      score: float('SCORE').notNull(),
      at: timestamp('AT', 'tz').notNull(),
    },
    namespace,
  );
  const comments = snowflakeTable(
    'COMMENTS',
    { id: integer('ID').notNull(), postId: integer('POST_ID').notNull(), body: text('BODY') },
    namespace,
  );
  const u = users.columns;
  const p = posts.columns;
  const c = comments.columns;
  const ADA = 9007199254740993n;

  beforeAll(async () => {
    await fixture.seed();
    await db.queryRaw(
      sql`CREATE TABLE ${tableIdentifier(users)} (ID NUMBER(38,0) NOT NULL, NAME VARCHAR NOT NULL)`,
    );
    await db.queryRaw(
      sql`CREATE TABLE ${tableIdentifier(posts)} (ID NUMBER(38,0) NOT NULL, AUTHOR_ID NUMBER(38,0), TITLE VARCHAR NOT NULL, SCORE DOUBLE NOT NULL, AT TIMESTAMP_TZ(9) NOT NULL)`,
    );
    await db.queryRaw(
      sql`CREATE TABLE ${tableIdentifier(comments)} (ID NUMBER(38,0) NOT NULL, POST_ID NUMBER(38,0) NOT NULL, BODY VARCHAR)`,
    );
    await db.execute(
      insert(users, [
        { id: ADA, name: 'Ada' },
        { id: 2n, name: 'Grace' },
        { id: 3n, name: 'Linus' },
      ]),
    );
    await db.execute(
      insert(posts, [
        {
          id: 10n,
          authorId: ADA,
          title: 'First',
          score: 0.1,
          at: '2024-01-02 03:04:05.123456789 +05:30',
        },
        {
          id: 11n,
          authorId: ADA,
          title: 'Second',
          score: 5e-324,
          at: '2024-01-03 00:00:00.000000000 +01:00',
        },
        {
          id: 12n,
          authorId: 2n,
          title: 'Third',
          score: 1,
          at: '2024-01-04 00:00:00.000000000 +01:00',
        },
        {
          id: 13n,
          authorId: null,
          title: 'Orphan',
          score: 2,
          at: '2024-01-05 00:00:00.000000000 +01:00',
        },
      ]),
    );
    await db.execute(
      insert(comments, [
        { id: 100n, postId: 10n, body: 'Nice' },
        { id: 101n, postId: 10n, body: null },
        { id: 102n, postId: 12n, body: 'Hmm' },
      ]),
    );
  });
  afterAll(() => fixture.cleanup());

  const userPosts = many(posts, { from: u.id, to: p.authorId }, (rows) =>
    rows.select({ id: p.id, title: p.title, score: p.score, at: p.at }).orderBy(asc(p.id)),
  );
  const first = { id: 10n, title: 'First', score: 0.1, at: '2024-01-02 03:04:05.123456789 +05:30' };
  const second = {
    id: 11n,
    title: 'Second',
    score: 5e-324,
    at: '2024-01-03 00:00:00.000000000 +01:00',
  };
  const third = { id: 12n, title: 'Third', score: 1, at: '2024-01-04 00:00:00.000000000 +01:00' };

  it('paginates parents and loads all their children in one more query', async () => {
    const page = withRelations(select(users, { name: u.name }).orderBy(asc(u.id)).limit(2), {
      posts: userPosts,
    });
    const result = await db.execute(page);
    expect(result.rows).toEqual([
      { name: 'Grace', posts: [third] },
      { name: 'Linus', posts: [] },
    ]);
    expect(result.queryIds).toHaveLength(2);
    expect(result.queryId).toBe(result.queryIds[0]);
    const all = await db.execute(
      withRelations(select(users, { id: u.id }).orderBy(asc(u.id)), { posts: userPosts }),
    );
    expect(all.rows).toEqual([
      { id: 2n, posts: [third] },
      { id: 3n, posts: [] },
      { id: ADA, posts: [first, second] },
    ]);
  });

  it('loads one relations, NULL keys, duplicate parents, and nested relations', async () => {
    const query = withRelations(
      select(posts)
        .leftJoin(comments, eq(p.id, c.postId))
        .select({ post: p.id, comment: c.id })
        .orderBy(asc(p.id), asc(c.id)),
      {
        author: one(users, { from: p.authorId, to: u.id }, (rows) => rows.select({ name: u.name })),
      },
    );
    const result = await db.execute(query);
    expect(result.rows).toEqual([
      { post: 10n, comment: 100n, author: { name: 'Ada' } },
      { post: 10n, comment: 101n, author: { name: 'Ada' } },
      { post: 11n, comment: null, author: { name: 'Ada' } },
      { post: 12n, comment: 102n, author: { name: 'Grace' } },
      { post: 13n, comment: null, author: null },
    ]);
    expect(result.queryIds).toHaveLength(2);
    const nested = await db.execute(
      withRelations(select(users, { id: u.id }).orderBy(asc(u.id)), {
        posts: many(posts, { from: u.id, to: p.authorId }, (rows) =>
          withRelations(rows.select({ id: p.id }).orderBy(asc(p.id)), {
            comments: many(comments, { from: p.id, to: c.postId }, (q) =>
              q.select({ body: c.body }).orderBy(asc(c.id)),
            ),
          }),
        ),
      }),
    );
    expect(nested.rows).toEqual([
      { id: 2n, posts: [{ id: 12n, comments: [{ body: 'Hmm' }] }] },
      { id: 3n, posts: [] },
      {
        id: ADA,
        posts: [
          { id: 10n, comments: [{ body: 'Nice' }, { body: null }] },
          { id: 11n, comments: [] },
        ],
      },
    ]);
    expect(nested.queryIds).toHaveLength(3);
  });

  it('limits children per parent with QUALIFY and batches keys', async () => {
    const latest = many(posts, { from: u.id, to: p.authorId }, (rows) =>
      rows
        .select({ id: p.id })
        .qualify(lte(rowNumber({ partitionBy: [p.authorId], orderBy: [asc(p.id)] }), 1n))
        .orderBy(asc(p.id)),
    );
    const result = await db.execute(
      withRelations(select(users, { id: u.id }).orderBy(asc(u.id)), { latest }, { batchSize: 1 }),
    );
    expect(result.rows).toEqual([
      { id: 2n, latest: [{ id: 12n }] },
      { id: 3n, latest: [] },
      { id: ADA, latest: [{ id: 10n }] },
    ]);
    expect(result.queryIds).toHaveLength(4);
  });

  it('streams in batches and runs inside transactions', async () => {
    const query = withRelations(
      select(users, { id: u.id }).orderBy(asc(u.id)),
      { posts: userPosts },
      {
        batchSize: 2,
      },
    );
    const streamed = [];
    for await (const row of db.stream(query)) streamed.push(row);
    expect(streamed).toEqual((await db.execute(query)).rows);
    const inTransaction = await db.transaction(async (tx) => {
      await tx.execute(
        insert(posts, [
          {
            id: 14n,
            authorId: 3n,
            title: 'Draft',
            score: 3,
            at: '2024-01-06 00:00:00.000000000 +01:00',
          },
        ]),
      );
      return (await tx.execute(query)).rows;
    });
    expect(inTransaction[1]).toEqual({
      id: 3n,
      posts: [{ id: 14n, title: 'Draft', score: 3, at: '2024-01-06 00:00:00.000000000 +01:00' }],
    });
  });
});
