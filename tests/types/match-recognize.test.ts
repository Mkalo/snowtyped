import { expectTypeOf } from 'vitest';
import {
  asc,
  decimal,
  eq,
  gt,
  integer,
  lt,
  matchRecognize,
  rowPattern,
  type Snowtyped,
  select,
  snowflakeTable,
  sum,
  text,
} from '../../src/index.js';

declare const db: Snowtyped.SnowflakeClient;
const prices = snowflakeTable('PRICES', {
  company: text('COMPANY').notNull(),
  day: integer('DAY').notNull(),
  price: decimal('PRICE').notNull(),
  note: text('NOTE'),
});
const { variable, sequence, oneOrMore, zeroOrMore } = rowPattern;

const vShape = matchRecognize(prices, 'V', {
  partitionBy: ['company'],
  orderBy: (row) => [asc(row.day)],
  pattern: sequence(variable('start'), oneOrMore(variable('down')), oneOrMore(variable('up'))),
  define: ({ row, lag }) => ({
    down: lt(row.price, lag(row.price)),
    up: gt(row.price, lag(row.price)),
  }),
  measures: ({ row, vars, first, last, matchNumber, classifier, count }) => ({
    match: matchNumber(),
    startDay: first(row.day),
    bottom: last(vars.down.day),
    ups: count('up'),
    total: sum(vars.up.price),
    kind: classifier(),
  }),
});
expectTypeOf(db.execute(select(vShape)))
  .resolves.toHaveProperty('rows')
  .toEqualTypeOf<
    readonly {
      readonly company: string;
      readonly match: bigint;
      readonly startDay: bigint;
      readonly bottom: bigint | null;
      readonly ups: bigint;
      readonly total: string | null;
      readonly kind: 'start' | 'down' | 'up';
    }[]
  >();

const all = matchRecognize(prices, 'A', {
  orderBy: (row) => [asc(row.day)],
  pattern: zeroOrMore(variable('low')),
  define: ({ row }) => ({ low: lt(row.price, '10') }),
  measures: ({ matchNumber }) => ({ n: matchNumber() }),
  rowsPerMatch: 'all',
});
expectTypeOf(db.execute(select(all)))
  .resolves.toHaveProperty('rows')
  .toEqualTypeOf<
    readonly {
      readonly company: string;
      readonly day: bigint;
      readonly price: string;
      readonly note: string | null;
      readonly n: bigint | null;
    }[]
  >();
select(all).where(eq(all.columns.n, 1n));

matchRecognize(prices, 'X', {
  pattern: variable('a'),
  // @ts-expect-error DEFINE names only pattern variables
  define: ({ row }) => ({ b: gt(row.price, '1') }),
  measures: ({ count }) => ({ n: count() }),
});
matchRecognize(prices, 'X', {
  pattern: variable('a'),
  // @ts-expect-error DEFINE cannot use outer tables
  define: () => ({ a: gt(prices.columns.price, '1') }),
  measures: ({ count }) => ({ n: count() }),
});
matchRecognize(prices, 'X', {
  pattern: variable('a'),
  // @ts-expect-error MEASURES cannot use outer tables
  measures: () => ({ n: prices.columns.price }),
});
matchRecognize(prices, 'X', {
  pattern: variable('a'),
  measures: ({ vars }) => ({
    // @ts-expect-error only pattern variables exist
    n: vars.b.price,
  }),
});
matchRecognize(prices, 'X', {
  pattern: variable('a'),
  measures: ({ count }) => ({
    // @ts-expect-error count names a pattern variable
    n: count('b'),
  }),
});
matchRecognize(prices, 'X', {
  pattern: variable('a'),
  measures: ({ vars, lag }) => ({
    // @ts-expect-error navigation shifts only unqualified row columns
    n: lag(vars.a.price),
  }),
});
matchRecognize(prices, 'X', {
  pattern: variable('a'),
  // @ts-expect-error DEFINE has no variable columns
  define: ({ vars }) => ({ a: vars }),
  measures: ({ count }) => ({ n: count() }),
});
matchRecognize(prices, 'X', {
  pattern: variable('a'),
  measures: ({ count }) => ({ n: count() }),
  // @ts-expect-error SKIP TO names a pattern variable
  afterMatch: { toLast: 'b' },
});
matchRecognize(prices, 'X', {
  partitionBy: ['company'],
  pattern: variable('a'),
  // @ts-expect-error measures cannot reuse an output column name
  measures: ({ count }) => ({ company: count() }),
});
matchRecognize(prices, 'X', {
  // @ts-expect-error partition columns come from the source
  partitionBy: ['missing'],
  pattern: variable('a'),
  measures: ({ count }) => ({ n: count() }),
});
select(vShape).where(eq(vShape.columns.kind, 'up'));
// @ts-expect-error classifier values are pattern variable names
select(vShape).where(eq(vShape.columns.kind, 'sideways'));
