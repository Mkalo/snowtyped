import type { RowStatement, StatementOption } from 'snowflake-sdk';
import { describe, expect, it, vi } from 'vitest';
import {
  add,
  asc,
  count,
  eq,
  exists,
  inSubquery,
  insertFrom,
  integer,
  recursiveCte,
  scalar,
  select,
  snowflakeTable,
  text,
  variant,
} from '../../src/index.js';
import { createClient } from '../../src/snowflake/index.js';

const posts = snowflakeTable('POSTS', {
  id: integer('ID').notNull(),
  authorId: integer('AUTHOR_ID'),
  title: text('TITLE').notNull(),
});
const users = snowflakeTable('USERS', {
  id: integer('ID').notNull(),
  name: text('NAME').notNull(),
  bio: text('BIO'),
  data: variant('DATA').notNull(),
});
const p = posts.columns;
const u = users.columns;
const joined = select(posts).leftJoin(users, eq(p.authorId, u.id));

function client(rows: unknown[][]) {
  const statement = { getQueryId: () => 'query', getColumns: () => undefined };
  const execute = vi.fn((options: StatementOption) => {
    options.complete?.(undefined, statement as unknown as RowStatement, rows);
    return statement as unknown as RowStatement;
  });
  return createClient({ execute });
}
const decode = async (query: object, rows: unknown[][]) =>
  // biome-ignore lint/suspicious/noExplicitAny: the overloads are exercised by the type tests.
  (await client(rows).execute(query as any)).rows;

describe('nested projections', () => {
  it('projects nested leaves under dotted aliases in projection order', () => {
    const query = joined.select({
      id: p.id,
      author: { name: u.name, profile: { bio: u.bio } },
      title: p.title,
    });
    expect(query.ast.projections.map((item) => item.alias)).toEqual([
      'id',
      'author.name',
      'author.profile.bio',
      'title',
    ]);
    expect(query.compile().sql).toBe(
      'SELECT TO_VARCHAR("__sflib_result"."id") AS "id", "__sflib_result"."author.name" AS "author.name", "__sflib_result"."author.profile.bio" AS "author.profile.bio", "__sflib_result"."title" AS "title" FROM (SELECT "POSTS"."ID" AS "id", "USERS"."NAME" AS "author.name", "USERS"."BIO" AS "author.profile.bio", "POSTS"."TITLE" AS "title" FROM "POSTS" LEFT JOIN "USERS" ON ("POSTS"."AUTHOR_ID" = "USERS"."ID")) AS "__sflib_result"',
    );
    expect(query.selection).toEqual({
      id: p.id,
      author: { name: u.name, profile: { bio: u.bio } },
      title: p.title,
    });
    expect(
      select(posts, { post: { id: p.id } })
        .orderBy(asc(p.id))
        .compile().sql,
    ).toBe(
      'SELECT TO_VARCHAR("__sflib_result"."post.id") AS "post.id" FROM (SELECT "ID" AS "post.id" FROM "POSTS" ORDER BY "post.id" ASC) AS "__sflib_result" ORDER BY "__sflib_result"."post.id" ASC',
    );
  });

  it('collapses an outer-joined object when its NOT NULL keys read NULL', async () => {
    const query = joined.select({ id: p.id, author: { id: u.id, name: u.name, bio: u.bio } });
    expect(
      await decode(query, [
        ['1', '7', 'Ada', null],
        ['2', null, null, null],
      ]),
    ).toEqual([
      { id: 1n, author: { id: 7n, name: 'Ada', bio: null } },
      { id: 2n, author: null },
    ]);
    // A present object proves its source, so its other NOT NULL entries must be present.
    await expect(decode(query, [['1', '7', null, null]])).rejects.toThrow();
    await expect(decode(query, [['1', null, 'Ada', null]])).rejects.toThrow();
  });

  it('keeps objects present when no key can be nulled by an outer join', async () => {
    expect(await decode(joined.select({ author: { bio: u.bio } }), [[null]])).toEqual([
      { author: { bio: null } },
    ]);
    expect(
      await decode(joined.select({ post: { id: p.id, name: u.name } }), [['1', null]]),
    ).toEqual([{ post: { id: 1n, name: null } }]);
    const grouped = select(posts, { id: p.id })
      .leftJoin(users, eq(p.authorId, u.id))
      .groupBy(u.name)
      .select({ stats: { posts: count(), name: u.name } });
    expect(await decode(grouped, [['0', null]])).toEqual([{ stats: { posts: 0n, name: null } }]);
    expect(
      await decode(
        select(posts)
          .innerJoin(users, eq(p.authorId, u.id))
          .select({ author: { id: u.id } }),
        [['3']],
      ),
    ).toEqual([{ author: { id: 3n } }]);
    await expect(
      decode(
        select(posts)
          .innerJoin(users, eq(p.authorId, u.id))
          .select({ author: { id: u.id } }),
        [[null]],
      ),
    ).rejects.toThrow();
  });

  it('treats VARIANT values that can be JSON null as values, not keys', async () => {
    expect(await decode(joined.select({ author: { data: u.data } }), [[null]])).toEqual([
      { author: { data: null } },
    ]);
  });

  it('proves only the sources every key reads', async () => {
    const full = select(posts).fullJoin(users, eq(p.authorId, u.id));
    const pair = full.select({ pair: { post: p.id, user: u.id } });
    expect(
      await decode(pair, [
        ['1', null],
        [null, '2'],
        [null, null],
      ]),
    ).toEqual([
      { pair: { post: 1n, user: null } },
      { pair: { post: null, user: 2n } },
      { pair: null },
    ]);
    const sum = full.select({ pair: { sum: add(p.id, u.id), name: u.name } });
    expect(await decode(sum, [[null, 'Ada']])).toEqual([{ pair: { sum: null, name: 'Ada' } }]);
    await expect(decode(sum, [['3', null]])).rejects.toThrow();
    const single = full.select({ pair: { sum: add(p.id, u.id), bio: u.bio } });
    expect(await decode(single, [[null, null]])).toEqual([{ pair: null }]);
  });

  it('resolves child objects against what their parent proves', async () => {
    const query = joined.select({
      author: { id: u.id, profile: { bio: u.bio, title: p.title } },
      wrapper: { author: { id: u.id } },
    });
    expect(
      await decode(query, [
        ['1', null, 'T', '1'],
        [null, null, 'T', null],
      ]),
    ).toEqual([
      { author: { id: 1n, profile: { bio: null, title: 'T' } }, wrapper: { author: { id: 1n } } },
      { author: null, wrapper: { author: null } },
    ]);
  });

  it('validates nested projection shapes and aliases', () => {
    expect(() => select(posts, { post: {} })).toThrow('nested projection needs at least one');
    expect(() => select(posts, { post: { '': p.id } })).toThrow('Identifiers');
    // @ts-expect-error Exercise the runtime boundary for an invalid entry.
    expect(() => select(posts, { post: 1 })).toThrow('expressions or nested objects');
    expect(() => select(posts, { 'post.id': p.id, post: { id: p.id } })).toThrow(
      'repeats another projection alias',
    );
    // @ts-expect-error Exercise the runtime boundary for a statically invalid scope.
    expect(() => select(posts, { author: { id: u.id } })).toThrow('does not belong');
    expect(() => select(posts, { post: { ['x'.repeat(252)]: p.id } })).toThrow('Identifiers');
  });

  it('rejects nested projections where SQL needs flat columns', () => {
    const nested = select(users, { user: { id: u.id } });
    const flat = select(users, { id: u.id });
    for (const run of [
      () => (nested as unknown as typeof flat).as('X'),
      () => (nested as unknown as typeof flat).asCte('X'),
      () => (nested as unknown as typeof flat).union(flat),
      () => flat.union(nested as unknown as typeof flat),
      () => exists(nested as unknown as typeof flat),
      () => scalar(nested as unknown as typeof flat),
      () => inSubquery(u.id, nested as unknown as typeof flat),
      () => recursiveCte('R', nested as unknown as typeof flat, () => flat),
    ])
      expect(run).toThrow('Nested projections are only decoded from results');
    expect(() => insertFrom(users, nested as never)).toThrow('flat columns');
    expect(nested.select({ id: u.id }).as('X').columns.id).toBeDefined();
  });
});
