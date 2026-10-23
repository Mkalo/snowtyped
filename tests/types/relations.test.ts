// Checked by tsc, not executed.
import { expectTypeOf } from 'vitest';
import {
  asc,
  date,
  eq,
  float,
  integer,
  many,
  one,
  select,
  snowflakeTable,
  text,
  withRelations,
} from '../../src/index.js';
import type { SnowflakeClient } from '../../src/snowflake/index.js';

const users = snowflakeTable('USERS', {
  id: integer('ID').notNull(),
  name: text('NAME').notNull(),
  born: date('BORN'),
});
const posts = snowflakeTable('POSTS', {
  id: integer('ID').notNull(),
  authorId: integer('AUTHOR_ID'),
  title: text('TITLE').notNull(),
});
const comments = snowflakeTable('COMMENTS', {
  id: integer('ID').notNull(),
  postId: integer('POST_ID').notNull(),
  body: text('BODY'),
});
const scores = snowflakeTable('SCORES', { value: float('VALUE').notNull() });
const u = users.columns;
const p = posts.columns;
const c = comments.columns;
declare const db: SnowflakeClient;

const userPosts = many(posts, { from: u.id, to: p.authorId }, (rows) =>
  rows.select({ id: p.id, title: p.title }).orderBy(asc(p.id)),
);
const loaded = withRelations(select(users, { id: u.id, name: u.name }).limit(10), {
  posts: userPosts,
});
expectTypeOf(db.execute(loaded)).resolves.toEqualTypeOf<{
  readonly rows: readonly {
    readonly id: bigint;
    readonly name: string;
    posts: { readonly id: bigint; readonly title: string }[];
  }[];
  readonly queryId: string;
  readonly queryIds: readonly string[];
}>();
expectTypeOf(db.stream(loaded)).toEqualTypeOf<
  AsyncIterable<{
    readonly id: bigint;
    readonly name: string;
    posts: { readonly id: bigint; readonly title: string }[];
  }>
>();

const withAuthor = withRelations(select(posts), {
  author: one(users, { from: p.authorId, to: u.id }),
  comments: many(comments, { from: p.id, to: c.postId }, (rows) =>
    withRelations(rows, {
      post: one(posts, { from: c.postId, to: p.id }, (q) => q.select({ title: p.title })),
    }),
  ),
});
expectTypeOf(withAuthor.rowType).toEqualTypeOf<
  | {
      readonly id: bigint;
      readonly authorId: bigint | null;
      readonly title: string;
      author: { readonly id: bigint; readonly name: string; readonly born: string | null } | null;
      comments: {
        readonly id: bigint;
        readonly postId: bigint;
        readonly body: string | null;
        post: { readonly title: string } | null;
      }[];
    }
  | undefined
>();

// Relations can read keys from joined sources of the parent query.
withRelations(select(posts).innerJoin(users, eq(p.authorId, u.id)).select({ title: p.title }), {
  others: many(posts, { from: u.id, to: p.authorId }),
});

// @ts-expect-error The parent key must belong to the parent query.
withRelations(select(users), { comments: many(comments, { from: p.id, to: c.postId }) });
// @ts-expect-error The related key must belong to the related table.
many(comments, { from: p.id, to: u.id });
// @ts-expect-error Keys must share one SQL type.
many(users, { from: p.title, to: u.id });
// @ts-expect-error Keys must be INTEGER, DECIMAL, TEXT, or DATE.
many(scores, { from: scores.columns.value, to: scores.columns.value });
// @ts-expect-error A relation name cannot repeat a projection key.
withRelations(select(users), { name: many(posts, { from: u.id, to: p.authorId }) });
