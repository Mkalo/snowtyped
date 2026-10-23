// Checked by tsc, not executed.
import { expectTypeOf } from 'vitest';
import {
  add,
  caseWhen,
  coalesce,
  count,
  eq,
  exists,
  insertFrom,
  integer,
  isNull,
  type Projection,
  select,
  snowflakeTable,
  text,
} from '../../src/index.js';
import type { SnowflakeClient } from '../../src/snowflake/index.js';

const posts = snowflakeTable('POSTS', {
  id: integer('ID').notNull(),
  authorId: integer('AUTHOR_ID'),
  title: text('TITLE').notNull(),
});
const users = snowflakeTable('USERS', {
  id: integer('ID').notNull(),
  name: text('NAME').notNull(),
  bio: text('BIO'),
});
const editors = snowflakeTable('EDITORS', {
  id: integer('ID').notNull(),
  postId: integer('POST_ID').notNull(),
  name: text('NAME').notNull(),
});
const p = posts.columns;
const u = users.columns;
declare const db: SnowflakeClient;

const joined = select(posts).leftJoin(users, eq(p.authorId, u.id));
const authored = joined.select({
  id: p.id,
  author: { id: u.id, name: u.name, bio: u.bio },
});
expectTypeOf(db.execute(authored)).resolves.toHaveProperty('rows').toEqualTypeOf<
  readonly {
    readonly id: bigint;
    readonly author: {
      readonly id: bigint;
      readonly name: string;
      readonly bio: string | null;
    } | null;
  }[]
>();
expectTypeOf(db.stream(authored)).toEqualTypeOf<
  AsyncIterable<{
    readonly id: bigint;
    readonly author: {
      readonly id: bigint;
      readonly name: string;
      readonly bio: string | null;
    } | null;
  }>
>();

const inner = select(posts)
  .innerJoin(users, eq(p.authorId, u.id))
  .select({ author: { id: u.id, bio: u.bio } });
expectTypeOf(inner.rowType).toEqualTypeOf<
  { readonly author: { readonly id: bigint; readonly bio: string | null } } | undefined
>();

// Without a NOT NULL entry, absence is indistinguishable from NULL values, so nothing collapses.
expectTypeOf(joined.select({ author: { bio: u.bio } }).rowType).toEqualTypeOf<
  { readonly author: { readonly bio: string | null } } | undefined
>();
// A key the outer join cannot null keeps the object present.
expectTypeOf(joined.select({ post: { id: p.id, name: u.name } }).rowType).toEqualTypeOf<
  { readonly post: { readonly id: bigint; readonly name: string | null } } | undefined
>();
expectTypeOf(
  select(posts, { id: p.id })
    .leftJoin(users, eq(p.authorId, u.id))
    .groupBy(p.id)
    .select({ stats: { posts: count(), name: u.name } }).rowType,
).toEqualTypeOf<
  { readonly stats: { readonly posts: bigint; readonly name: string | null } } | undefined
>();

// Each non-NULL key proves only its own sources.
const full = select(posts).fullJoin(users, eq(p.authorId, u.id));
expectTypeOf(full.select({ pair: { post: p.id, user: u.id } }).rowType).toEqualTypeOf<
  | { readonly pair: { readonly post: bigint | null; readonly user: bigint | null } | null }
  | undefined
>();
expectTypeOf(full.select({ pair: { sum: add(p.id, u.id), name: u.name } }).rowType).toEqualTypeOf<
  | { readonly pair: { readonly sum: bigint | null; readonly name: string | null } | null }
  | undefined
>();
// Only column keys prove their source: a non-NULL COALESCE or CASE can leave a source absent.
const edited = joined.leftJoin(editors, eq(p.id, editors.columns.postId));
expectTypeOf(
  edited.select({
    who: { name: coalesce(u.name, editors.columns.name), editorId: editors.columns.id },
  }).rowType,
).toEqualTypeOf<
  | { readonly who: { readonly name: string | null; readonly editorId: bigint | null } | null }
  | undefined
>();
expectTypeOf(
  edited.select({
    who: {
      name: caseWhen(isNull(u.id), editors.columns.name).else(u.name),
      id: editors.columns.id,
    },
  }).rowType,
).toEqualTypeOf<
  { readonly who: { readonly name: string | null; readonly id: bigint | null } | null } | undefined
>();

// Nested objects resolve presence relative to what their parent proves.
expectTypeOf(
  joined.select({ author: { id: u.id, profile: { bio: u.bio, title: p.title } } }).rowType,
).toEqualTypeOf<
  | {
      readonly author: {
        readonly id: bigint;
        readonly profile: { readonly bio: string | null; readonly title: string };
      } | null;
    }
  | undefined
>();
expectTypeOf(joined.select({ wrapper: { author: { id: u.id } } }).rowType).toEqualTypeOf<
  { readonly wrapper: { readonly author: { readonly id: bigint } | null } } | undefined
>();
expectTypeOf(select(posts, { post: { id: p.id } }).rowType).toEqualTypeOf<
  { readonly post: { readonly id: bigint } } | undefined
>();

// @ts-expect-error Nested entries keep the query's scope.
select(posts, { author: { id: u.id } });
// @ts-expect-error Nested entries keep the query's scope.
joined.select({ author: { other: snowflakeTable('OTHER', { id: integer('ID') }).columns.id } });
// @ts-expect-error A nested projection cannot become a derived table.
authored.as('nested');
// @ts-expect-error A nested projection cannot become a CTE.
authored.asCte('nested');
// @ts-expect-error A nested projection is not a set operand.
authored.union(authored);
// @ts-expect-error A nested projection is not a set operand.
select(posts, { id: p.id }).union(select(posts, { id: { value: p.id } }));
// @ts-expect-error A nested projection is not a subquery.
exists(select(users, { user: { id: u.id } }));
// @ts-expect-error A nested projection is not an INSERT source.
insertFrom(users, select(users, { user: { id: u.id } }));

const helper = <S extends Projection>(projection: S) => projection;
helper({ id: p.id, author: { name: u.name } });
