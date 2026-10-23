import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  asc,
  binary,
  count,
  eq,
  float,
  insert,
  integer,
  select,
  snowflakeTable,
  sql,
  text,
  timestamp,
} from '../../src/index.js';
import { createFixture, integrationConfig, tableIdentifier } from '../support/snowflake.js';

describe('nested projections against Snowflake', () => {
  const fixture = createFixture(integrationConfig());
  const db = fixture.client;
  const namespace = { database: fixture.table.node.parts[0] as string, schema: fixture.schemaName };
  const users = snowflakeTable(
    'USERS',
    {
      id: integer('ID').notNull(),
      name: text('NAME').notNull(),
      bio: text('BIO'),
      score: float('SCORE').notNull(),
      joined: timestamp('JOINED', 'tz').notNull(),
      avatar: binary('AVATAR'),
    },
    namespace,
  );
  const posts = snowflakeTable(
    'POSTS',
    {
      id: integer('ID').notNull(),
      authorId: integer('AUTHOR_ID'),
      title: text('TITLE').notNull(),
    },
    namespace,
  );
  const u = users.columns;
  const p = posts.columns;

  beforeAll(async () => {
    await fixture.seed();
    await db.queryRaw(
      sql`CREATE TABLE ${tableIdentifier(users)} (ID NUMBER(38,0) NOT NULL, NAME VARCHAR NOT NULL, BIO VARCHAR, SCORE DOUBLE NOT NULL, JOINED TIMESTAMP_TZ(9) NOT NULL, AVATAR BINARY)`,
    );
    await db.queryRaw(
      sql`CREATE TABLE ${tableIdentifier(posts)} (ID NUMBER(38,0) NOT NULL, AUTHOR_ID NUMBER(38,0), TITLE VARCHAR NOT NULL)`,
    );
    await db.execute(
      insert(users, [
        {
          id: 9007199254740993n,
          name: 'Ada',
          bio: null,
          score: 0.1,
          joined: '2024-01-02 03:04:05.123456789 +05:30',
          avatar: new Uint8Array([0, 255]),
        },
        {
          id: 2n,
          name: 'Grace',
          bio: 'Admiral',
          score: 5e-324,
          joined: '2024-02-03 00:00:00.000000000 +00:00',
        },
      ]),
    );
    await db.execute(
      insert(posts, [
        { id: 10n, authorId: 9007199254740993n, title: 'First' },
        { id: 11n, authorId: 9007199254740993n, title: 'Second' },
        { id: 12n, authorId: null, title: 'Anonymous' },
        { id: 13n, authorId: 404n, title: 'Dangling' },
      ]),
    );
  });
  afterAll(() => fixture.cleanup());

  const authored = select(posts)
    .leftJoin(users, eq(p.authorId, u.id))
    .select({
      id: p.id,
      author: {
        id: u.id,
        name: u.name,
        bio: u.bio,
        score: u.score,
        joined: u.joined,
        avatar: u.avatar,
      },
    })
    .orderBy(asc(p.id));
  const ada = {
    id: 9007199254740993n,
    name: 'Ada',
    bio: null,
    score: 0.1,
    joined: '2024-01-02 03:04:05.123456789 +05:30',
    avatar: [0, 255],
  };
  type Authored = { readonly author: { readonly avatar: Uint8Array | null } | null };
  const bytes = <R extends Authored>(rows: readonly R[]) =>
    rows.map((row) =>
      row.author
        ? { ...row, author: { ...row.author, avatar: row.author.avatar && [...row.author.avatar] } }
        : row,
    );

  it('collapses absent outer-joined objects and keeps exact wire values in present ones', async () => {
    expect(bytes((await db.execute(authored)).rows)).toEqual([
      { id: 10n, author: ada },
      { id: 11n, author: ada },
      { id: 12n, author: null },
      { id: 13n, author: null },
    ]);
  });

  it('returns one row per joined child, including parents without children', async () => {
    const query = select(users)
      .leftJoin(posts, eq(p.authorId, u.id))
      .select({ user: { id: u.id, name: u.name }, post: { id: p.id, title: p.title } })
      .orderBy(asc(u.id), asc(p.id));
    expect((await db.execute(query)).rows).toEqual([
      { user: { id: 2n, name: 'Grace' }, post: null },
      { user: { id: 9007199254740993n, name: 'Ada' }, post: { id: 10n, title: 'First' } },
      { user: { id: 9007199254740993n, name: 'Ada' }, post: { id: 11n, title: 'Second' } },
    ]);
  });

  it('keeps objects without a joinable NOT NULL key, and grouped objects, present', async () => {
    const bios = select(posts)
      .leftJoin(users, eq(p.authorId, u.id))
      .select({ id: p.id, author: { bio: u.bio } })
      .orderBy(asc(p.id));
    expect((await db.execute(bios)).rows.map((row) => row.author)).toEqual([
      { bio: null },
      { bio: null },
      { bio: null },
      { bio: null },
    ]);
    const grouped = select(users)
      .leftJoin(posts, eq(p.authorId, u.id))
      .groupBy(u.name)
      .select({ name: u.name, stats: { posts: count(p.id), author: { name: u.name } } })
      .orderBy(asc(u.name));
    expect((await db.execute(grouped)).rows).toEqual([
      { name: 'Ada', stats: { posts: 2n, author: { name: 'Ada' } } },
      { name: 'Grace', stats: { posts: 0n, author: { name: 'Grace' } } },
    ]);
  });

  it('collapses each side of a full join independently', async () => {
    const query = select(posts)
      .fullJoin(users, eq(p.authorId, u.id))
      .select({ post: { id: p.id }, user: { name: u.name }, pair: { post: p.id, user: u.id } })
      .orderBy(asc(p.id, 'LAST'));
    expect((await db.execute(query)).rows).toEqual([
      { post: { id: 10n }, user: { name: 'Ada' }, pair: { post: 10n, user: 9007199254740993n } },
      { post: { id: 11n }, user: { name: 'Ada' }, pair: { post: 11n, user: 9007199254740993n } },
      { post: { id: 12n }, user: null, pair: { post: 12n, user: null } },
      { post: { id: 13n }, user: null, pair: { post: 13n, user: null } },
      { post: null, user: { name: 'Grace' }, pair: { post: null, user: 2n } },
    ]);
  });

  it('paginates joined rows and decodes the same rows when streaming and in transactions', async () => {
    const page = authored.limit(2).offset(1);
    expect(bytes((await db.execute(page)).rows)).toEqual([
      { id: 11n, author: ada },
      { id: 12n, author: null },
    ]);
    const streamed = [];
    for await (const row of db.stream(authored)) streamed.push(row);
    expect(bytes(streamed)).toEqual(bytes((await db.execute(authored)).rows));
    expect(bytes(await db.transaction(async (tx) => (await tx.execute(page)).rows))).toEqual([
      { id: 11n, author: ada },
      { id: 12n, author: null },
    ]);
  });
});
