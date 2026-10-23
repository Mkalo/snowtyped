import { describe, expect, it } from 'vitest';
import {
  type AfterMatch,
  and,
  asc,
  compileAst,
  count,
  decimal,
  desc,
  eq,
  flatten,
  gt,
  identifier,
  integer,
  lt,
  type MatchRecognizeNode,
  matchRecognize,
  over,
  type RowPattern,
  rowNumber,
  rowPattern,
  select,
  snowflakeTable,
  sum,
  text,
  variant,
} from '../../src/index.js';
import { resultSchema } from '../../src/schema.js';

const prices = snowflakeTable('PRICES', {
  company: text('COMPANY').notNull(),
  day: integer('DAY').notNull(),
  price: decimal('PRICE').notNull(),
  note: text('NOTE'),
});
const other = snowflakeTable('OTHER', { id: integer('ID').notNull() });
const {
  variable,
  sequence,
  alternation,
  permute,
  exclude,
  start,
  end,
  zeroOrMore,
  oneOrMore,
  optional,
  repeat,
} = rowPattern;
const a = variable('a');
const b = variable('b');

function patternOf(shape: Parameters<typeof matchRecognize>[2]['pattern']): string {
  const relation = matchRecognize(prices, 'M', {
    pattern: shape,
    measures: ({ count }) => ({ n: count() }),
  });
  const sql = select(relation).compile().sql;
  return /PATTERN \((.*)\) DEFINE/.exec(sql)?.[1] as string;
}

describe('MATCH_RECOGNIZE', () => {
  it('compiles a typed V-shape match with ordered binds', () => {
    const relation = matchRecognize(prices, 'V', {
      partitionBy: ['company'],
      orderBy: (row) => [asc(row.day), desc(row.price, 'LAST')],
      pattern: sequence(variable('start'), oneOrMore(variable('down')), oneOrMore(variable('up'))),
      define: ({ row, lag }) => ({
        down: lt(row.price, lag(row.price, 2, '0')),
        up: gt(row.price, lag(row.price)),
      }),
      measures: ({ row, vars, first, last, matchNumber, classifier, count }) => ({
        match: matchNumber(),
        startDay: first(row.day),
        bottom: last(vars.down.day),
        ups: count('up'),
        rise: sum(vars.up.price),
        kind: classifier(),
        flagged: eq(row.note, 'x'),
      }),
    });
    expect(relation.source.kind).toBe('match-recognize');
    const compiled = select(relation).where(gt(relation.columns.ups, 1n)).compile();
    expect(compiled.sql).toBe(
      'SELECT "__sflib_result"."company" AS "company", TO_VARCHAR("__sflib_result"."match") AS "match", TO_VARCHAR("__sflib_result"."startDay") AS "startDay", TO_VARCHAR("__sflib_result"."bottom") AS "bottom", TO_VARCHAR("__sflib_result"."ups") AS "ups", TO_VARCHAR("__sflib_result"."rise") AS "rise", "__sflib_result"."kind" AS "kind", "__sflib_result"."flagged" AS "flagged" FROM (SELECT "company" AS "company", "match" AS "match", "startDay" AS "startDay", "bottom" AS "bottom", "ups" AS "ups", "rise" AS "rise", "kind" AS "kind", "flagged" AS "flagged" FROM (SELECT "COMPANY" AS "company", "DAY" AS "day", "PRICE" AS "price", "NOTE" AS "note" FROM "PRICES") MATCH_RECOGNIZE (PARTITION BY "company" ORDER BY "day" ASC, "price" DESC NULLS LAST MEASURES MATCH_NUMBER() AS "match", FIRST("day") AS "startDay", LAST("DOWN"."day") AS "bottom", COUNT("UP".*) AS "ups", SUM("UP"."price") AS "rise", CLASSIFIER() AS "kind", ("note" = ?) AS "flagged" ONE ROW PER MATCH PATTERN ("START" "DOWN"+ "UP"+) DEFINE "DOWN" AS ("price" < LAG("price", 2, ?)), "UP" AS ("price" > LAG("price"))) AS "V" ("company", "match", "startDay", "bottom", "ups", "rise", "kind", "flagged") WHERE ("ups" > ?)) AS "__sflib_result"',
    );
    expect(compiled.binds).toEqual(['x', '0', '1']);

    const parse = resultSchema(select(relation).selection);
    expect(
      parse.parse({
        company: 'ACME',
        match: '1',
        startDay: '1',
        bottom: null,
        ups: '2',
        rise: '21.0000',
        kind: 'UP',
        flagged: null,
      }),
    ).toEqual({
      company: 'ACME',
      match: 1n,
      startDay: 1n,
      bottom: null,
      ups: 2n,
      rise: '21.0000',
      kind: 'up',
      flagged: null,
    });
    expect(() =>
      parse.parse({
        company: 'ACME',
        match: '1',
        startDay: '1',
        bottom: null,
        ups: '2',
        rise: null,
        kind: 'SIDEWAYS',
        flagged: true,
      }),
    ).toThrow(/Unknown pattern variable: SIDEWAYS/);
    expect(() => parse.parse({ company: 'ACME', match: null })).toThrow();
    expect(select(relation).where(eq(relation.columns.kind, 'down')).compile().binds).toEqual([
      'x',
      '0',
      'DOWN',
    ]);
    expect(relation.columns.kind.dataType).toBe('text');
    expect(relation.columns.match.dataType).toBe('integer');
    expect(relation.columns.company.dataType).toBe('text');
    expect(relation.columns.kind.notNull().readSchema.parse('START')).toBe('start');
    expect(relation.columns.company.notNull().node).toEqual(identifier('company'));
    expect(relation.columns.match.encodeWrite(3n)).toEqual({ kind: 'parameter', value: '3' });
    expect(relation.columns.match.serverValue).toBeNull();
    expect(relation.columns.company.serverValue).toBeNull();
    expect(relation.columns.match.constraints).toEqual({});
    for (const column of [relation.columns.match, relation.columns.company])
      for (const modifier of [column.serverDefault, column.identity, column.virtual])
        expect(() => modifier()).toThrow(/base table columns/);
  });

  it('compiles every pattern operator and quantifier', () => {
    expect(patternOf(a)).toBe('"A"');
    expect(patternOf(zeroOrMore(a))).toBe('"A"*');
    expect(patternOf(zeroOrMore(a, { reluctant: true }))).toBe('"A"*?');
    expect(patternOf(oneOrMore(a, { reluctant: true }))).toBe('"A"+?');
    expect(patternOf(optional(a))).toBe('"A"?');
    expect(patternOf(optional(a, { reluctant: true }))).toBe('"A"??');
    expect(patternOf(repeat(a, 3))).toBe('"A"{3}');
    expect(patternOf(repeat(a, 3, 3, { reluctant: true }))).toBe('"A"{3}');
    expect(patternOf(repeat(a, 2, Number.POSITIVE_INFINITY))).toBe('"A"{2,}');
    expect(patternOf(repeat(a, 0, 4))).toBe('"A"{0,4}');
    expect(patternOf(repeat(a, 1, 4, { reluctant: true }))).toBe('"A"{1,4}?');
    expect(patternOf(oneOrMore(sequence(a, b)))).toBe('("A" "B")+');
    expect(patternOf(zeroOrMore(oneOrMore(a)))).toBe('("A"+)*');
    expect(patternOf(oneOrMore(alternation(a, sequence(b, a))))).toBe('("A" | "B" "A")+');
    expect(patternOf(optional(permute(a, sequence(b, b))))).toBe('PERMUTE("A", "B" "B")?');
    expect(patternOf(sequence(start, a, exclude(zeroOrMore(b)), end))).toBe('^ "A" {- "B"* -} $');
  });

  it('tracks pattern variables and whether a pattern can match no rows', () => {
    expect(sequence(a, b, a).variables).toEqual(['a', 'b']);
    expect(sequence(a, zeroOrMore(b)).empty).toBe(false);
    expect(sequence(start, zeroOrMore(b)).empty).toBe(true);
    expect(alternation(a, optional(b)).empty).toBe(true);
    expect(alternation(a, b).empty).toBe(false);
    expect(permute(optional(a), zeroOrMore(b)).empty).toBe(true);
    expect(repeat(a, 0, 2).empty).toBe(true);
    expect(oneOrMore(optional(a)).empty).toBe(true);
    expect(exclude(a).excludes).toBe(true);
    expect(sequence(a, exclude(b)).excludes).toBe(true);
    expect(alternation(a, exclude(b)).excludes).toBe(true);
    expect(permute(a, exclude(b)).excludes).toBe(true);
  });

  it('infers measure nullability from the rows-per-match mode and pattern', () => {
    const relation = (
      rowsPerMatch: 'one' | 'all' | 'all-omit-empty' | 'all-with-unmatched',
      shape: RowPattern<'a'> = zeroOrMore(a),
    ) =>
      matchRecognize(prices, 'M', {
        orderBy: (row) => [asc(row.day)],
        pattern: shape,
        measures: ({ matchNumber }) => ({ n: matchNumber() }),
        rowsPerMatch,
      });
    const accepts = (table: ReturnType<typeof relation>, row: Record<string, unknown>) =>
      table.columns.n.readSchema.safeParse(row.n).success;
    expect(accepts(relation('one'), { n: null })).toBe(true);
    expect(accepts(relation('all'), { n: null })).toBe(true);
    expect(accepts(relation('all-omit-empty'), { n: null })).toBe(false);
    expect(accepts(relation('all-with-unmatched', a), { n: null })).toBe(true);
    expect(accepts(relation('one', a), { n: null })).toBe(false);
    const all = relation('all-omit-empty');
    expect(Object.keys(all.columns)).toEqual(['company', 'day', 'price', 'note', 'n']);
    expect(select(all).compile().sql).toContain(
      'ALL ROWS PER MATCH OMIT EMPTY MATCHES PATTERN ("A"*) DEFINE "A" AS ?) AS "M" ("company", "day", "price", "note", "n")',
    );
    expect(select(all).compile().binds).toEqual([true]);
    expect(select(relation('all')).compile().sql).toContain(
      'ALL ROWS PER MATCH SHOW EMPTY MATCHES',
    );
    expect(select(relation('all-with-unmatched', a)).compile().sql).toContain(
      'ALL ROWS PER MATCH WITH UNMATCHED ROWS',
    );
  });

  it('compiles navigation, semantics, and AFTER MATCH SKIP options', () => {
    const relation = (afterMatch?: AfterMatch<'a' | 'b'>) =>
      matchRecognize(prices, 'M', {
        orderBy: (row) => [asc(row.day)],
        pattern: sequence(a, oneOrMore(b)),
        define: ({ row, lead, next, last }) => ({
          b: gt(row.price, last(row.price)),
          a: lt(lead(row.price, 0), next(row.price, 1, '5')),
        }),
        measures: ({
          row,
          vars,
          prev,
          next,
          lag,
          lead,
          first,
          last,
          final,
          running,
          count,
          matchSequenceNumber,
        }) => ({
          before: prev(row.price, 1, '0'),
          after: next(row.price),
          lagged: lag(row.day, 3),
          led: lead(row.day),
          head: first(vars.a.day),
          floor: final(last(vars.b.price)),
          total: final(count()),
          soFar: running(sum(vars.b.price)),
          seq: running(first(row.day)),
          lastCompany: final(last(row.company)),
          previous: lag(row.company),
          step: matchSequenceNumber(),
        }),
        rowsPerMatch: 'all',
        ...(afterMatch ? { afterMatch } : {}),
      });
    const sql = select(relation()).compile().sql;
    expect(sql).toContain(
      'MEASURES PREV("price", 1, ?) AS "before", NEXT("price") AS "after", LAG("day", 3) AS "lagged", LEAD("day") AS "led", FIRST("A"."day") AS "head", FINAL LAST("B"."price") AS "floor", FINAL COUNT(*) AS "total", RUNNING SUM("B"."price") AS "soFar", RUNNING FIRST("day") AS "seq", FINAL LAST("company") AS "lastCompany", LAG("company") AS "previous", MATCH_SEQUENCE_NUMBER() AS "step" ALL ROWS PER MATCH SHOW EMPTY MATCHES PATTERN ("A" "B"+) DEFINE "B" AS ("price" > LAST("price")), "A" AS (LEAD("price", 0) < NEXT("price", 1, ?))',
    );
    expect(sql).not.toContain('AFTER MATCH');
    expect(select(relation('past-last-row')).compile().sql).toContain(
      'AFTER MATCH SKIP PAST LAST ROW PATTERN',
    );
    expect(select(relation('to-next-row')).compile().sql).toContain(
      'AFTER MATCH SKIP TO NEXT ROW PATTERN',
    );
    expect(select(relation({ toFirst: 'b' })).compile().sql).toContain(
      'AFTER MATCH SKIP TO FIRST B PATTERN',
    );
    expect(select(relation({ toLast: 'b' })).compile().sql).toContain(
      'AFTER MATCH SKIP TO LAST B PATTERN',
    );
    const navigated = relation();
    const columns = navigated.columns;
    expect(columns.before.readSchema.parse('1.5')).toBe('1.5');
    expect(columns.after.readSchema.parse(null)).toBeNull();
    expect(columns.head.readSchema.parse(null)).toBeNull();
    expect(columns.floor.wireType).toBe('decimal');
    expect(
      select(navigated)
        .where(and(eq(columns.lagged, 4n), eq(columns.total, 3n), eq(columns.previous, 'x')))
        .compile().binds,
    ).toEqual(['0', '5', '4', '3', 'x']);
    expect(columns.step.readSchema.parse('2')).toBe(2n);
  });

  it('composes with joins, derived tables, and CTE sources', () => {
    const recent = select(prices).where(gt(prices.columns.day, 1n)).asCte('RECENT');
    const relation = matchRecognize(recent, 'M', {
      partitionBy: ['company'],
      pattern: a,
    });
    expect(Object.keys(relation.columns)).toEqual(['company']);
    const joined = select(relation)
      .innerJoin(other, eq(relation.columns.company, 'ACME'))
      .select({ company: relation.columns.company, id: other.columns.id });
    expect(joined.compile().sql).toBe(
      'SELECT "__sflib_result"."company" AS "company", TO_VARCHAR("__sflib_result"."id") AS "id" FROM (SELECT "M"."company" AS "company", "OTHER"."ID" AS "id" FROM (WITH "RECENT" AS (SELECT "COMPANY" AS "company", "DAY" AS "day", "PRICE" AS "price", "NOTE" AS "note" FROM "PRICES" WHERE ("DAY" > ?)) SELECT "RECENT"."company" AS "company", "RECENT"."day" AS "day", "RECENT"."price" AS "price", "RECENT"."note" AS "note" FROM "RECENT") MATCH_RECOGNIZE (PARTITION BY "company" ONE ROW PER MATCH PATTERN ("A") DEFINE "A" AS ?) AS "M" ("company") INNER JOIN "OTHER" ON ("M"."company" = ?)) AS "__sflib_result"',
    );
    const derived = matchRecognize(select(prices).as('D'), 'N', {
      pattern: a,
      measures: ({ row }) => ({ price: row.price, note: row.note.notNull() }),
    });
    expect(derived.columns.price.readSchema.parse('1')).toBe('1');
    expect(derived.columns.note.dataType).toBe('text');
    const nested = select(derived).as('OUTER');
    expect(Object.keys(nested.columns)).toEqual(['price', 'note']);
  });

  it('rejects invalid patterns', () => {
    expect(() => variable('1a')).toThrow(/simple identifiers/);
    expect(() => variable('__proto__')).toThrow(/simple identifiers/);
    expect(() => variable('x'.repeat(256))).toThrow(/simple identifiers/);
    expect(() => (sequence as (...values: never[]) => unknown)()).toThrow(/at least one item/);
    expect(() => (alternation as (...values: never[]) => unknown)()).toThrow(/at least one/);
    expect(() => (permute as (...values: never[]) => unknown)()).toThrow(/at least one/);
    expect(() => oneOrMore(start as never)).toThrow(/cannot be quantified/);
    expect(() => oneOrMore(exclude(a) as never)).toThrow(/cannot be quantified/);
    expect(() => repeat(a, -1)).toThrow(/nonnegative safe integers/);
    expect(() => repeat(a, 1.5)).toThrow(/nonnegative safe integers/);
    expect(() => repeat(a, 3, 2)).toThrow(/maximum/);
    expect(() => repeat(a, 0, 0)).toThrow(/maximum/);
    expect(() => repeat(a, 0, 1.5)).toThrow(/maximum/);
    expect(() => repeat(a, 2, Number.POSITIVE_INFINITY, { reluctant: true })).toThrow(/reluctant/);
  });

  it('rejects invalid clauses and scopes', () => {
    const base = {
      pattern: a,
      measures: ({ count }: { count: () => unknown }) => ({ n: count() }),
    };
    const build = (options: Record<string, unknown>, source = prices) =>
      matchRecognize(source, 'M', { ...base, ...options } as never);
    const nested = snowflakeTable('NESTED', { data: variant('DATA') });
    expect(() => build({}, flatten(nested.columns.data, 'F') as never)).toThrow(/cannot depend/);
    expect(() => build({ pattern: sequence(start, end) })).toThrow(/at least one variable/);
    expect(() => build({ pattern: sequence(a, variable('A')) })).toThrow(/case-insensitively/);
    expect(() =>
      build({ pattern: sequence(a, exclude(b)), rowsPerMatch: 'all-with-unmatched' }),
    ).toThrow(/WITH UNMATCHED ROWS/);
    expect(() => build({ orderBy: () => [asc(prices.columns.day)] })).toThrow(
      /ORDER BY accepts only scalar row expressions/,
    );
    expect(() =>
      build({ orderBy: (row: typeof prices.columns) => [asc(over(count(row.day)))] }),
    ).toThrow(/ORDER BY/);
    expect(() =>
      build({ define: ({ row }: { row: typeof prices.columns }) => ({ z: gt(row.day, 1n) }) }),
    ).toThrow(/missing from the pattern: z/);
    expect(() =>
      build({
        define: ({ row }: { row: typeof prices.columns }) => ({ a: gt(count(row.day), 1n) }),
      }),
    ).toThrow(/DEFINE accepts only/);
    expect(() => build({ define: () => ({ a: gt(prices.columns.day, 1n) }) })).toThrow(
      /DEFINE accepts only/,
    );
    let leaked: unknown;
    build({
      measures: ({ matchNumber }: { matchNumber: () => unknown }) => {
        leaked = matchNumber();
        return { n: leaked };
      },
    });
    expect(() => build({ define: () => ({ a: leaked as never }) })).toThrow(/DEFINE/);
    expect(() => select(prices, { n: leaked as never })).toThrow(/table scope/);
    expect(() => build({ measures: () => ({ n: prices.columns.day }) })).toThrow(/MEASURES/);
    expect(() => build({ measures: () => ({ n: rowNumber() }) })).toThrow(/MEASURES/);
    expect(() => build({ partitionBy: ['missing'] })).toThrow(/Unknown partition column/);
    expect(() => build({ partitionBy: ['company', 'company'] })).toThrow(/Duplicate partition/);
    expect(() => build({ measures: undefined })).toThrow(/needs partitionBy or measures/);
    expect(() =>
      build({
        partitionBy: ['company'],
        measures: ({ count }: { count: () => unknown }) => ({ company: count() }),
      }),
    ).toThrow(/Duplicate measure column: company/);
    expect(() =>
      build({
        rowsPerMatch: 'all',
        measures: ({ count }: { count: () => unknown }) => ({ day: count() }),
      }),
    ).toThrow(/Duplicate measure column: day/);
    expect(() =>
      build({
        measures: ({ count }: { count: () => unknown }) =>
          Object.fromEntries([['__proto__', count()]]),
      }),
    ).toThrow(/Reserved column name/);
    expect(() => build({ afterMatch: { toLast: 'b' } })).toThrow(/missing from the pattern: b/);
    expect(() =>
      build({ pattern: sequence(a, variable('select')), afterMatch: { toFirst: 'select' } }),
    ).toThrow(/reserved word/);
    expect(
      build({ pattern: sequence(variable('start'), a), afterMatch: { toLast: 'a' } }).source,
    ).toMatchObject({ afterMatch: { kind: 'to-last', variable: 'a' } });
  });

  it('rejects invalid navigation and semantics', () => {
    type Method = (...values: never[]) => unknown;
    type Context = {
      [K in
        | 'lag'
        | 'lead'
        | 'prev'
        | 'first'
        | 'final'
        | 'running'
        | 'count'
        | 'matchNumber']: Method;
    } & { row: typeof prices.columns; vars: Record<string, typeof prices.columns> };
    const measure = (body: (context: Context) => unknown, rowsPerMatch = 'all') =>
      matchRecognize(prices, 'M', {
        pattern: sequence(a, b),
        measures: (context: Context) => ({ n: body(context) }),
        rowsPerMatch,
      } as never);
    expect(() => measure(({ lag, row }) => lag(count(row.day) as never))).toThrow(/scalar/);
    expect(() =>
      measure(({ first, vars }) => first(eq(vars.a?.day as never, vars.b?.day as never) as never)),
    ).toThrow(/one pattern variable/);
    expect(() => measure(({ prev, vars }) => prev(vars.a?.day as never))).toThrow(
      /only unqualified row columns/,
    );
    expect(() => measure(({ lead, row }) => lead(row.day as never, -1 as never))).toThrow(
      /offsets/,
    );
    expect(() => measure(({ lead, row }) => lead(row.day as never, 0.5 as never))).toThrow(
      /offsets/,
    );
    expect(() =>
      measure(({ lead, row }) => lead(row.day as never, 1 as never, null as never)),
    ).toThrow(/default cannot be null/);
    expect(() => measure(({ running, count }) => running(count() as never), 'one')).toThrow(
      /RUNNING is not allowed/,
    );
    expect(() => measure(({ final, row }) => final(row.day as never))).toThrow(
      /navigation and aggregate/,
    );
    expect(() => measure(({ final, matchNumber }) => final(matchNumber() as never))).toThrow(
      /navigation and aggregate/,
    );
    expect(() => measure(({ count }) => count('z' as never))).toThrow(/Unknown pattern variable/);
    expect(
      measure(({ final, first, row }) => final(first(row.day as never) as never), 'one').columns,
    ).toHaveProperty('n');
  });

  it('validates hand-built AST nodes', () => {
    const relation = matchRecognize(prices, 'M', { pattern: a, partitionBy: ['company'] });
    const node = relation.source as MatchRecognizeNode;
    const statement = (patch: Partial<MatchRecognizeNode>) =>
      compileAst({
        kind: 'select',
        from: { ...node, ...patch },
        projections: [{ column: identifier('company'), alias: 'company' }],
      });
    expect(() => statement({ pattern: { kind: 'unknown' } as never })).toThrow(
      /Unsupported pattern/,
    );
    expect(() =>
      statement({
        pattern: { kind: 'quantifier', pattern: node.pattern, min: 2, reluctant: true },
      }),
    ).toThrow(/Reluctant/);
    expect(() => statement({ rowsPerMatch: 'some' as never })).toThrow(/rows-per-match/);
    expect(() => statement({ define: [] })).toThrow(/DEFINE entry/);
    expect(() =>
      statement({
        measures: [
          {
            value: { kind: 'navigation', name: 'LAG', value: identifier('day'), offset: -1 },
            alias: identifier('x'),
          },
        ],
      }),
    ).toThrow(/Navigation offsets/);
    expect(
      statement({
        measures: [
          {
            value: {
              kind: 'function',
              name: 'COUNT',
              args: [{ kind: 'star' }],
            },
            alias: identifier('x'),
          },
          {
            value: {
              kind: 'navigation',
              name: 'LAG',
              value: identifier('day'),
              default: { kind: 'parameter', value: 0 },
            },
            alias: identifier('y'),
          },
        ],
      }).sql,
    ).toContain('MEASURES COUNT(*) AS "x", LAG("day", 1, ?) AS "y"');
  });
});
