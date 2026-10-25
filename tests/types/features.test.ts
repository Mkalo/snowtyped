import { expectTypeOf } from 'vitest';
import * as z from 'zod';
import {
  alias,
  array,
  binary,
  count,
  decimal,
  eq,
  flatten,
  geography,
  geometry,
  insert,
  integer,
  jsonPath,
  object,
  type Snowtyped,
  select,
  snowflakeTable,
  sql,
  structured,
  structuredType,
  text,
  time,
  timestamp,
  update,
  variant,
  vector,
} from '../../src/index.js';

const users = snowflakeTable('USERS', {
  id: integer('ID').notNull(),
  name: text('NAME').notNull(),
  data: variant('DATA').notNull(),
});
const orders = snowflakeTable('ORDERS', {
  id: integer('ID').notNull(),
  userId: integer('USER_ID').notNull(),
});
const other = snowflakeTable('OTHER', { id: integer('ID').notNull() });
const nullable = snowflakeTable('NULLABLE', { id: integer('ID') });
select(users).leftJoin(nullable, eq(users.columns.id, nullable.columns.id));
declare const db: Snowtyped.SnowflakeClient;
const left = select(users)
  .leftJoin(orders, eq(users.columns.id, orders.columns.userId))
  .select({ name: users.columns.name, orderId: orders.columns.id, count: count() });
expectTypeOf(db.execute(left))
  .resolves.toHaveProperty('rows')
  .toEqualTypeOf<
    readonly { readonly name: string; readonly orderId: bigint | null; readonly count: bigint }[]
  >();
const right = select(users)
  .rightJoin(orders, eq(users.columns.id, orders.columns.userId))
  .select({ name: users.columns.name, orderId: orders.columns.id });
expectTypeOf(db.execute(right))
  .resolves.toHaveProperty('rows')
  .toEqualTypeOf<readonly { readonly name: string | null; readonly orderId: bigint }[]>();
const full = select(users)
  .fullJoin(orders, eq(users.columns.id, orders.columns.userId))
  .select({ name: users.columns.name, orderId: orders.columns.id });
expectTypeOf(db.execute(full))
  .resolves.toHaveProperty('rows')
  .toEqualTypeOf<readonly { readonly name: string | null; readonly orderId: bigint | null }[]>();
const inner = select(users)
  .innerJoin(orders, eq(users.columns.id, orders.columns.userId))
  .select({ id: orders.columns.id });
expectTypeOf(db.execute(inner))
  .resolves.toHaveProperty('rows')
  .toEqualTypeOf<readonly { readonly id: bigint }[]>();
const source = left.as('RESULT');
expectTypeOf(db.execute(select(source)))
  .resolves.toHaveProperty('rows')
  .toEqualTypeOf<
    readonly { readonly name: string; readonly orderId: bigint | null; readonly count: bigint }[]
  >();
const renamed = alias(users, 'u');
select(renamed).where(eq(renamed.columns.id, 1n));
const expanded = flatten(jsonPath(users.columns.data, 'items'), 'f');
select(users).lateralJoin(expanded).select({ value: expanded.columns.value });
expectTypeOf(db.queryRaw<{ ID: string }[]>(sql`SELECT 1 AS ID`)).toEqualTypeOf<
  Promise<{ ID: string }[]>
>();
expectTypeOf(db.queryRaw(sql`SELECT 1`)).toEqualTypeOf<Promise<unknown>>();
insert(users, { id: 1n, name: 'Ada', data: { ok: true } });
// @ts-expect-error A structured VARIANT type requires a schema declaration, not a generic assertion.
variant<{ ok: boolean }>('PAYLOAD');
// @ts-expect-error A column from a different scope cannot be projected.
select(users, { id: other.columns.id });
// @ts-expect-error A filter cannot reference a table that was not joined.
select(users).where(eq(other.columns.id, 1n));
// @ts-expect-error A column from the source's original identity is not its alias.
select(renamed).where(eq(users.columns.id, 1n));
// @ts-expect-error Comparisons cannot mix integer and text expressions.
eq(users.columns.id, users.columns.name);
// @ts-expect-error Required declared columns must be present in inserts.
insert(users, { id: 1n, data: {} });
// @ts-expect-error Required VARIANT columns cannot be omitted even though their type is unknown.
insert(users, { id: 1n, name: 'Ada' });
// @ts-expect-error Insert values must match the declared domain.
insert(users, { id: '1', name: 'Ada', data: {} });
// @ts-expect-error Unknown insert column.
insert(users, { id: 1n, name: 'Ada', data: {}, missing: true });
// @ts-expect-error Unknown update column.
update(users, { missing: true });
// @ts-expect-error Update expressions must refer to the mutation's table.
update(users, { id: other.columns.id });
const tagged = snowflakeTable('TAGGED', {
  tag: variant('TAG', z.enum(['a', 'b'])).notNull(),
});
select(tagged).where(eq(tagged.columns.tag, 'a'));
const constrained = snowflakeTable('CONSTRAINED', {
  id: integer('ID', { precision: 10 }).notNull(),
  amount: decimal('AMOUNT', { precision: 12, scale: 2 }).notNull(),
  code: text('CODE', { length: 3 }),
  data: binary('DATA', { length: 16 }),
  clock: time('CLOCK', { precision: 3 }),
  at: timestamp('AT', 'tz', { precision: 6 }),
});
expectTypeOf(db.execute(select(constrained)))
  .resolves.toHaveProperty('rows')
  .toEqualTypeOf<
    readonly {
      readonly id: bigint;
      readonly amount: string;
      readonly code: string | null;
      readonly data: Uint8Array | null;
      readonly clock: string | null;
      readonly at: string | null;
    }[]
  >();
expectTypeOf(constrained.columns.amount.constraints.scale).toEqualTypeOf<number | undefined>();
// @ts-expect-error Length is a text or binary constraint, not a numeric one.
integer('ID', { length: 3 });
// @ts-expect-error Integers always have scale 0; declare a decimal for a nonzero scale.
integer('ID', { scale: 2 });
// @ts-expect-error Precision is not a VARCHAR constraint.
text('NAME', { precision: 3 });
// @ts-expect-error Constraint values are numbers.
decimal('AMOUNT', { precision: '12' });
const docs = snowflakeTable('DOCS', {
  tags: array('TAGS', z.string()).notNull(),
  items: array('ITEMS'),
  meta: object('META', z.object({ ok: z.boolean() })),
  extra: object('EXTRA'),
});
expectTypeOf(db.execute(select(docs)))
  .resolves.toHaveProperty('rows')
  .toEqualTypeOf<
    readonly {
      readonly tags: string[];
      readonly items: unknown[] | null;
      readonly meta: { ok: boolean } | null;
      readonly extra: Record<string, unknown> | null;
    }[]
  >();
insert(docs, { tags: [], items: [1, 'a'], meta: { ok: true }, extra: { any: [] } });
// @ts-expect-error Array elements must match the declared element schema.
insert(docs, { tags: [1] });
// @ts-expect-error ARRAY columns hold arrays.
insert(docs, { tags: 'a' });
// @ts-expect-error OBJECT values must match the declared schema.
update(docs, { meta: { ok: 'yes' } });
// @ts-expect-error OBJECT columns hold objects.
update(docs, { extra: [1] });
// @ts-expect-error An OBJECT schema must produce objects.
object('META', z.string());
const spatial = snowflakeTable('SPATIAL', {
  location: geography('LOCATION').notNull(),
  shape: geometry('SHAPE', { srid: 4326 }),
  embedding: vector('EMBEDDING', 'float', 3).notNull(),
  counts: vector('COUNTS', 'int', 2),
});
expectTypeOf(db.execute(select(spatial)))
  .resolves.toHaveProperty('rows')
  .toEqualTypeOf<
    readonly {
      readonly location: Snowtyped.GeoJsonGeometry;
      readonly shape: Snowtyped.GeoJsonGeometry | null;
      readonly embedding: number[];
      readonly counts: number[] | null;
    }[]
  >();
expectTypeOf(spatial.columns.shape.constraints.srid).toEqualTypeOf<number | undefined>();
insert(spatial, {
  location: { type: 'Point', coordinates: [1, 2] },
  shape: { type: 'GeometryCollection', geometries: [{ type: 'LineString', coordinates: [] }] },
  embedding: [1, 2, 3],
});
// @ts-expect-error Points have two to four coordinates.
insert(spatial, { location: { type: 'Point', coordinates: [1] }, embedding: [] });
// @ts-expect-error Spatial values are GeoJSON geometries, not WKT.
update(spatial, { shape: 'POINT(1 2)' });
// @ts-expect-error Polygon coordinates are rings of positions.
update(spatial, { location: { type: 'Polygon', coordinates: [[1, 2]] } });
// @ts-expect-error VECTOR values are number arrays.
update(spatial, { embedding: ['1'] });
// @ts-expect-error VECTOR elements are 'int' or 'float'.
vector('V', 'double', 3);
// @ts-expect-error SRID is a GEOMETRY option.
geography('G', { srid: 4326 });
const shaped = snowflakeTable('SHAPED', {
  scores: structured('SCORES', structuredType.array(structuredType.integer())).notNull(),
  address: structured(
    'ADDRESS',
    structuredType.object({
      city: structuredType.text(),
      zip: structuredType.decimal({ precision: 5 }).notNull(),
    }),
  ),
  prices: structured(
    'PRICES',
    structuredType.map(structuredType.text(), structuredType.boolean().notNull()),
  ),
  ids: structured('IDS', structuredType.map(structuredType.integer(), structuredType.text())),
});
expectTypeOf(db.execute(select(shaped)))
  .resolves.toHaveProperty('rows')
  .toEqualTypeOf<
    readonly {
      readonly scores: (bigint | null)[];
      readonly address: { city: string | null; zip: string } | null;
      readonly prices: Map<string, boolean> | null;
      readonly ids: Map<bigint, string | null> | null;
    }[]
  >();
insert(shaped, {
  scores: [1n, null],
  address: { city: null, zip: '12345' },
  prices: new Map([['a', true]]),
});
// @ts-expect-error Structured NUMBER elements are exact bigints.
insert(shaped, { scores: [1] });
// @ts-expect-error Every declared OBJECT field must be present.
update(shaped, { address: { zip: '1' } });
// @ts-expect-error Non-null fields reject NULL.
update(shaped, { address: { city: 'x', zip: null } });
// @ts-expect-error MAP values are Maps, not records.
update(shaped, { prices: { a: true } });
// @ts-expect-error MAP keys are VARCHAR or NUMBER types.
structuredType.map(structuredType.boolean(), structuredType.text());
// @ts-expect-error A structured column takes a structured type descriptor, not a Zod schema.
structured('X', z.string());
