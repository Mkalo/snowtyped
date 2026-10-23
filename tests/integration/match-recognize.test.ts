import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  and,
  asc,
  decimal,
  eq,
  gt,
  gte,
  insert,
  integer,
  lt,
  matchRecognize,
  max,
  rowPattern,
  select,
  snowflakeTable,
  sql,
  sum,
  text,
} from '../../src/index.js';
import { createFixture, integrationConfig } from '../support/snowflake.js';

const { variable, sequence, alternation, permute, exclude, zeroOrMore, oneOrMore, repeat } =
  rowPattern;

describe('MATCH_RECOGNIZE against Snowflake', () => {
  const fixture = createFixture(integrationConfig());
  const db = fixture.client;
  const namespace = { database: fixture.table.node.parts[0] as string, schema: fixture.schemaName };
  const ticks = snowflakeTable(
    'TICKS',
    {
      id: integer('ID').notNull(),
      symbol: text('SYMBOL').notNull(),
      day: integer('DAY').notNull(),
      price: decimal('PRICE').notNull(),
    },
    namespace,
  );
  const symbols = snowflakeTable(
    'SYMBOLS',
    { symbol: text('SYMBOL').notNull(), label: text('LABEL').notNull() },
    namespace,
  );
  const prices: Record<string, number[]> = {
    ACME: [10, 8, 6, 9, 12, 11, 7, 13],
    FLAT: [5, 5],
    RISE: [1, 2, 3, 4],
    DIP: [10, 8, 6],
  };
  const big = 9007199254740993n;

  beforeAll(async () => {
    await fixture.seed();
    const name = (table: typeof ticks | typeof symbols) =>
      sql.identifier(...(table.node.parts as [string, ...string[]]));
    await db.queryRaw(
      sql`CREATE TABLE ${name(ticks)} (ID NUMBER(38,0) NOT NULL, SYMBOL VARCHAR NOT NULL, DAY NUMBER(38,0) NOT NULL, PRICE NUMBER(38,4) NOT NULL)`,
    );
    await db.queryRaw(
      sql`CREATE TABLE ${name(symbols)} (SYMBOL VARCHAR NOT NULL, LABEL VARCHAR NOT NULL)`,
    );
    let id = big;
    await db.execute(
      insert(
        ticks,
        Object.entries(prices).flatMap(([symbol, values]) =>
          values.map((price, index) => ({
            id: id++,
            symbol,
            day: BigInt(index + 1),
            price: `${price}.0000`,
          })),
        ),
      ),
    );
    await db.execute(
      insert(symbols, [
        { symbol: 'ACME', label: 'Acme Corp' },
        { symbol: 'RISE', label: 'Rising Inc' },
      ]),
    );
  });
  afterAll(() => fixture.cleanup());

  const vShape = matchRecognize(ticks, 'V', {
    partitionBy: ['symbol'],
    orderBy: (row) => [asc(row.day)],
    pattern: sequence(variable('start'), oneOrMore(variable('down')), oneOrMore(variable('up'))),
    define: ({ row, lag }) => ({
      down: lt(row.price, lag(row.price)),
      up: gt(row.price, lag(row.price)),
    }),
    measures: ({ row, vars, first, last, matchNumber, classifier, count }) => ({
      match: matchNumber(),
      startDay: first(row.day),
      bottomDay: last(vars.down.day),
      endDay: last(row.day),
      ups: count('up'),
      rise: sum(vars.up.price),
      kind: classifier(),
    }),
  });

  it('returns one typed row per match, with multiple and absent matches', async () => {
    const query = select(vShape).orderBy(asc(vShape.columns.symbol), asc(vShape.columns.match));
    expect((await db.execute(query)).rows).toEqual([
      {
        symbol: 'ACME',
        match: 1n,
        startDay: 1n,
        bottomDay: 3n,
        endDay: 5n,
        ups: 2n,
        rise: '21.0000',
        kind: 'up',
      },
      {
        symbol: 'ACME',
        match: 2n,
        startDay: 6n,
        bottomDay: 7n,
        endDay: 8n,
        ups: 1n,
        rise: '13.0000',
        kind: 'up',
      },
    ]);
  });

  it('composes matches with joins, encoded classifier filters, and CTEs', async () => {
    const query = select(vShape)
      .innerJoin(symbols, eq(vShape.columns.symbol, symbols.columns.symbol))
      .select({ label: symbols.columns.label, match: vShape.columns.match })
      .where(and(eq(vShape.columns.kind, 'up'), gte(vShape.columns.endDay, 8n)));
    expect((await db.execute(query)).rows).toEqual([{ label: 'Acme Corp', match: 2n }]);

    const recent = select(ticks).where(gte(ticks.columns.day, 2n)).asCte('RECENT');
    const climbs = matchRecognize(recent, 'C', {
      partitionBy: ['symbol'],
      orderBy: (row) => [asc(row.day)],
      pattern: oneOrMore(variable('up')),
      define: ({ row, lag }) => ({ up: gt(row.price, lag(row.price, 1, '0')) }),
      measures: ({ count, vars }) => ({ length: count('up'), top: max(vars.up.price) }),
    });
    const summary = select(climbs).where(eq(climbs.columns.symbol, 'RISE')).asCte('SUMMARY');
    expect((await db.execute(select(summary))).rows).toEqual([
      { symbol: 'RISE', length: 3n, top: '4.0000' },
    ]);
  });

  it('distinguishes overlapping matches from skipping past the last row', async () => {
    const rises = (afterMatch: 'past-last-row' | 'to-next-row') =>
      matchRecognize(ticks, 'R', {
        partitionBy: ['symbol'],
        orderBy: (row) => [asc(row.day)],
        pattern: repeat(variable('rise'), 2),
        define: ({ row, lag }) => ({ rise: gt(row.price, lag(row.price)) }),
        measures: ({ first, row }) => ({ from: first(row.day) }),
        afterMatch,
      });
    const days = async (afterMatch: 'past-last-row' | 'to-next-row') => {
      const relation = rises(afterMatch);
      const query = select(relation)
        .where(eq(relation.columns.symbol, 'RISE'))
        .orderBy(asc(relation.columns.from));
      return (await db.execute(query)).rows.map((row) => row.from);
    };
    expect(await days('past-last-row')).toEqual([2n]);
    expect(await days('to-next-row')).toEqual([2n, 3n]);

    const skipTo = matchRecognize(ticks, 'S', {
      partitionBy: ['symbol'],
      orderBy: (row) => [asc(row.day)],
      pattern: sequence(variable('a'), oneOrMore(variable('b'))),
      define: ({ row, lag }) => ({ b: gt(row.price, lag(row.price)) }),
      measures: ({ first, last, row }) => ({ from: first(row.day), to: last(row.day) }),
      afterMatch: { toLast: 'b' },
    });
    const query = select(skipTo)
      .where(eq(skipTo.columns.symbol, 'RISE'))
      .orderBy(asc(skipTo.columns.from));
    expect((await db.execute(query)).rows).toEqual([{ symbol: 'RISE', from: 1n, to: 4n }]);
  });

  it('treats undefined variables as matching every row', async () => {
    const runs = matchRecognize(ticks, 'N', {
      partitionBy: ['symbol'],
      orderBy: (row) => [asc(row.day)],
      pattern: oneOrMore(variable('any')),
      measures: ({ count }) => ({ rows: count() }),
    });
    const query = select(runs).orderBy(asc(runs.columns.symbol));
    expect((await db.execute(query)).rows).toEqual([
      { symbol: 'ACME', rows: 8n },
      { symbol: 'DIP', rows: 3n },
      { symbol: 'FLAT', rows: 2n },
      { symbol: 'RISE', rows: 4n },
    ]);
  });

  it('shows, omits, and pads empty and unmatched rows per mode', async () => {
    const run = async (rowsPerMatch: 'all' | 'all-omit-empty') => {
      const relation = matchRecognize(ticks, 'E', {
        partitionBy: ['symbol'],
        orderBy: (row) => [asc(row.day)],
        pattern: zeroOrMore(variable('low')),
        define: ({ row }) => ({ low: lt(row.price, '9') }),
        measures: ({ matchNumber, classifier, count }) => ({
          match: matchNumber(),
          kind: classifier(),
          lows: count('low'),
        }),
        rowsPerMatch,
      });
      const query = select(relation, {
        id: relation.columns.id,
        day: relation.columns.day,
        match: relation.columns.match,
        kind: relation.columns.kind,
        lows: relation.columns.lows,
      })
        .where(eq(relation.columns.symbol, 'DIP'))
        .orderBy(asc(relation.columns.day));
      return (await db.execute(query)).rows;
    };
    const dip = big + 14n;
    expect(await run('all')).toEqual([
      { id: dip, day: 1n, match: 1n, kind: null, lows: 0n },
      { id: dip + 1n, day: 2n, match: 2n, kind: 'low', lows: 1n },
      { id: dip + 2n, day: 3n, match: 2n, kind: 'low', lows: 2n },
    ]);
    expect(await run('all-omit-empty')).toEqual([
      { id: dip + 1n, day: 2n, match: 2n, kind: 'low', lows: 1n },
      { id: dip + 2n, day: 3n, match: 2n, kind: 'low', lows: 2n },
    ]);

    const unmatched = matchRecognize(ticks, 'U', {
      partitionBy: ['symbol'],
      orderBy: (row) => [asc(row.day)],
      pattern: variable('low'),
      define: ({ row }) => ({ low: lt(row.price, '9') }),
      measures: ({ matchNumber, classifier }) => ({ match: matchNumber(), kind: classifier() }),
      rowsPerMatch: 'all-with-unmatched',
    });
    const padded = select(unmatched, {
      day: unmatched.columns.day,
      match: unmatched.columns.match,
      kind: unmatched.columns.kind,
    })
      .where(eq(unmatched.columns.symbol, 'DIP'))
      .orderBy(asc(unmatched.columns.day));
    expect((await db.execute(padded)).rows).toEqual([
      { day: 1n, match: null, kind: null },
      { day: 2n, match: 1n, kind: 'low' },
      { day: 3n, match: 2n, kind: 'low' },
    ]);

    const summary = matchRecognize(ticks, 'O', {
      partitionBy: ['symbol'],
      orderBy: (row) => [asc(row.day)],
      pattern: zeroOrMore(variable('low')),
      define: ({ row }) => ({ low: lt(row.price, '9') }),
      measures: ({ matchNumber, count }) => ({ match: matchNumber(), lows: count('low') }),
    });
    const empties = select(summary)
      .where(eq(summary.columns.symbol, 'DIP'))
      .orderBy(asc(summary.columns.lows));
    expect((await db.execute(empties)).rows).toEqual([
      { symbol: 'DIP', match: null, lows: 0n },
      { symbol: 'DIP', match: 2n, lows: 2n },
    ]);
  });

  it('evaluates RUNNING and FINAL semantics, navigation, and exact wire values', async () => {
    const relation = matchRecognize(ticks, 'F', {
      partitionBy: ['symbol'],
      orderBy: (row) => [asc(row.day)],
      pattern: sequence(variable('top'), oneOrMore(variable('fall'))),
      define: ({ row, lag }) => ({ fall: lt(row.price, lag(row.price)) }),
      measures: ({ row, vars, final, running, last, count, prev, next, matchSequenceNumber }) => ({
        step: matchSequenceNumber(),
        soFar: running(count()),
        total: final(count()),
        floor: final(last(vars.fall.price)),
        before: prev(row.price, 1, '-1'),
        after: next(row.price),
      }),
      rowsPerMatch: 'all',
    });
    const query = select(relation, {
      id: relation.columns.id,
      price: relation.columns.price,
      step: relation.columns.step,
      soFar: relation.columns.soFar,
      total: relation.columns.total,
      floor: relation.columns.floor,
      before: relation.columns.before,
      after: relation.columns.after,
    })
      .where(eq(relation.columns.symbol, 'DIP'))
      .orderBy(asc(relation.columns.day));
    const dip = big + 14n;
    expect((await db.execute(query)).rows).toEqual([
      {
        id: dip,
        price: '10.0000',
        step: 1n,
        soFar: 1n,
        total: 3n,
        floor: '6.0000',
        before: '-1.0000',
        after: '8.0000',
      },
      {
        id: dip + 1n,
        price: '8.0000',
        step: 2n,
        soFar: 2n,
        total: 3n,
        floor: '6.0000',
        before: '10.0000',
        after: '6.0000',
      },
      {
        id: dip + 2n,
        price: '6.0000',
        step: 3n,
        soFar: 3n,
        total: 3n,
        floor: '6.0000',
        before: '8.0000',
        after: null,
      },
    ]);
  });

  it('runs alternation, permutation, exclusion, reluctant quantifiers, and anchors', async () => {
    const classify = async (shape: Parameters<typeof matchRecognize>[2]['pattern']) => {
      const relation = matchRecognize(ticks, 'P', {
        partitionBy: ['symbol'],
        orderBy: (row) => [asc(row.day)],
        pattern: shape,
        define: ({ row }) => ({ low: lt(row.price, '9'), high: gte(row.price, '9') }),
        measures: ({ classifier, matchNumber }) => ({
          kind: classifier(),
          match: matchNumber(),
        }),
        rowsPerMatch: 'all',
      });
      const query = select(relation, {
        day: relation.columns.day,
        kind: relation.columns.kind,
        match: relation.columns.match,
      })
        .where(eq(relation.columns.symbol, 'ACME'))
        .orderBy(asc(relation.columns.day));
      return (await db.execute(query)).rows.map((row) => [row.day, row.kind, row.match]);
    };
    expect(
      await classify(sequence(rowPattern.start, variable('high'), oneOrMore(variable('low')))),
    ).toEqual([
      [1n, 'high', 1n],
      [2n, 'low', 1n],
      [3n, 'low', 1n],
    ]);
    expect(await classify(permute(variable('low'), variable('high')))).toEqual([
      [1n, 'high', 1n],
      [2n, 'low', 1n],
      [3n, 'low', 2n],
      [4n, 'high', 2n],
      [6n, 'high', 3n],
      [7n, 'low', 3n],
    ]);
    expect(await classify(sequence(variable('high'), exclude(oneOrMore(variable('low')))))).toEqual(
      [
        [1n, 'high', 1n],
        [6n, 'high', 2n],
      ],
    );
    expect(
      await classify(
        sequence(oneOrMore(variable('high'), { reluctant: true }), variable('low'), rowPattern.end),
      ),
    ).toEqual([]);
    expect(
      await classify(
        alternation(
          sequence(repeat(variable('high'), 2, 3, { reluctant: true }), variable('low')),
          sequence(variable('low'), variable('low')),
        ),
      ),
    ).toEqual([
      [2n, 'low', 1n],
      [3n, 'low', 1n],
      [4n, 'high', 2n],
      [5n, 'high', 2n],
      [6n, 'high', 2n],
      [7n, 'low', 2n],
    ]);
  });
});
