import { Readable } from 'node:stream';
import type { RowStatement, StatementOption } from 'snowflake-sdk';
import { describe, expect, it, vi } from 'vitest';
import {
  asc,
  count,
  decimal,
  eq,
  float,
  integer,
  lte,
  many,
  one,
  over,
  rowNumber,
  select,
  snowflakeTable,
  text,
  withRelations,
} from '../../src/index.js';
import { createClient } from '../../src/snowflake/index.js';

const users = snowflakeTable('USERS', {
  id: integer('ID').notNull(),
  name: text('NAME').notNull(),
  balance: decimal('BALANCE', { precision: 10, scale: 2 }),
});
const posts = snowflakeTable('POSTS', {
  id: integer('ID').notNull(),
  authorId: integer('AUTHOR_ID'),
  title: text('TITLE').notNull(),
});
const ledger = snowflakeTable('LEDGER', {
  amount: decimal('AMOUNT', { precision: 12, scale: 4 }).notNull(),
  note: text('NOTE').notNull(),
});
const u = users.columns;
const p = posts.columns;

/** Answers each statement in order and records its SQL and binds. */
function client(...results: unknown[][][]) {
  const statements: { sql: string; binds: unknown[] }[] = [];
  const execute = vi.fn((options: StatementOption) => {
    const index = statements.length;
    statements.push({ sql: options.sqlText, binds: options.binds as unknown[] });
    const statement = { getQueryId: () => `q${index}`, getColumns: () => undefined };
    options.complete?.(undefined, statement as unknown as RowStatement, results[index] ?? []);
    return statement as unknown as RowStatement;
  });
  return { db: createClient({ execute }), statements };
}

const userPosts = many(posts, { from: u.id, to: p.authorId }, (rows) =>
  rows.select({ id: p.id, title: p.title }).orderBy(asc(p.id)),
);

describe('relation loading', () => {
  it('loads children with one query per relation and keeps parent pagination', async () => {
    const parents = select(users, { name: u.name }).orderBy(asc(u.id)).limit(2);
    const loaded = withRelations(parents, { posts: userPosts });
    const { db, statements } = client(
      [
        ['Ada', '1'],
        ['Grace', '2'],
      ],
      [
        ['10', 'First', '1'],
        ['11', 'Second', '1'],
      ],
    );
    expect(await db.execute(loaded)).toEqual({
      rows: [
        {
          name: 'Ada',
          posts: [
            { id: 10n, title: 'First' },
            { id: 11n, title: 'Second' },
          ],
        },
        { name: 'Grace', posts: [] },
      ],
      queryId: 'q0',
      queryIds: ['q0', 'q1'],
    });
    expect(statements.map((item) => item.sql)).toEqual([
      'SELECT "__sflib_result"."name" AS "name", TO_VARCHAR("__sflib_result"."__sflib_key") AS "__sflib_key" FROM (SELECT "NAME" AS "name", "ID" AS "__sflib_key" FROM "USERS" ORDER BY "__sflib_key" ASC LIMIT 2) AS "__sflib_result" ORDER BY "__sflib_result"."__sflib_key" ASC',
      'SELECT TO_VARCHAR("__sflib_result"."id") AS "id", "__sflib_result"."title" AS "title", TO_VARCHAR("__sflib_result"."__sflib_key") AS "__sflib_key" FROM (SELECT "ID" AS "id", "TITLE" AS "title", "AUTHOR_ID" AS "__sflib_key" FROM "POSTS" WHERE ("AUTHOR_ID" IN (?, ?)) ORDER BY "id" ASC) AS "__sflib_result" ORDER BY "__sflib_result"."id" ASC',
    ]);
    expect(statements[1]?.binds).toEqual(['1', '2']);
  });

  it('reuses projected keys, skips NULL keys, and runs no child query without keys', async () => {
    const loaded = withRelations(select(posts, { id: p.id, authorId: p.authorId }), {
      author: one(users, { from: p.authorId, to: u.id }, (rows) => rows.select({ id: u.id })),
    });
    const { db, statements } = client(
      [
        ['10', '1'],
        ['11', null],
        ['12', '1'],
      ],
      [['1']],
    );
    expect((await db.execute(loaded)).rows).toEqual([
      { id: 10n, authorId: 1n, author: { id: 1n } },
      { id: 11n, authorId: null, author: null },
      { id: 12n, authorId: 1n, author: { id: 1n } },
    ]);
    expect(statements[0]?.sql).not.toContain('__sflib_key');
    expect(statements[1]?.binds).toEqual(['1']);
    const empty = client([]);
    expect(await empty.db.execute(loaded)).toEqual({ rows: [], queryId: 'q0', queryIds: ['q0'] });
    expect(empty.statements).toHaveLength(1);
  });

  it('shares hidden keys, avoids alias collisions, and keeps related filters', async () => {
    const loaded = withRelations(select(users, { __sflib_key: u.name }), {
      posts: many(posts, { from: u.id, to: p.authorId }, (rows) =>
        rows.select({ title: p.title }).where(eq(p.title, 'First')),
      ),
      named: many(posts, { from: u.id, to: p.authorId }, (rows) => rows.select({ id: p.id })),
      byTitle: many(posts, { from: u.name, to: p.title }, (rows) => rows.select({ id: p.id })),
    });
    const { db, statements } = client(
      [['Ada', '1']],
      [['First', '1']],
      [['10', '1']],
      [['10', 'Ada']],
    );
    expect((await db.execute(loaded)).rows).toEqual([
      {
        __sflib_key: 'Ada',
        posts: [{ title: 'First' }],
        named: [{ id: 10n }],
        byTitle: [{ id: 10n }],
      },
    ]);
    expect(statements[0]?.sql).toContain('"ID" AS "__sflib_key_" FROM "USERS"');
    expect(statements[1]?.sql).toContain('WHERE (("TITLE" = ?) AND ("AUTHOR_ID" IN (?)))');
    expect(statements[3]?.binds).toEqual(['Ada']);
  });

  it('reads keys from nested projections, including collapsed objects', async () => {
    const loaded = withRelations(
      select(posts)
        .leftJoin(users, eq(p.authorId, u.id))
        .select({ id: p.id, author: { id: u.id } }),
      { others: many(posts, { from: u.id, to: p.authorId }, (rows) => rows.select({ id: p.id })) },
    );
    const { db, statements } = client(
      [
        ['10', '1'],
        ['11', null],
      ],
      [['10', '1']],
    );
    expect((await db.execute(loaded)).rows).toEqual([
      { id: 10n, author: { id: 1n }, others: [{ id: 10n }] },
      { id: 11n, author: null, others: [] },
    ]);
    expect(statements[1]?.binds).toEqual(['1']);
  });

  it('rejects a one relation that matches several rows', async () => {
    const loaded = withRelations(select(posts, { id: p.id, authorId: p.authorId }), {
      author: one(users, { from: p.authorId, to: u.id }, (rows) => rows.select({ id: u.id })),
    });
    const { db } = client([['10', '1']], [['1'], ['1']]);
    await expect(db.execute(loaded)).rejects.toThrow('matched 2 rows for one parent key');
  });

  it('batches distinct keys and duplicate parents share their children', async () => {
    const loaded = withRelations(
      select(posts, { id: p.id, authorId: p.authorId }),
      {
        author: one(users, { from: p.authorId, to: u.id }, (rows) => rows.select({ name: u.name })),
      },
      { batchSize: 2 },
    );
    const { db, statements } = client(
      [
        ['10', '1'],
        ['11', '2'],
        ['12', '3'],
        ['13', '1'],
      ],
      [
        ['Ada', '1'],
        ['Grace', '2'],
      ],
      [['Linus', '3']],
    );
    const result = await db.execute(loaded);
    expect(result.rows.map((row) => row.author?.name)).toEqual(['Ada', 'Grace', 'Linus', 'Ada']);
    expect(result.queryIds).toEqual(['q0', 'q1', 'q2']);
    expect(statements.slice(1).map((item) => item.binds)).toEqual([['1', '2'], ['3']]);
  });

  it('loads nested relations level by level', async () => {
    const loaded = withRelations(select(users, { id: u.id }), {
      posts: many(posts, { from: u.id, to: p.authorId }, (rows) =>
        withRelations(rows.select({ id: p.id }), {
          author: one(users, { from: p.authorId, to: u.id }, (q) => q.select({ name: u.name })),
        }),
      ),
    });
    const { db, statements } = client(
      [['1'], ['2']],
      [
        ['10', '1'],
        ['11', '1'],
      ],
      [['Ada', '1']],
    );
    expect((await db.execute(loaded)).rows).toEqual([
      {
        id: 1n,
        posts: [
          { id: 10n, author: { name: 'Ada' } },
          { id: 11n, author: { name: 'Ada' } },
        ],
      },
      { id: 2n, posts: [] },
    ]);
    // The nested query projects AUTHOR_ID once for both the parent match and its own relation.
    expect(statements[1]?.sql).toContain('"AUTHOR_ID" AS "__sflib_key" FROM "POSTS"');
    expect(statements[1]?.sql.match(/AUTHOR_ID/g)).toHaveLength(2);
    expect(statements[2]?.binds).toEqual(['1']);
  });

  it('matches DECIMAL keys by value regardless of scale', async () => {
    const accounts = snowflakeTable('ACCOUNTS', { balance: decimal('BALANCE').notNull() });
    const loaded = withRelations(select(accounts), {
      entries: many(ledger, { from: accounts.columns.balance, to: ledger.columns.amount }),
    });
    const { db } = client(
      [['1.50'], ['-0.00']],
      [
        ['1.5000', 'a'],
        ['0.0000', 'b'],
      ],
    );
    expect((await db.execute(loaded)).rows).toEqual([
      { balance: '1.50', entries: [{ amount: '1.5000', note: 'a' }] },
      { balance: '-0.00', entries: [{ amount: '0.0000', note: 'b' }] },
    ]);
  });

  it('streams parents and loads children per batch', async () => {
    const loaded = withRelations(
      select(users, { id: u.id }),
      { posts: userPosts },
      { batchSize: 2 },
    );
    const rowsFor = [[['1'], ['2'], ['3']], [['10', 'First', '1']], [['30', 'Third', '3']]];
    const statements: string[] = [];
    const execute = vi.fn((options: StatementOption) => {
      const index = statements.length;
      statements.push(options.sqlText);
      const rows = rowsFor[index] ?? [];
      const statement = {
        getQueryId: () => `q${index}`,
        getColumns: () => undefined,
        streamRows: () => Readable.from(rows, { objectMode: true }),
      };
      if (!options.streamResult)
        options.complete?.(undefined, statement as unknown as RowStatement, rows);
      else options.complete?.(undefined, statement as unknown as RowStatement);
      return statement as unknown as RowStatement;
    });
    const streamed = [];
    for await (const row of createClient({ execute }).stream(loaded)) streamed.push(row);
    expect(streamed).toEqual([
      { id: 1n, posts: [{ id: 10n, title: 'First' }] },
      { id: 2n, posts: [] },
      { id: 3n, posts: [{ id: 30n, title: 'Third' }] },
    ]);
    expect(statements).toHaveLength(3);
    rowsFor.splice(0, 3, [['1'], ['2']], [['10', 'First', '1']]);
    statements.length = 0;
    const exact = [];
    for await (const row of createClient({ execute }).stream(loaded)) exact.push(row);
    expect(exact).toEqual(streamed.slice(0, 2));
    expect(statements).toHaveLength(2);
  });

  it('validates relation declarations', () => {
    expect(() => many(ledger, { from: u.name, to: ledger.columns.amount as never })).toThrow(
      'share one SQL type',
    );
    const scores = snowflakeTable('SCORES', { value: float('VALUE').notNull() });
    expect(() =>
      many(scores, { from: scores.columns.value as never, to: scores.columns.value as never }),
    ).toThrow('INTEGER, DECIMAL, TEXT, or DATE');
    expect(() => many(posts, { from: u.id, to: p.authorId }, (rows) => rows.limit(5))).toThrow(
      'LIMIT or OFFSET',
    );
    expect(() => many(posts, { from: u.id, to: u.id as never })).toThrow('does not belong');
    expect(() => many(users, { from: count() as never, to: u.id })).toThrow('scalar');
    // Per-parent limits use QUALIFY over the related key.
    expect(() =>
      many(posts, { from: u.id, to: p.authorId }, (rows) =>
        rows.qualify(lte(rowNumber({ partitionBy: [p.authorId], orderBy: [asc(p.id)] }), 2n)),
      ),
    ).not.toThrow();
    expect(() => withRelations(select(users), {})).toThrow('at least one relation');
    expect(() => withRelations(select(users), { ['__proto__']: userPosts } as never)).toThrow(
      'Reserved relation name',
    );
    expect(() => withRelations(select(users), { posts: select(posts) } as never)).toThrow(
      'is not a relation',
    );
    expect(() => withRelations(select(users), { posts: userPosts }, { batchSize: 0 })).toThrow(
      'batch size',
    );
    expect(() => withRelations(select(users), { name: userPosts } as never)).toThrow(
      'repeats a projection key',
    );
    expect(() =>
      withRelations(select(users, { name: u.name }).distinct(), { posts: userPosts }),
    ).toThrow('DISTINCT');
    expect(() =>
      withRelations(select(users, { n: over(count()) }).groupBy(u.name), { posts: userPosts }),
    ).toThrow('GROUP BY');
  });
});
