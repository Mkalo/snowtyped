import * as z from 'zod';
import {
  type ExpressionNode,
  identifier,
  type MatchRecognizeNode,
  type NavigationNode,
  type PatternNode,
  type SourceReference,
} from './ast.js';
import {
  type AnyExpression,
  assertNotType,
  assertPredicate,
  type Expression,
  type ExpressionDataType,
  type ExpressionScope,
  expression,
  type InferExpression,
  type Ordering,
  type Predicate,
  type SpatialType,
  scalarParameter,
  spatialTypes,
} from './expressions.js';
import { derivedServerValue, select } from './query.js';
import {
  type AnyColumn,
  type BoundColumns,
  bindTable,
  type Column,
  type ColumnMap,
  type DataType,
  type Selection,
  type Table,
} from './schema.js';

/**
 * A MATCH_RECOGNIZE row pattern built with {@link rowPattern}. `V` is the union of its variable
 * names.
 */
export interface RowPattern<V extends string = string, Empty extends boolean = boolean> {
  /** The pattern's syntax tree. */
  readonly node: PatternNode;
  /** The pattern variables, in order of first appearance. */
  readonly variables: readonly string[];
  /** Whether the pattern can match zero rows. */
  readonly empty: boolean;
  /** Whether the pattern contains an exclusion. */
  readonly excludes: boolean;
  /** Whether a quantifier can be applied. Anchors and exclusions cannot be quantified. */
  readonly quantifiable: boolean;
  /** @internal */
  readonly variableType?: V;
  /** @internal */
  readonly emptyType?: Empty;
}
/** A row pattern that a quantifier such as `oneOrMore` can be applied to. */
export interface QuantifiablePattern<V extends string = string, Empty extends boolean = boolean>
  extends RowPattern<V, Empty> {
  /** Quantifiers can be applied. */
  readonly quantifiable: true;
}
/** Options of the {@link rowPattern} quantifiers. */
export interface QuantifierOptions {
  /** Prefer the fewest repetitions. */
  readonly reluctant?: boolean;
}
type PatternVariables<P> = P extends RowPattern<infer V, boolean> ? V : never;
type PatternEmpty<P> = P extends RowPattern<string, infer E> ? E : never;
type Patterns = readonly [RowPattern, ...RowPattern[]];

// SKIP TO targets must be unquoted, and Snowflake rejects these words there (live-verified).
const reserved = /* @__PURE__ */ new Set(
  /* @__PURE__ */ 'ALL ALTER AND ANY AS ASOF BETWEEN BY CASE CAST CHECK COLUMN CONNECT CREATE CROSS CURRENT DELETE DISTINCT DROP ELSE EXISTS FALSE FOLLOWING FOR FROM FULL GRANT GROUP HAVING ILIKE IN INCREMENT INNER INSERT INTERSECT INTO IS JOIN LATERAL LEFT LIKE MATCH_CONDITION MINUS NATURAL NOT NULL OF ON OR ORDER QUALIFY REGEXP REVOKE RIGHT RLIKE ROW ROWS SAMPLE SELECT SET SOME START TABLE TABLESAMPLE THEN TO TRIGGER TRUE TRY_CAST UNION UNIQUE UPDATE USING VALUES WHEN WHENEVER WHERE WITH'.split(
    ' ',
  ),
);

function pattern(
  node: PatternNode,
  variables: readonly string[],
  empty: boolean,
  excludes: boolean,
  quantifiable = true,
): QuantifiablePattern {
  return Object.freeze({
    node: Object.freeze(node),
    variables: Object.freeze([...new Set(variables)]),
    empty,
    excludes,
    quantifiable,
  }) as QuantifiablePattern;
}
function items(values: readonly RowPattern[], kind: string): readonly PatternNode[] {
  if (!values.length) throw new TypeError(`A pattern ${kind} needs at least one item.`);
  return Object.freeze(values.map((value) => value.node));
}
function quantify(
  value: QuantifiablePattern,
  min: number,
  max: number | undefined,
  options: QuantifierOptions,
): QuantifiablePattern {
  if (!value.quantifiable) throw new TypeError('Anchors and exclusions cannot be quantified.');
  if (!Number.isSafeInteger(min) || min < 0)
    throw new TypeError('Pattern repetition bounds must be nonnegative safe integers.');
  if (max !== undefined && (!Number.isSafeInteger(max) || max < Math.max(min, 1)))
    throw new TypeError('A pattern repetition maximum must be a positive safe integer ≥ minimum.');
  const reluctant = options.reluctant ?? false;
  if (reluctant && max === undefined && min > 1)
    throw new TypeError('Snowflake supports reluctant {n,} only for zeroOrMore and oneOrMore.');
  return pattern(
    {
      kind: 'quantifier',
      pattern: value.node,
      min,
      ...(max === undefined ? {} : { max }),
      reluctant,
    },
    value.variables,
    min === 0 || value.empty,
    value.excludes,
  );
}

/**
 * Builders for MATCH_RECOGNIZE row patterns. Variable names are matched case-insensitively by
 * Snowflake.
 *
 * @example
 * ```ts
 * const { variable, sequence, oneOrMore } = rowPattern;
 * const vShape = sequence(
 *   variable('start'),
 *   oneOrMore(variable('down')),
 *   oneOrMore(variable('up')),
 * );
 * ```
 */
export const rowPattern = /* @__PURE__ */ Object.freeze({
  /**
   * A pattern variable, matched by its `define` predicate or by every row when it has none.
   *
   * @throws `TypeError` unless the name is a simple identifier.
   */
  variable<const V extends string>(name: V): QuantifiablePattern<V, false> {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || name.length > 255 || name === '__proto__')
      throw new TypeError('Pattern variables must be simple identifiers.');
    return pattern({ kind: 'variable', name }, [name], false, false) as QuantifiablePattern<
      V,
      false
    >;
  },
  /** Matches the items one after another. */
  sequence<const P extends Patterns>(
    ...values: P
  ): QuantifiablePattern<
    PatternVariables<P[number]>,
    false extends PatternEmpty<P[number]> ? false : true
  > {
    return pattern(
      { kind: 'sequence', items: items(values, 'sequence') },
      values.flatMap((value) => value.variables),
      values.every((value) => value.empty),
      values.some((value) => value.excludes),
    ) as never;
  },
  /** Matches any one of the items, preferring earlier ones. */
  alternation<const P extends Patterns>(
    ...values: P
  ): QuantifiablePattern<
    PatternVariables<P[number]>,
    true extends PatternEmpty<P[number]> ? true : false
  > {
    return pattern(
      { kind: 'alternation', items: items(values, 'alternation') },
      values.flatMap((value) => value.variables),
      values.some((value) => value.empty),
      values.some((value) => value.excludes),
    ) as never;
  },
  /** Matches the items in any order. */
  permute<const P extends Patterns>(
    ...values: P
  ): QuantifiablePattern<
    PatternVariables<P[number]>,
    false extends PatternEmpty<P[number]> ? false : true
  > {
    return pattern(
      { kind: 'permute', items: items(values, 'permutation') },
      values.flatMap((value) => value.variables),
      values.every((value) => value.empty),
      values.some((value) => value.excludes),
    ) as never;
  },
  /** Matches rows that ALL ROWS PER MATCH leaves out of the output. */
  exclude<V extends string, E extends boolean>(value: RowPattern<V, E>): RowPattern<V, E> {
    return pattern(
      { kind: 'exclusion', pattern: value.node },
      value.variables,
      value.empty,
      true,
      false,
    ) as RowPattern<V, E>;
  },
  /** `^`, which matches the start of a partition. */
  start: /* @__PURE__ */ pattern(
    { kind: 'anchor', position: 'start' },
    [],
    true,
    false,
    false,
  ) as RowPattern<never, true>,
  /** `$`, which matches the end of a partition. */
  end: /* @__PURE__ */ pattern(
    { kind: 'anchor', position: 'end' },
    [],
    true,
    false,
    false,
  ) as RowPattern<never, true>,
  /** `*`: zero or more repetitions. */
  zeroOrMore<V extends string>(
    value: QuantifiablePattern<V>,
    options: QuantifierOptions = {},
  ): QuantifiablePattern<V, true> {
    return quantify(value, 0, undefined, options) as QuantifiablePattern<V, true>;
  },
  /** `+`: one or more repetitions. */
  oneOrMore<V extends string, E extends boolean>(
    value: QuantifiablePattern<V, E>,
    options: QuantifierOptions = {},
  ): QuantifiablePattern<V, E> {
    return quantify(value, 1, undefined, options) as QuantifiablePattern<V, E>;
  },
  /** `?`: zero or one repetition. */
  optional<V extends string>(
    value: QuantifiablePattern<V>,
    options: QuantifierOptions = {},
  ): QuantifiablePattern<V, true> {
    return quantify(value, 0, 1, options) as QuantifiablePattern<V, true>;
  },
  /**
   * A bounded repetition: `{min}` without a maximum, `{min,max}` with one, and `{min,}` with
   * `Infinity`.
   */
  repeat<V extends string, E extends boolean, const Min extends number>(
    value: QuantifiablePattern<V, E>,
    min: Min,
    max: number = min,
    options: QuantifierOptions = {},
  ): QuantifiablePattern<V, 0 extends Min ? true : E> {
    return quantify(
      value,
      min,
      max === Number.POSITIVE_INFINITY ? undefined : max,
      options,
    ) as never;
  },
});

/**
 * How many rows MATCH_RECOGNIZE returns: `'one'` per match, or `'all'` rows of each match,
 * optionally omitting empty matches or including unmatched rows.
 */
export type RowsPerMatch = 'one' | 'all' | 'all-omit-empty' | 'all-with-unmatched';
/**
 * Where matching resumes after a match: past its last row, at the next row, or at the first or last
 * row mapped to a variable.
 */
export type AfterMatch<V extends string> =
  | 'past-last-row'
  | 'to-next-row'
  | { readonly toFirst: V }
  | { readonly toLast: V };
/** Scope of unqualified row columns inside MATCH_RECOGNIZE `N`. */
export type MatchRowScope<N extends string> = `${N}.*`;
/** Scope of columns qualified by pattern variable `V`. */
export type MatchVariableScope<N extends string, V extends string> = `${N}.${V}`;
type RowExpression<N extends string> = Expression<unknown, MatchRowScope<N>, string>;

type Navigated<T, N extends string, E extends AnyExpression> = Expression<
  T,
  MatchRowScope<N>,
  MatchRowScope<N>,
  ExpressionDataType<E>
>;
/**
 * A navigation function such as `lag` or `prev`: reads a column of a row before or after the
 * current one, by a constant offset that defaults to 1, with an optional fallback.
 */
export interface Navigation<N extends string> {
  /** Reads a column `offset` rows away, 1 by default. NULL when there is no such row. */
  <E extends RowExpression<N>>(
    value: E,
    offset?: number,
  ): Navigated<InferExpression<E> | null, N, E>;
  /** Reads a column `offset` rows away, or `fallback` when there is no such row. */
  <E extends RowExpression<N>>(
    value: E,
    offset: number,
    fallback: NonNullable<NoInfer<InferExpression<E>>>,
  ): Navigated<InferExpression<E>, N, E>;
}
/** The helpers passed to `define` in {@link matchRecognize}. */
export interface DefineContext<C extends ColumnMap, N extends string> {
  /** The row being classified. */
  readonly row: BoundColumns<C, MatchRowScope<N>>;
  /** `LAG`: a column of an earlier row of the partition. */
  readonly lag: Navigation<N>;
  /** `LEAD`: a column of a later row of the partition. */
  readonly lead: Navigation<N>;
  /** `NEXT`: a column of the next row. */
  readonly next: Navigation<N>;
  /** `LAST`: a column of the last row mapped so far. */
  last<E extends RowExpression<N>>(value: E): Navigated<InferExpression<E>, N, E>;
}
/** The helpers passed to `measures` in {@link matchRecognize}. */
export interface MeasureContext<C extends ColumnMap, N extends string, V extends string> {
  /** The source columns of the current row. */
  readonly row: BoundColumns<C, MatchRowScope<N>>;
  /** Columns restricted to rows mapped to each variable. */
  readonly vars: { readonly [K in V]: BoundColumns<C, MatchVariableScope<N, K>> };
  /** `LAG`: a column of an earlier row of the partition. */
  readonly lag: Navigation<N>;
  /** `LEAD`: a column of a later row of the partition. */
  readonly lead: Navigation<N>;
  /** `PREV`: a column of the previous row. */
  readonly prev: Navigation<N>;
  /** `NEXT`: a column of the next row. */
  readonly next: Navigation<N>;
  /** `FIRST`: the value at the first row of the match, or at the first row mapped to a variable. */
  first<E extends Expression<unknown, MatchRowScope<N> | MatchVariableScope<N, V>, string>>(
    value: E,
  ): Expression<
    InferExpression<E> | (ExpressionScope<E> extends MatchRowScope<N> ? never : null),
    ExpressionScope<E>,
    ExpressionScope<E>,
    ExpressionDataType<E>
  >;
  /** `LAST`: the value at the last row of the match, or at the last row mapped to a variable. */
  last<E extends Expression<unknown, MatchRowScope<N> | MatchVariableScope<N, V>, string>>(
    value: E,
  ): Expression<
    InferExpression<E> | (ExpressionScope<E> extends MatchRowScope<N> ? never : null),
    ExpressionScope<E>,
    ExpressionScope<E>,
    ExpressionDataType<E>
  >;
  /** Evaluates over the whole match; required for variable columns in ALL ROWS PER MATCH. */
  final<E extends AnyExpression>(value: E): E;
  /** Evaluates up to the current row; ALL ROWS PER MATCH only. */
  running<E extends AnyExpression>(value: E): E;
  /** `COUNT(*)`: the number of rows in the match. */
  count(): Expression<bigint, MatchRowScope<N>, never, 'integer'>;
  /** `COUNT(variable.*)`: the number of rows mapped to a variable. */
  count<K extends V>(variable: K): Expression<bigint, MatchVariableScope<N, K>, never, 'integer'>;
  /** `MATCH_NUMBER()`: the match's sequential number within its partition. */
  matchNumber(): Expression<bigint, MatchRowScope<N>, never, 'integer'>;
  /** `MATCH_SEQUENCE_NUMBER()`: the row's sequential number within its match. */
  matchSequenceNumber(): Expression<bigint, MatchRowScope<N>, never, 'integer'>;
  /** `CLASSIFIER()`: the variable the row is mapped to. */
  classifier(): Expression<V, MatchRowScope<N>, never, 'text'>;
}
type MeasureColumn<T, D extends DataType> = Column<
  NonNullable<T>,
  null extends T ? false : true,
  string,
  'none',
  D
>;
/** Snowflake rejects GEOGRAPHY and GEOMETRY partition keys. */
export type PartitionKey<C extends ColumnMap> = {
  [K in keyof C & string]: ExpressionDataType<C[K]> extends SpatialType ? never : K;
}[keyof C & string];
type NullableMeasures<R extends RowsPerMatch, E extends boolean> = R extends 'all-with-unmatched'
  ? true
  : R extends 'all-omit-empty'
    ? false
    : E;
/**
 * The columns of a {@link matchRecognize} result: the partition keys for one row per match, or
 * every source column otherwise, followed by the measures.
 */
export type MatchRecognizeColumns<
  C extends ColumnMap,
  P extends keyof C,
  M extends Selection,
  R extends RowsPerMatch,
  E extends boolean,
> = (R extends 'one' ? Pick<C, P> : C) & {
  readonly [K in keyof M]: MeasureColumn<
    InferExpression<M[K]> | (NullableMeasures<R, E> extends true ? null : never),
    M[K] extends AnyExpression ? ExpressionDataType<M[K]> : DataType
  >;
};
type Collisions<T, Taken> = { readonly [K in Extract<keyof T, Taken>]: never };
type Unknown<T, Allowed> = { readonly [K in Exclude<keyof T, Allowed>]: never };

/** Options of {@link matchRecognize}. */
export interface MatchRecognizeOptions<
  C extends ColumnMap,
  N extends string,
  P extends readonly (keyof C & string)[],
  V extends string,
  E extends boolean,
  D,
  M,
  R extends RowsPerMatch,
> {
  /** Source column keys to partition by. GEOGRAPHY and GEOMETRY columns are rejected. */
  readonly partitionBy?: P;
  /** Orders rows within each partition. */
  readonly orderBy?: (
    row: BoundColumns<C, MatchRowScope<N>>,
  ) => readonly Ordering<MatchRowScope<N>>[];
  /** The row pattern, built with {@link rowPattern}. */
  readonly pattern: RowPattern<V, E>;
  /**
   * BOOLEAN conditions keyed by pattern variable. Variables without a definition match every row.
   */
  readonly define?: (context: DefineContext<C, N>) => D;
  /** Output expressions computed for each match, keyed by output column name. */
  readonly measures?: (context: MeasureContext<C, N, V>) => M;
  /** How many rows to return per match. Defaults to `'one'`. */
  readonly rowsPerMatch?: R;
  /** Where matching resumes after a match. Defaults to past the last row. */
  readonly afterMatch?: AfterMatch<NoInfer<V>>;
}

function scoped(value: AnyColumn, node: ExpressionNode, ref: SourceReference): AnyColumn {
  return Object.freeze({
    ...value,
    phase: 'scalar',
    expression: Object.freeze(node),
    refs: Object.freeze([ref]),
    nullRefs: Object.freeze([ref]),
    notNull: () => scoped(value.notNull(), node, ref) as Column<unknown, true>,
  });
}
function renamed(key: string, value: AnyColumn): AnyColumn {
  return Object.freeze({
    ...value,
    node: identifier(key),
    serverValue: null,
    notNull: () => renamed(key, value.notNull()) as Column<unknown, true>,
    serverDefault: derivedServerValue,
    identity: derivedServerValue,
    virtual: derivedServerValue,
  });
}
function measured(key: string, value: AnyExpression, nullable: boolean): AnyColumn {
  const node = identifier(key);
  const column: AnyColumn = Object.freeze({
    ...expression(node, nullable ? value.readSchema.nullable() : value.readSchema, {
      dataType: value.dataType,
      valueSchema: nullable ? value.valueSchema.nullable() : value.valueSchema,
      ...(value.wireType ? { wireType: value.wireType } : {}),
      encode: (parsed: unknown) => value.encode(parsed),
    }),
    node,
    required: true,
    constraints: Object.freeze({}),
    serverValue: null,
    encodeWrite: (parsed: unknown) => value.encode(parsed),
    notNull: () => column as Column<unknown, true>,
    serverDefault: derivedServerValue,
    identity: derivedServerValue,
    virtual: derivedServerValue,
  });
  return column;
}
function claim(taken: Set<string>, key: string, clause: string): void {
  identifier(key);
  if (key === '__proto__') throw new TypeError('Reserved column name.');
  if (taken.has(key)) throw new TypeError(`Duplicate ${clause} column: ${key}`);
  taken.add(key);
}
function reference(name: string): SourceReference {
  return Object.freeze({ id: Symbol(name), name, qualifier: identifier(name) });
}
const bigintText = () => z.string().regex(/^\d+$/).transform(BigInt);

/**
 * Creates a MATCH_RECOGNIZE table source for row pattern matching.
 *
 * Inside the clause, columns are named by their source keys. The output columns are the partition
 * keys and measures for one row per match, or every source column and the measures otherwise.
 * Measures become nullable when unmatched rows or empty matches can appear. In ALL ROWS PER MATCH,
 * wrap `first` or `last` of variable columns in `final`.
 *
 * @param name - The source name of the result.
 * @example
 * ```ts
 * const { variable, sequence, oneOrMore } = rowPattern;
 * const vShapes = matchRecognize(stocks, 'V', {
 *   partitionBy: ['company'],
 *   orderBy: (row) => [asc(row.day)],
 *   pattern: sequence(variable('start'), oneOrMore(variable('down')), oneOrMore(variable('up'))),
 *   define: ({ row, lag }) => ({
 *     down: lt(row.price, lag(row.price)),
 *     up: gt(row.price, lag(row.price)),
 *   }),
 *   measures: ({ row, vars, first, last, matchNumber }) => ({
 *     match: matchNumber(),
 *     startDay: first(row.day),
 *     bottomDay: last(vars.down.day),
 *   }),
 * });
 * select(vShapes);
 * ```
 */
export function matchRecognize<
  C extends ColumnMap,
  const N extends string,
  V extends string,
  E extends boolean,
  const P extends readonly PartitionKey<C>[] = [],
  D extends Readonly<Record<string, Predicate<MatchRowScope<N>>>> = Record<never, never>,
  M extends Readonly<
    Record<string, Expression<unknown, MatchRowScope<N> | MatchVariableScope<N, V>, string>>
  > = Record<never, never>,
  R extends RowsPerMatch = 'one',
>(
  source: Table<C>,
  name: N,
  options: MatchRecognizeOptions<
    C,
    N,
    P,
    V,
    E,
    D & Unknown<D, V>,
    M & Collisions<M, R extends 'one' ? P[number] : keyof C>,
    R
  >,
): Table<BoundColumns<MatchRecognizeColumns<C, P[number], M, R, E>, N>, N>;
export function matchRecognize(
  source: Table,
  name: string,
  options: MatchRecognizeOptions<
    ColumnMap,
    string,
    readonly string[],
    string,
    boolean,
    Readonly<Record<string, Predicate>>,
    Selection,
    RowsPerMatch
  >,
): Table {
  if (source.dependencies.length)
    throw new TypeError('MATCH_RECOGNIZE sources cannot depend on other sources.');
  const input = select(source).ast;
  const rows = options.rowsPerMatch ?? 'one';
  const shape = options.pattern;
  const variables = shape.variables;
  if (!variables.length) throw new TypeError('A row pattern needs at least one variable.');
  const folded = new Set(variables.map((variable) => variable.toUpperCase()));
  if (folded.size !== variables.length)
    throw new TypeError('Pattern variables must differ case-insensitively.');
  if (rows === 'all-with-unmatched' && shape.excludes)
    throw new TypeError('WITH UNMATCHED ROWS cannot be combined with pattern exclusions.');

  const rowRef = reference(`${name}.*`);
  const measureRef = reference(`${name}.measures`);
  const variableRefs = new Map(
    variables.map((variable) => [variable, reference(`${name}.${variable}`)]),
  );
  const entries = Object.entries(source.columns);
  const row = Object.freeze(
    Object.fromEntries(
      entries.map(([key, value]) => [key, scoped(value, identifier(key), rowRef)]),
    ),
  );
  const vars = Object.freeze(
    Object.fromEntries(
      variables.map((variable) => {
        const ref = variableRefs.get(variable) as SourceReference;
        const qualifier = variable.toUpperCase();
        return [
          variable,
          Object.freeze(
            Object.fromEntries(
              entries.map(([key, value]) => [key, scoped(value, identifier(qualifier, key), ref)]),
            ),
          ),
        ];
      }),
    ),
  );

  function navigate(
    name: NavigationNode['name'],
    value: AnyExpression,
    options: { offset?: number; fallback?: unknown; nullable: boolean; measure: boolean },
  ): AnyExpression {
    if (value.phase !== 'scalar')
      throw new TypeError(`${name} requires a scalar expression without aggregates.`);
    const qualifiers = new Set(value.refs.filter((ref) => ref !== measureRef));
    const symbol = [...qualifiers].some((ref) => ref !== rowRef);
    if (qualifiers.size > 1)
      throw new TypeError(`${name} columns must all use one pattern variable or none.`);
    if (symbol && !['FIRST', 'LAST'].includes(name))
      throw new TypeError(`${name} accepts only unqualified row columns.`);
    const { offset, fallback } = options;
    if (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 0))
      throw new TypeError('Navigation offsets must be nonnegative safe integers.');
    if (fallback === null) throw new TypeError('A navigation default cannot be null.');
    const nullable = options.nullable && fallback === undefined;
    return expression<unknown>(
      {
        kind: 'navigation',
        name,
        value: value.expression,
        ...(offset === undefined ? {} : { offset }),
        ...(fallback === undefined ? {} : { default: value.encode(fallback) }),
      },
      nullable ? value.readSchema.nullable() : value.readSchema,
      {
        dataType: value.dataType,
        valueSchema: nullable ? value.valueSchema.nullable() : value.valueSchema,
        refs: options.measure ? [...value.refs, measureRef] : value.refs,
        ...(value.wireType ? { wireType: value.wireType } : {}),
        encode: (parsed) => value.encode(parsed),
      },
    );
  }
  const shift =
    (name: 'LAG' | 'LEAD' | 'PREV' | 'NEXT', measure: boolean) =>
    (value: AnyExpression, offset?: number, fallback?: unknown) =>
      navigate(name, value, {
        ...(offset === undefined ? {} : { offset }),
        ...(fallback === undefined ? {} : { fallback }),
        nullable: true,
        measure,
      });
  const edge = (name: 'FIRST' | 'LAST', measure: boolean) => (value: AnyExpression) =>
    navigate(name, value, {
      nullable: value.refs.some((ref) => ref !== rowRef && ref !== measureRef),
      measure,
    });
  function counter(name: string, refs: readonly SourceReference[], args: ExpressionNode[] = []) {
    const node: ExpressionNode = {
      kind: 'function',
      name,
      args: Object.freeze(args),
      ...(name === 'COUNT' ? { role: 'aggregate' as const } : {}),
    };
    return expression<bigint>(node, bigintText(), {
      dataType: 'integer',
      valueSchema: z.bigint(),
      refs,
      phase: name === 'COUNT' ? 'aggregate' : 'scalar',
      nullRefs: [],
      wireType: 'integer',
    });
  }
  function semantics(mode: 'RUNNING' | 'FINAL', value: AnyExpression): AnyExpression {
    if (mode === 'RUNNING' && rows === 'one')
      throw new TypeError('RUNNING is not allowed with ONE ROW PER MATCH.');
    if (
      value.expression.kind !== 'navigation' &&
      !(value.expression.kind === 'function' && value.phase === 'aggregate')
    )
      throw new TypeError(`${mode} applies to navigation and aggregate functions.`);
    return expression<unknown>(
      { kind: 'semantics', mode, value: value.expression },
      value.readSchema,
      {
        dataType: value.dataType,
        valueSchema: value.valueSchema,
        refs: [...value.refs, measureRef],
        nullRefs: value.nullRefs,
        phase: value.phase,
        ...(value.wireType ? { wireType: value.wireType } : {}),
        encode: (parsed) => value.encode(parsed),
      },
    );
  }
  const names = new Map(variables.map((variable) => [variable.toUpperCase(), variable]));

  const orderBy = options.orderBy?.(row as never) ?? [];
  if (
    orderBy.some(
      (item) => item.value.phase !== 'scalar' || item.value.refs.some((ref) => ref !== rowRef),
    )
  )
    throw new TypeError('MATCH_RECOGNIZE ORDER BY accepts only scalar row expressions.');

  const defined = Object.entries(
    options.define?.(
      Object.freeze({
        row,
        lag: shift('LAG', false),
        lead: shift('LEAD', false),
        next: shift('NEXT', false),
        last: edge('LAST', false),
      }) as never,
    ) ?? {},
  );
  for (const [variable, predicate] of defined) {
    if (!variableRefs.has(variable))
      throw new TypeError(`DEFINE names a variable missing from the pattern: ${variable}`);
    assertPredicate(predicate, 'DEFINE');
    if (predicate.phase !== 'scalar' || predicate.refs.some((ref) => ref !== rowRef))
      throw new TypeError('DEFINE accepts only row columns with LAG, LEAD, NEXT, or LAST.');
  }

  const measureEntries = Object.entries(
    options.measures?.(
      Object.freeze({
        row,
        vars,
        lag: shift('LAG', true),
        lead: shift('LEAD', true),
        prev: shift('PREV', true),
        next: shift('NEXT', true),
        first: edge('FIRST', true),
        last: edge('LAST', true),
        final: (value: AnyExpression) => semantics('FINAL', value),
        running: (value: AnyExpression) => semantics('RUNNING', value),
        count(variable?: string) {
          if (variable === undefined) return counter('COUNT', [rowRef, measureRef]);
          const ref = variableRefs.get(variable);
          if (!ref) throw new TypeError(`Unknown pattern variable: ${variable}`);
          return counter(
            'COUNT',
            [ref, measureRef],
            [{ kind: 'star', qualifier: identifier(variable.toUpperCase()) }],
          );
        },
        matchNumber: () => counter('MATCH_NUMBER', [measureRef]),
        matchSequenceNumber: () => counter('MATCH_SEQUENCE_NUMBER', [measureRef]),
        classifier: () =>
          expression<string>(
            { kind: 'function', name: 'CLASSIFIER', args: Object.freeze([]) },
            z.string().transform((value, context) => {
              const variable = names.get(value);
              if (variable === undefined) {
                context.addIssue({ code: 'custom', message: `Unknown pattern variable: ${value}` });
                return z.NEVER;
              }
              return variable;
            }),
            {
              dataType: 'text',
              valueSchema: z.enum(variables as [string, ...string[]]),
              refs: [measureRef],
              nullRefs: [],
              encode: (parsed) => scalarParameter(parsed.toUpperCase()),
            },
          ),
      }) as never,
    ) ?? {},
  );
  const available = new Set<SourceReference>([rowRef, measureRef, ...variableRefs.values()]);
  for (const [, value] of measureEntries) {
    if (value.phase === 'window' || value.refs.some((ref) => !available.has(ref)))
      throw new TypeError(
        'MEASURES accept only this MATCH_RECOGNIZE row, variables, and functions.',
      );
  }

  const partitionBy = options.partitionBy ?? [];
  const taken = new Set<string>();
  for (const key of partitionBy) {
    if (!Object.hasOwn(source.columns, key))
      throw new TypeError(`Unknown partition column: ${key}`);
    assertNotType(source.columns[key] as AnyColumn, spatialTypes, 'PARTITION BY');
    claim(taken, key, 'partition');
  }
  if (rows === 'one' && !partitionBy.length && !measureEntries.length)
    throw new TypeError('ONE ROW PER MATCH needs partitionBy or measures.');
  const base = rows === 'one' ? partitionBy : entries.map(([key]) => key);
  if (rows !== 'one') for (const key of base) taken.add(key);
  for (const [key] of measureEntries) claim(taken, key, 'measure');

  const nullable = rows === 'all-with-unmatched' || (rows !== 'all-omit-empty' && shape.empty);
  const columns = Object.fromEntries([
    ...base.map((key) => [key, renamed(key, source.columns[key] as AnyColumn)]),
    ...measureEntries.map(([key, value]) => [key, measured(key, value, nullable)]),
  ]);
  const skip = options.afterMatch;
  let afterMatch: MatchRecognizeNode['afterMatch'];
  if (skip === 'past-last-row' || skip === 'to-next-row') afterMatch = { kind: skip };
  else if (skip !== undefined) {
    const first = 'toFirst' in skip;
    const variable = first ? skip.toFirst : (skip as { toLast: string }).toLast;
    if (!variableRefs.has(variable))
      throw new TypeError(
        `AFTER MATCH SKIP names a variable missing from the pattern: ${variable}`,
      );
    if (reserved.has(variable.toUpperCase()))
      throw new TypeError(`AFTER MATCH SKIP cannot target a reserved word: ${variable}`);
    afterMatch = { kind: first ? 'to-first' : 'to-last', variable };
  }
  const relation: MatchRecognizeNode = Object.freeze({
    kind: 'match-recognize',
    source: input,
    partitionBy: Object.freeze(partitionBy.map((key) => identifier(key))),
    orderBy: Object.freeze(orderBy.map((item) => item.ast)),
    measures: Object.freeze(
      measureEntries.map(([key, value]) =>
        Object.freeze({ value: value.expression, alias: identifier(key) }),
      ),
    ),
    rowsPerMatch: rows,
    ...(afterMatch ? { afterMatch: Object.freeze(afterMatch) } : {}),
    pattern: shape.node,
    define: Object.freeze(
      defined.length
        ? defined.map(([variable, predicate]) =>
            Object.freeze({ variable, predicate: predicate.expression }),
          )
        : [{ variable: variables[0] as string, predicate: scalarParameter(true) }],
    ),
    alias: identifier(name),
    columns: Object.freeze(Object.keys(columns).map((key) => identifier(key))),
  });
  return bindTable(identifier(name), columns, relation, name);
}
