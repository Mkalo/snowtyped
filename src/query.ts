import * as z from 'zod';
import {
  type CompiledQuery,
  type CteNode,
  compileAst,
  type ExpressionNode,
  identifier,
  type JoinNode,
  type QueryNode,
  quoteIdentifier,
  type SelectNode,
  type SelfReferenceNode,
  type SetOperationNode,
  type SetOperator,
  type SourceReference,
} from './ast.js';
import {
  type AnyExpression,
  assertComparable,
  assertNotType,
  assertPredicate,
  type ComparableType,
  type Expression,
  type ExpressionDataType,
  type ExpressionScope,
  expression,
  type InferExpression,
  type KeyType,
  type Ordering,
  type Predicate,
  scalarParameter,
  spatialTypes,
} from './expressions.js';
import {
  type AnyColumn,
  bindColumn,
  bindTable,
  type Column,
  type ColumnMap,
  type DataType,
  type InferSelection,
  isLeaf,
  type Projection,
  projectionLeaves,
  type Selection,
  type Table,
} from './schema.js';

export type ScopedSelection<S extends string> = {
  readonly [key: string]: Expression<unknown, S, string> | ScopedSelection<S>;
};
export type DerivedColumns<S extends Projection, N extends string, Nullable extends string> = {
  [K in keyof S]: Column<InferSelection<S, Nullable>[K], true, N, 'none', ExpressionDataType<S[K]>>;
};
type TableName<T> = T extends Table<ColumnMap, infer N> ? N : never;
interface Uncorrelated {
  readonly outerScopeType?: never;
}
/** Only flat projections compose into SQL; nested objects are rebuilt when rows are decoded. */
interface Flat {
  /** The flat projection, keyed by output alias. */
  readonly selection: Selection;
}
type Present<T> = unknown extends T ? T : Exclude<T, null>;
type SetMismatch<L, R> =
  | Exclude<keyof L, keyof R>
  | Exclude<keyof R, keyof L>
  | {
      [K in keyof L & keyof R]: [Present<R[K]>] extends [Present<L[K]>]
        ? never
        : [Present<L[K]>] extends [Present<R[K]>]
          ? never
          : K;
    }[keyof L & keyof R];
type TypeMismatch<L, R> = {
  [K in keyof L & keyof R]: DataType extends L[K] | R[K]
    ? never
    : [L[K]] extends [R[K]]
      ? [R[K]] extends [L[K]]
        ? never
        : K
      : K;
}[keyof L & keyof R];
/**
 * A query that can be combined with a set operation: a {@link SelectQuery} or a {@link SetQuery}
 * with a flat projection.
 */
export interface SetOperand extends Flat {
  /** Whether the operand is a single SELECT or already a combined query. */
  readonly kind: 'select' | 'set';
  /** @internal */
  readonly rowType?: object;
  /** @internal */
  readonly sqlTypes?: object;
}
/**
 * The row type of a query or table, without executing anything: the type of each element of
 * `rows` when it is executed. Accepts a {@link SelectQuery}, a {@link SetQuery}, a
 * {@link LoadedQuery}, or a table, whose row has every declared column.
 *
 * Columns of outer-joined sources are nullable, as when the query is executed.
 *
 * @example
 * ```ts
 * const query = select(customers, { id: customers.columns.id, email: customers.columns.email });
 * type Row = InferRow<typeof query>;
 * // { readonly id: bigint; readonly email: string | null }
 * type Customer = InferRow<typeof customers>;
 * // { readonly id: bigint; readonly name: string; readonly email: string | null }
 * ```
 */
export type InferRow<T> = T extends {
  readonly kind: 'select' | 'set' | 'loaded';
  readonly rowType?: infer Row;
}
  ? Exclude<Row, undefined>
  : T extends Table<infer C extends ColumnMap>
    ? InferSelection<C>
    : never;
/** The row type of a set operand. */
export type OperandRow<Q> = Q extends { readonly rowType?: infer R } ? R : never;
export type OperandTypes<Q> = Q extends { readonly sqlTypes?: infer T } ? T : never;
export type SelectionTypes<S extends Projection> = { [K in keyof S]: ExpressionDataType<S[K]> };
type ColumnType<T, K> = K extends keyof T ? (T[K] extends DataType ? T[K] : DataType) : DataType;
/**
 * Resolves to `unknown` when two set operands have the same aliases and SQL types. Otherwise it
 * requires an `incompatibleSetColumns` property naming the mismatched columns, which surfaces them
 * in the type error. Branches match by projection alias.
 */
export type CompatibleOperand<L, R, LT = object, RT = object> = [
  SetMismatch<L, R> | TypeMismatch<LT, RT>,
] extends [never]
  ? unknown
  : { readonly incompatibleSetColumns: SetMismatch<L, R> | TypeMismatch<LT, RT> };
/** The row type of a UNION: each column is nullable when it is nullable in either branch. */
export type UnionRow<L, R> = { [K in keyof L]: L[K] | R[K & keyof R] };
/**
 * The row type of an INTERSECT: each column is nullable only when it is nullable in both branches.
 */
export type IntersectRow<L, R> = {
  [K in keyof L]: null extends R[K & keyof R] ? L[K] : Present<L[K]>;
};
type RecursiveMismatch<Contract, R> =
  | Exclude<keyof Contract, keyof R>
  | Exclude<keyof R, keyof Contract>
  | {
      [K in keyof Contract & keyof R]: [Present<R[K]>] extends [Present<Contract[K]>] ? never : K;
    }[keyof Contract & keyof R];
type UndeclaredNull<Contract, R> = {
  [K in keyof Contract & keyof R]: null extends R[K]
    ? null extends Contract[K]
      ? never
      : K
    : never;
}[keyof Contract & keyof R];
/**
 * Resolves to `unknown` when a recursive CTE branch produces rows of the anchor's contract.
 * Otherwise it requires a property naming the mismatched columns, or the columns that can be NULL
 * without being declared in `nullable`.
 */
export type RecursiveOperand<Contract, R, CT = object, RT = object> = ([
  RecursiveMismatch<Contract, R> | TypeMismatch<CT, RT>,
] extends [never]
  ? unknown
  : {
      readonly incompatibleRecursiveColumns: RecursiveMismatch<Contract, R> | TypeMismatch<CT, RT>;
    }) &
  ([UndeclaredNull<Contract, R>] extends [never]
    ? unknown
    : { readonly undeclaredNullableColumns: UndeclaredNull<Contract, R> });
/**
 * The row type of a recursive CTE: the anchor's row with the declared `nullable` columns widened.
 */
export type RecursiveRow<Row, Nullable extends PropertyKey = never> = {
  [K in keyof Row]: K extends Nullable ? Row[K] | null : Row[K];
};
/**
 * Resolves to `unknown` for uppercase names, which Snowflake treats as recursive CTE names, and to
 * a type error otherwise.
 */
export type RecursiveName<N extends string> =
  N extends Uppercase<N> ? unknown : { readonly recursiveCteNamesMustBeUppercase: N };
/** The source name of the columns of a combined query, which order it. */
export type SetScope = '__sflib_result';
/** The columns of a combined query or recursive CTE, typed from its row. */
export type SetColumns<Row, N extends string = SetScope, Types = object> = {
  [K in keyof Row]: Column<Row[K], true, N, 'none', ColumnType<Types, K>>;
};
interface SetOperations<Row, Types> {
  /**
   * Combines with another query using `UNION`, removing duplicate rows.
   *
   * Both queries need the same projection aliases and SQL types. Columns are aligned by alias, not
   * position, and are nullable when either branch is.
   *
   * @example
   * ```ts
   * const ids = select(customers, { id: customers.columns.id }).union(
   *   select(orders, { id: orders.columns.customerId }),
   * );
   * ```
   */
  union<Q extends SetOperand>(
    this: Flat,
    other: Q & CompatibleOperand<Row, OperandRow<Q>, Types, OperandTypes<Q>>,
  ): SetQuery<UnionRow<Row, OperandRow<Q>>, Types>;
  /**
   * Combines with another query using `UNION ALL`, keeping duplicate rows. Accepts the same
   * operands as `union`.
   */
  unionAll<Q extends SetOperand>(
    this: Flat,
    other: Q & CompatibleOperand<Row, OperandRow<Q>, Types, OperandTypes<Q>>,
  ): SetQuery<UnionRow<Row, OperandRow<Q>>, Types>;
  /**
   * Keeps the rows both queries return, using `INTERSECT`. Columns are nullable only when both
   * branches are.
   */
  intersect<Q extends SetOperand>(
    this: Flat,
    other: Q & CompatibleOperand<Row, OperandRow<Q>, Types, OperandTypes<Q>>,
  ): SetQuery<IntersectRow<Row, OperandRow<Q>>, Types>;
  /**
   * Keeps the rows this query returns and the other does not, using `EXCEPT`. Column types follow
   * this query.
   */
  except<Q extends SetOperand>(
    this: Flat,
    other: Q & CompatibleOperand<Row, OperandRow<Q>, Types, OperandTypes<Q>>,
  ): SetQuery<Row, Types>;
}
/**
 * Queries combined with `.union()`, `.unionAll()`, `.intersect()`, or `.except()`.
 *
 * Every operand is parenthesized, and chained calls apply to the whole preceding query, so keyword
 * precedence never regroups it. Order and paginate the result with its own `columns`.
 */
export interface SetQuery<Row, Types = object> extends SetOperations<Row, Types> {
  /** Identifies a combined query. */
  readonly kind: 'set';
  /** The query's syntax tree. */
  readonly ast: SetOperationNode;
  /** The result columns, for `.orderBy()` on the combined query. */
  readonly columns: SetColumns<Row, SetScope, Types>;
  /** The result columns, keyed by projection alias. */
  readonly selection: SetColumns<Row, SetScope, Types>;
  /** @internal */
  readonly nullableSources: ReadonlySet<symbol>;
  /** @internal */
  readonly rowType?: Row;
  /** @internal */
  readonly sqlTypes?: Types;
  /**
   * Orders the combined rows by its own `columns`. Replaces any earlier ordering.
   *
   * @example
   * ```ts
   * const ids = select(customers, { id: customers.columns.id }).union(
   *   select(orders, { id: orders.columns.customerId }),
   * );
   * ids.orderBy(asc(ids.columns.id)).limit(10);
   * ```
   */
  orderBy(...values: readonly Ordering<SetScope>[]): SetQuery<Row, Types>;
  /** Returns at most `value` rows. */
  limit(value: number): SetQuery<Row, Types>;
  /** Skips the first `value` rows. */
  offset(value: number): SetQuery<Row, Types>;
  /** Turns the combined query into a derived table named `name`. */
  as<const N extends string>(name: N): Table<SetColumns<Row, N, Types>, N>;
  /**
   * Turns the combined query into a CTE named `name`. Selecting from or joining it adds the WITH
   * clause.
   */
  asCte<const N extends string>(name: N): Table<SetColumns<Row, N, Types>, N>;
  /** Compiles the query to SQL text and bind values without executing it. */
  compile(): CompiledQuery;
}
/**
 * An immutable SELECT query built by {@link select}.
 *
 * Every method returns a new query. Calling a clause such as `.where()` again replaces that clause.
 * Execute a query with a client from `snowtyped/snowflake`, or compile it with `.compile()`.
 *
 * @typeParam S - The projection, which determines the row type.
 * @typeParam Scope - Names of the sources in FROM and joins.
 * @typeParam Nullable - Sources an outer join can leave absent, whose columns read as nullable.
 * @typeParam Outer - Sources of an enclosing query that a correlated subquery may reference.
 * @example
 * ```ts
 * const query = select(customers, { id: customers.columns.id, email: customers.columns.email })
 *   .where(eq(customers.columns.name, 'Ada'))
 *   .orderBy(asc(customers.columns.id))
 *   .limit(10);
 * const { rows } = await db.execute(query);
 * ```
 */
export interface SelectQuery<
  S extends Projection,
  Scope extends string = string,
  Nullable extends string = never,
  Outer extends string = never,
> extends SetOperations<InferSelection<S, Nullable>, SelectionTypes<S>> {
  /** Identifies a single SELECT. */
  readonly kind: 'select';
  /** The query's syntax tree. `compileAst(query.ast)` equals `query.compile()`. */
  readonly ast: SelectNode;
  /** The projection. */
  readonly selection: S;
  /** @internal */
  readonly nullableSources: ReadonlySet<symbol>;
  /** The enclosing sources added with `.correlate()`. */
  readonly outerSources: readonly SourceReference[];
  /** @internal */
  readonly sourceScopeType?: Scope;
  /** @internal */
  readonly nullableScopeType?: Nullable;
  /** @internal */
  readonly outerScopeType?: Outer;
  /** @internal */
  readonly rowType?: InferSelection<S, Nullable>;
  /** @internal */
  readonly sqlTypes?: SelectionTypes<S>;
  /**
   * Filters rows with WHERE. The predicate cannot contain aggregates or windows; use `.having()` or
   * `.qualify()` for those.
   */
  where(predicate: Predicate<Scope | Outer>): SelectQuery<S, Scope, Nullable, Outer>;
  /**
   * Replaces the projection. Keys become the output aliases, and an entry can be a nested object of
   * further entries, which is rebuilt into an object when rows are decoded.
   *
   * Project joined columns with this method after joining, so they are in scope.
   */
  select<const Next extends ScopedSelection<Scope | Outer>>(
    selection: Next,
  ): SelectQuery<Next, Scope, Nullable, Outer>;
  /**
   * Lets the query reference sources of the immediately enclosing query, for use as a correlated
   * subquery in {@link exists}, {@link notExists}, {@link scalar}, or {@link inSubquery}.
   *
   * A correlated query cannot be executed, compiled, or turned into a derived table on its own.
   *
   * @example
   * ```ts
   * const hasOrders = exists(
   *   select(orders)
   *     .correlate(customers)
   *     .where(eq(orders.columns.customerId, customers.columns.id)),
   * );
   * select(customers).where(hasOrders);
   * ```
   */
  correlate<const T extends readonly [Table, ...Table[]]>(
    ...tables: T
  ): SelectQuery<S, Scope, Nullable, Outer | TableName<T[number]>>;
  /**
   * Adds an INNER JOIN. Joined sources need distinct names; use {@link alias} for repeated tables.
   *
   * @example
   * ```ts
   * select(orders)
   *   .innerJoin(customers, eq(orders.columns.customerId, customers.columns.id))
   *   .select({ id: orders.columns.id, customer: customers.columns.name });
   * ```
   */
  innerJoin<C extends ColumnMap, N extends string>(
    table: Table<C, N>,
    on: Predicate<Scope | N | Outer>,
  ): SelectQuery<S, Scope | N, Nullable, Outer>;
  /** Adds a LEFT JOIN. Columns of the joined table become nullable in the result. */
  leftJoin<C extends ColumnMap, N extends string>(
    table: Table<C, N>,
    on: Predicate<Scope | N | Outer>,
  ): SelectQuery<S, Scope | N, Nullable | N, Outer>;
  /** Adds a RIGHT JOIN. Columns of the sources joined so far become nullable in the result. */
  rightJoin<C extends ColumnMap, N extends string>(
    table: Table<C, N>,
    on: Predicate<Scope | N | Outer>,
  ): SelectQuery<S, Scope | N, Nullable | Scope, Outer>;
  /** Adds a FULL JOIN. Columns of every source become nullable in the result. */
  fullJoin<C extends ColumnMap, N extends string>(
    table: Table<C, N>,
    on: Predicate<Scope | N | Outer>,
  ): SelectQuery<S, Scope | N, Nullable | Scope | N, Outer>;
  /** Adds a CROSS JOIN. */
  crossJoin<C extends ColumnMap, N extends string>(
    table: Table<C, N>,
  ): SelectQuery<S, Scope | N, Nullable, Outer>;
  /**
   * Joins a {@link flatten} source laterally. Its input can only reference sources that precede it.
   */
  lateralJoin<C extends ColumnMap, N extends string>(
    table: Table<C, N>,
  ): SelectQuery<S, Scope | N, Nullable, Outer>;
  /**
   * Adds an ASOF JOIN, which matches each row with the closest row of `table` that satisfies
   * `match`.
   *
   * `match` must be an inequality comparison, and `on` optionally matches keys. Columns of the
   * joined table become nullable.
   *
   * @example
   * ```ts
   * select(trades)
   *   .asofJoin(quotes, gte(trades.columns.at, quotes.columns.at))
   *   .select({ id: trades.columns.id, price: quotes.columns.price });
   * ```
   */
  asofJoin<C extends ColumnMap, N extends string>(
    table: Table<C, N>,
    match: Predicate<Scope | N | Outer>,
    on?: Predicate<Scope | N | Outer>,
  ): SelectQuery<S, Scope | N, Nullable | N, Outer>;
  /**
   * Groups rows with GROUP BY. Projected and ordered values must then be grouping keys or
   * aggregates.
   *
   * Keys match structurally, so `groupBy(lower(name))` allows `lower(name)` but not `name`.
   * GEOGRAPHY and GEOMETRY values cannot be grouping keys.
   */
  groupBy(
    ...values: readonly Expression<unknown, Scope | Outer, string, KeyType>[]
  ): SelectQuery<S, Scope, Nullable, Outer>;
  /** Filters groups with HAVING. The predicate cannot contain window functions. */
  having(predicate: Predicate<Scope | Outer>): SelectQuery<S, Scope, Nullable, Outer>;
  /**
   * Filters rows on window function results with QUALIFY. The query must use a window function in
   * its projection or in the predicate.
   */
  qualify(predicate: Predicate<Scope | Outer>): SelectQuery<S, Scope, Nullable, Outer>;
  /**
   * Orders rows with ORDER BY, using {@link asc} and {@link desc}. Replaces any earlier ordering.
   */
  orderBy(...values: readonly Ordering<Scope | Outer>[]): SelectQuery<S, Scope, Nullable, Outer>;
  /** Removes duplicate rows with SELECT DISTINCT. Order expressions must then be projected. */
  distinct(): SelectQuery<S, Scope, Nullable, Outer>;
  /**
   * Returns at most `value` rows.
   *
   * @throws `TypeError` unless `value` is a nonnegative safe integer.
   */
  limit(value: number): SelectQuery<S, Scope, Nullable, Outer>;
  /**
   * Skips the first `value` rows.
   *
   * @throws `TypeError` unless `value` is a nonnegative safe integer.
   */
  offset(value: number): SelectQuery<S, Scope, Nullable, Outer>;
  /**
   * Turns the query into a derived table named `name`, whose `columns` keep their inferred types
   * and outer-join nullability.
   *
   * @example
   * ```ts
   * const big = select(orders, { id: orders.columns.id, amount: orders.columns.amount })
   *   .where(gt(orders.columns.amount, '1000'))
   *   .as('BIG');
   * select(big, { id: big.columns.id });
   * ```
   */
  as<const N extends string>(
    this: Uncorrelated & Flat,
    name: N,
  ): Table<DerivedColumns<S, N, Nullable>, N>;
  /**
   * Turns the query into a CTE named `name`. Selecting from or joining the result adds its WITH
   * definition automatically.
   */
  asCte<const N extends string>(
    this: Uncorrelated & Flat,
    name: N,
  ): Table<DerivedColumns<S, N, Nullable>, N>;
  /**
   * Compiles the query to SQL text and bind values without executing it.
   *
   * @example
   * ```ts
   * select(customers, { name: customers.columns.name }).compile();
   * // { sql: 'SELECT "NAME" AS "name" FROM "APP_DB"."PUBLIC"."CUSTOMERS"', binds: [] }
   * ```
   */
  compile(this: Uncorrelated): CompiledQuery;
}

interface State {
  readonly ast: SelectNode;
  /** Projected leaves; nested entries are aliased by their dotted path. */
  readonly selection: Selection;
  readonly projection?: Projection;
  readonly tables: readonly Table[];
  readonly outer: readonly Table[];
  readonly nullable: ReadonlySet<symbol>;
  readonly hasWindow: boolean;
  readonly qualifyWindow: boolean;
}

export function assertScope(
  values: readonly AnyExpression[],
  refs: readonly SourceReference[],
): void {
  const available = new Set(refs.map((ref) => ref.id));
  if (values.some((value) => value.refs.some((ref) => !available.has(ref.id))))
    throw new TypeError('Expression does not belong to the available table scope.');
}
/** Sources referenced by subqueries nested directly in an expression. */
function correlations(node: unknown): SourceReference[] {
  if (typeof node !== 'object' || node === null) return [];
  return Object.entries(node).flatMap(([key, value]) =>
    key === 'correlated'
      ? (value as SourceReference[])
      : key === 'query'
        ? []
        : correlations(value),
  );
}
export function derivedServerValue(): never {
  throw new TypeError('Server values can only be declared on base table columns.');
}
function validateProjection(projection: Projection, nested = false): void {
  const entries = Object.entries(projection);
  if (!entries.length)
    throw new TypeError(
      nested
        ? 'A nested projection needs at least one entry.'
        : 'A query needs at least one projected column.',
    );
  for (const [key, value] of entries) {
    identifier(key);
    if (key === '__proto__') throw new TypeError('Reserved projection alias.');
    if (typeof value !== 'object' || value === null)
      throw new TypeError('Projection entries must be expressions or nested objects.');
    if (!isLeaf(value)) validateProjection(value, true);
  }
}
/** Flattens nested entries to dotted aliases, keeping flat projections unchanged. */
function snapshot(projection: Projection): Projection {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(projection).map(([key, value]) => [
        key,
        isLeaf(value) ? value : snapshot(value),
      ]),
    ),
  );
}
function shape(input: Projection): Pick<State, 'selection' | 'projection'> {
  validateProjection(input);
  const projection = snapshot(input);
  const leaves = projectionLeaves(projection);
  if (leaves.every(([path]) => path.length === 1)) return { selection: projection as Selection };
  const selection: Record<string, AnyExpression> = {};
  for (const [path, value] of leaves) {
    const alias = path.join('.');
    identifier(alias);
    if (Object.hasOwn(selection, alias))
      throw new TypeError(`Nested projection path ${alias} repeats another projection alias.`);
    selection[alias] = value;
  }
  return { selection: Object.freeze(selection), projection };
}
function assertFlat(state: State): void {
  if (state.projection)
    throw new TypeError(
      'Nested projections are only decoded from results; a derived table, set operand, or subquery needs flat columns.',
    );
}
function children(node: ExpressionNode): readonly ExpressionNode[] {
  switch (node.kind) {
    case 'identifier':
    case 'reference':
    case 'parameter':
    case 'date-part':
      return [];
    case 'binary':
    case 'arithmetic':
      return [node.left, node.right];
    case 'case':
      return [
        ...node.branches.flatMap((branch) => [branch.when, branch.result]),
        ...(node.otherwise ? [node.otherwise] : []),
      ];
    case 'logical':
      return node.operands;
    case 'unary':
      return [node.operand];
    case 'function':
      return node.args;
    case 'in':
      return [node.operand, ...node.values];
    case 'window':
      // OVER's own function is not a group aggregate; only its inputs must be grouped values.
      return [
        ...node.value.args,
        ...node.partitionBy,
        ...node.orderBy.map((item) => item.expression),
      ];
    case 'subquery':
    case 'exists':
      // A subquery groups its own rows; its correlated columns are the outer query's inputs.
      return [];
    case 'in-subquery':
      return [node.operand];
    case 'json-path':
    case 'cast':
      return [node.value];
    default:
      throw new TypeError('Unsupported expression AST node.');
  }
}
function isAggregate(node: ExpressionNode): boolean {
  return node.kind === 'function' && node.role === 'aggregate';
}
function containsAggregate(node: ExpressionNode): boolean {
  return isAggregate(node) || children(node).some(containsAggregate);
}
function containsWindow(node: ExpressionNode): boolean {
  return node.kind === 'window' || children(node).some(containsWindow);
}
export function sameNode(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== 'object' || typeof right !== 'object' || !left || !right) return false;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) =>
      sameNode((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]),
    )
  );
}
function assertGrouped(
  node: ExpressionNode,
  keys: readonly ExpressionNode[],
  outer: ReadonlySet<symbol>,
): void {
  if (keys.some((key) => sameNode(key, node))) return;
  // Outer columns are constant within a correlated subquery.
  if (node.kind === 'reference' && outer.has(node.source.id)) return;
  if (node.kind === 'reference' || node.kind === 'identifier') {
    const name =
      node.kind === 'reference'
        ? `${quoteIdentifier(node.source.qualifier)}.${quoteIdentifier(node.column)}`
        : quoteIdentifier(node);
    throw new TypeError(`${name} must appear in GROUP BY or inside an aggregate function.`);
  }
  if (isAggregate(node)) {
    if (children(node).some(containsAggregate))
      throw new TypeError('Aggregate functions cannot be nested without OVER.');
    return;
  }
  for (const child of children(node)) assertGrouped(child, keys, outer);
}
/** Snowflake groups a query with GROUP BY or any aggregate outside a window function's own call. */
function assertGrouping(ast: SelectNode, outer: ReadonlySet<symbol>): void {
  const values = [
    ...ast.projections.map((item) => item.column),
    ...(ast.having ? [ast.having] : []),
    ...(ast.qualify ? [ast.qualify] : []),
  ];
  const orders = (ast.orderBy ?? []).map((item) => item.expression);
  if (!ast.groupBy?.length && ![...values, ...orders].some(containsAggregate)) return;
  for (const value of [...values, ...orders]) assertGrouped(value, ast.groupBy ?? [], outer);
  // Only the wire wrapper can order by a hidden alias; otherwise the window must be projected.
  if (
    !ast.projections.some((item) => item.wireType) &&
    orders.some(
      (order) =>
        containsWindow(order) && !ast.projections.some((item) => sameNode(item.column, order)),
    )
  )
    throw new TypeError('Grouped queries must project window functions used in ORDER BY.');
}
function projections(selection: Selection) {
  return Object.freeze(
    Object.entries(selection).map(([alias, value]) =>
      Object.freeze({
        column: value.expression,
        alias,
        ...(value.wireType ? { wireType: value.wireType } : {}),
      }),
    ),
  );
}

interface Output {
  readonly source: AnyExpression;
  readonly read: z.ZodType;
  readonly value: z.ZodType;
  readonly nullable: boolean;
}
interface Operand {
  readonly ast: QueryNode;
  readonly outputs: Readonly<Record<string, Output>>;
}
const operands = new WeakMap<object, () => Operand>();

function required(schema: z.ZodType): z.ZodType {
  return schema instanceof z.ZodNullable ? required(schema.unwrap() as z.ZodType) : schema;
}
/** Output domains read wire values, including nullability introduced by outer joins. */
function outputs(selection: Selection, nullable: ReadonlySet<symbol>): Record<string, Output> {
  return Object.fromEntries(
    Object.entries(selection).map(([key, value]) => [
      key,
      {
        source: value,
        read: required(value.readSchema),
        value: required(value.valueSchema),
        nullable:
          value.nullRefs.some((ref) => nullable.has(ref.id)) ||
          value.readSchema instanceof z.ZodNullable,
      },
    ]),
  );
}
function outputColumn(key: string, output: Output): AnyColumn {
  return Object.freeze({
    ...output.source,
    node: identifier(key),
    required: true,
    constraints: Object.freeze({}),
    encodeWrite: output.source.encode,
    readSchema: output.nullable ? output.read.nullable() : output.read,
    valueSchema: output.nullable ? output.value.nullable() : output.value,
    serverValue: null,
    notNull() {
      return this as Column<unknown, true>;
    },
    serverDefault: derivedServerValue,
    identity: derivedServerValue,
    virtual: derivedServerValue,
  });
}
function derivedTable(
  columns: Readonly<Record<string, Output>>,
  ast: QueryNode,
  name: string,
  cte: boolean,
) {
  const node = identifier(name);
  return bindTable(
    node,
    Object.fromEntries(
      Object.entries(columns).map(([key, value]) => [key, outputColumn(key, value)]),
    ),
    Object.freeze(
      cte ? { kind: 'cte', name: node, query: ast } : { kind: 'derived', alias: node, query: ast },
    ),
    name,
  );
}
function bound(clause: 'LIMIT' | 'OFFSET', value: number): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new TypeError(`${clause} must be a nonnegative safe integer.`);
  return value;
}
function reorder(node: QueryNode, keys: readonly string[]): QueryNode {
  if (node.kind === 'select')
    return Object.freeze({
      ...node,
      projections: Object.freeze(
        keys.map(
          (key) =>
            node.projections.find(
              (item) => item.alias === key,
            ) as SelectNode['projections'][number],
        ),
      ),
    });
  return Object.freeze({
    ...node,
    left: reorder(node.left, keys),
    right: reorder(node.right, keys),
    columns: Object.freeze(
      keys.map(
        (key) =>
          node.columns.find((item) => item.alias === key) as SetOperationNode['columns'][number],
      ),
    ),
  });
}
/** CTEs move to the statement's leading WITH; branches cannot redefine a name differently. */
function hoist(node: QueryNode, ctes: CteNode[]): QueryNode {
  for (const cte of node.with ?? []) {
    if (ctes.includes(cte)) continue;
    if (ctes.some((item) => quoteIdentifier(item.name) === quoteIdentifier(cte.name)))
      throw new TypeError('Set operation branches define different CTEs with the same name.');
    ctes.push(cte);
  }
  const { with: _, ...rest } = node;
  return Object.freeze(rest);
}
function resolveOperand(value: unknown, message: string): Operand {
  const resolve = typeof value === 'object' && value !== null ? operands.get(value) : undefined;
  if (!resolve) throw new TypeError(message);
  return resolve();
}
function combine(
  operator: SetOperator,
  left: Operand,
  other: unknown,
): SetQuery<Record<string, unknown>> {
  const right = resolveOperand(other, 'Set operations combine queries built by select().');
  const keys = Object.keys(left.outputs);
  if (
    Object.keys(right.outputs).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(right.outputs, key))
  )
    throw new TypeError('Set operation branches need the same projection aliases.');
  const union = operator === 'UNION' || operator === 'UNION ALL';
  const columns: Record<string, Output> = Object.fromEntries(
    keys.map((key) => {
      const l = left.outputs[key] as Output;
      const r = right.outputs[key] as Output;
      if (l.source.dataType !== r.source.dataType)
        throw new TypeError(
          `Set operation column ${key} combines different domains: ${l.source.dataType.toUpperCase()} and ${r.source.dataType.toUpperCase()}.`,
        );
      return [
        key,
        {
          source: l.source,
          read: union && l.read !== r.read ? z.union([l.read, r.read]) : l.read,
          value: union && l.value !== r.value ? z.union([l.value, r.value]) : l.value,
          nullable: union
            ? l.nullable || r.nullable
            : operator === 'INTERSECT'
              ? l.nullable && r.nullable
              : l.nullable,
        },
      ];
    }),
  );
  const ctes: CteNode[] = [];
  const ast: SetOperationNode = Object.freeze({
    kind: 'set-operation',
    operator,
    left: hoist(left.ast, ctes),
    right: hoist(reorder(right.ast, keys), ctes),
    columns: Object.freeze(
      keys.map((alias) => {
        const wireType = (columns[alias] as Output).source.wireType;
        return Object.freeze({ alias, ...(wireType ? { wireType } : {}) });
      }),
    ),
    ...(ctes.length ? { with: Object.freeze(ctes) } : {}),
  });
  return buildSet(ast, columns);
}
function buildSet(
  ast: SetOperationNode,
  columns: Readonly<Record<string, Output>>,
  ref: SourceReference = Object.freeze({
    id: Symbol('__sflib_result'),
    name: '__sflib_result',
    qualifier: identifier('__sflib_result'),
  }),
): SetQuery<Record<string, unknown>> {
  const operand: Operand = { ast, outputs: columns };
  const output = Object.freeze(
    Object.fromEntries(
      Object.entries(columns).map(([key, value]) => [
        key,
        bindColumn(outputColumn(key, value), ref),
      ]),
    ),
  );
  function next(patch: Partial<SetOperationNode>) {
    return buildSet(Object.freeze({ ...ast, ...patch }), columns, ref);
  }
  const query = Object.freeze({
    kind: 'set',
    ast,
    columns: output,
    selection: output,
    nullableSources: new Set<symbol>(),
    union: (other: unknown) => combine('UNION', operand, other),
    unionAll: (other: unknown) => combine('UNION ALL', operand, other),
    intersect: (other: unknown) => combine('INTERSECT', operand, other),
    except: (other: unknown) => combine('EXCEPT', operand, other),
    orderBy(...values: Ordering[]) {
      assertScope(
        values.map((value) => value.value),
        [ref],
      );
      if (values.some((value) => value.value.phase !== 'scalar'))
        throw new TypeError('Set operation ordering requires scalar expressions.');
      return next({ orderBy: Object.freeze(values.map((value) => value.ast)) });
    },
    limit: (value: number) => next({ limit: bound('LIMIT', value) }),
    offset: (value: number) => next({ offset: bound('OFFSET', value) }),
    as: (name: string) => derivedTable(columns, ast, name, false),
    asCte: (name: string) => derivedTable(columns, ast, name, true),
    compile: () => compileAst(ast),
  }) as unknown as SetQuery<Record<string, unknown>>;
  operands.set(query, () => operand);
  return query;
}

const states = new WeakMap<object, State>();
function checkedAst(state: State): SelectNode {
  if (state.ast.qualify && !state.hasWindow && !state.qualifyWindow)
    throw new TypeError('QUALIFY requires a window function.');
  assertGrouping(state.ast, new Set(state.outer.map((table) => table.ref.id)));
  return state.ast;
}

function build<S extends Selection, Scope extends string, Nullable extends string>(
  state: State,
): SelectQuery<S, Scope, Nullable> {
  const refs = state.tables.map((table) => table.ref);
  const outerRefs = state.outer.map((table) => table.ref);
  function scoped(values: readonly AnyExpression[], extra: readonly SourceReference[] = []) {
    assertScope(values, [...refs, ...outerRefs, ...extra]);
    const local = new Set([...refs, ...extra].map((ref) => ref.id));
    if (values.some((value) => correlations(value.expression).some((ref) => !local.has(ref.id))))
      throw new TypeError('A subquery can only correlate with its immediately enclosing query.');
  }
  function next(patch: Partial<State>, ast: Partial<SelectNode> = {}) {
    return build({
      ...state,
      ...patch,
      ast: Object.freeze({ ...state.ast, ...ast }),
    });
  }
  function uncorrelated() {
    if (state.outer.length)
      throw new TypeError('A correlated query can only be used as a subquery.');
    return checkedAst(state);
  }
  function join(kind: JoinNode['kind'], table: Table, on?: Predicate, match?: Predicate) {
    if (
      [...refs, ...outerRefs].some((ref) => ref.id === table.ref.id || ref.name === table.ref.name)
    )
      throw new TypeError('Join sources need distinct names; alias repeated tables.');
    if (table.source.kind === 'flatten' && kind !== 'LATERAL')
      throw new TypeError('FLATTEN must use lateralJoin.');
    if (kind === 'LATERAL' && table.source.kind !== 'flatten')
      throw new TypeError('lateralJoin requires FLATTEN.');
    const predicates = [...(on ? [on] : []), ...(match ? [match] : [])];
    scoped(predicates, [table.ref]);
    for (const value of predicates) assertPredicate(value, 'JOIN');
    if (table.dependencies.some((ref) => !refs.some((availableRef) => availableRef.id === ref.id)))
      throw new TypeError('Lateral input must refer to a preceding source.');
    if (predicates.some((value) => value.phase !== 'scalar'))
      throw new TypeError('Join predicates must be scalar.');
    if (
      match &&
      (match.expression.kind !== 'binary' ||
        !['<', '<=', '>', '>='].includes(match.expression.operator))
    )
      throw new TypeError('ASOF match requires an inequality comparison.');
    const nullable = new Set(state.nullable);
    if (kind === 'LEFT' || kind === 'FULL' || kind === 'ASOF') nullable.add(table.ref.id);
    if (kind === 'RIGHT' || kind === 'FULL')
      refs.forEach((ref) => {
        nullable.add(ref.id);
      });
    const node = Object.freeze({
      kind,
      source: table.source,
      ...(on ? { on: on.expression } : {}),
      ...(match ? { match: match.expression } : {}),
    });
    const ctes =
      table.source.kind === 'cte' ? [...(state.ast.with ?? []), table.source] : state.ast.with;
    return next(
      { tables: Object.freeze([...state.tables, table]), nullable },
      {
        joins: Object.freeze([...(state.ast.joins ?? []), node]),
        ...(ctes ? { with: Object.freeze(ctes) } : {}),
      },
    );
  }
  function predicateClause(key: 'where' | 'having' | 'qualify', value: Predicate) {
    scoped([value]);
    assertPredicate(value, key.toUpperCase());
    if (key === 'where' && value.phase !== 'scalar')
      throw new TypeError('WHERE requires scalar expressions; use HAVING or QUALIFY.');
    if (key === 'having' && value.phase === 'window')
      throw new TypeError('HAVING cannot contain window expressions.');
    return next(key === 'qualify' ? { qualifyWindow: value.phase === 'window' } : {}, {
      [key]: value.expression,
    });
  }
  const operand = (): Operand => {
    assertFlat(state);
    return { ast: uncorrelated(), outputs: outputs(state.selection, state.nullable) };
  };
  const query = Object.freeze({
    kind: 'select',
    ast: state.ast,
    selection: state.projection ?? state.selection,
    nullableSources: state.nullable,
    outerSources: Object.freeze(outerRefs),
    where: (value: Predicate) => predicateClause('where', value),
    having: (value: Predicate) => predicateClause('having', value),
    qualify: (value: Predicate) => predicateClause('qualify', value),
    select(projection: Projection) {
      const { selection, projection: nested } = shape(projection);
      scoped(Object.values(selection));
      const { projection: _, ...rest } = state;
      return build({
        ...rest,
        selection,
        ...(nested ? { projection: nested } : {}),
        hasWindow: Object.values(selection).some((value) => value.phase === 'window'),
        ast: Object.freeze({ ...state.ast, projections: projections(selection) }),
      });
    },
    correlate(...tables: Table[]) {
      if (!tables.length) throw new TypeError('correlate requires at least one source.');
      const names = [...refs, ...outerRefs, ...tables.map((table) => table.ref)].map(
        (ref) => ref.name,
      );
      if (new Set(names).size !== names.length)
        throw new TypeError('Correlated sources need distinct names; alias repeated tables.');
      return next({ outer: Object.freeze([...state.outer, ...tables]) });
    },
    innerJoin: (table: Table, on: Predicate) => join('INNER', table, on),
    leftJoin: (table: Table, on: Predicate) => join('LEFT', table, on),
    rightJoin: (table: Table, on: Predicate) => join('RIGHT', table, on),
    fullJoin: (table: Table, on: Predicate) => join('FULL', table, on),
    crossJoin: (table: Table) => join('CROSS', table),
    lateralJoin: (table: Table) => join('LATERAL', table),
    asofJoin: (table: Table, match: Predicate, on?: Predicate) => join('ASOF', table, on, match),
    groupBy(...values: AnyExpression[]) {
      scoped(values);
      if (values.some((value) => value.phase !== 'scalar'))
        throw new TypeError('GROUP BY requires scalar expressions.');
      for (const value of values) assertNotType(value, spatialTypes, 'GROUP BY');
      return next({}, { groupBy: Object.freeze(values.map((value) => value.expression)) });
    },
    orderBy(...values: Ordering[]) {
      scoped(values.map((value) => value.value));
      return next({}, { orderBy: Object.freeze(values.map((value) => value.ast)) });
    },
    distinct: () => next({}, { distinct: true }),
    limit: (value: number) => next({}, { limit: bound('LIMIT', value) }),
    offset: (value: number) => next({}, { offset: bound('OFFSET', value) }),
    union: (other: unknown) => combine('UNION', operand(), other),
    unionAll: (other: unknown) => combine('UNION ALL', operand(), other),
    intersect: (other: unknown) => combine('INTERSECT', operand(), other),
    except: (other: unknown) => combine('EXCEPT', operand(), other),
    as: (name: string) => derivedTable(operand().outputs, uncorrelated(), name, false),
    asCte: (name: string) => derivedTable(operand().outputs, uncorrelated(), name, true),
    compile: () => compileAst(uncorrelated()),
  });
  operands.set(query, operand);
  states.set(query, state);
  return query as unknown as SelectQuery<S, Scope, Nullable>;
}

/** Adds a predicate to the query's WHERE clause with AND. */
export function narrow<Q extends SelectQuery<Projection, string, string>>(
  query: Q,
  predicate: Predicate,
): Q {
  const previous = states.get(query)?.ast.where;
  const next = query.where(predicate);
  if (!previous) return next as Q;
  const state = states.get(next) as State;
  return build({
    ...state,
    ast: Object.freeze({
      ...state.ast,
      where: Object.freeze({
        kind: 'logical',
        operator: 'AND',
        operands: Object.freeze([previous as ExpressionNode, predicate.expression]),
      }),
    }),
  }) as unknown as Q;
}

/**
 * Starts a query that selects every declared column of `table`.
 *
 * @example
 * ```ts
 * const { rows } = await db.execute(select(customers));
 * ```
 */
export function select<C extends ColumnMap, N extends string>(
  table: Table<C, N>,
): SelectQuery<C, N>;
/**
 * Starts a query that selects `selection` from `table`. Keys become output aliases, and entries are
 * expressions of `table` or nested objects of them.
 *
 * @example
 * ```ts
 * select(customers, {
 *   id: customers.columns.id,
 *   contact: { name: customers.columns.name, email: customers.columns.email },
 * }).where(eq(customers.columns.name, 'Ada'));
 * ```
 */
export function select<
  C extends ColumnMap,
  N extends string,
  const S extends ScopedSelection<NoInfer<N>>,
>(table: Table<C, N>, selection: S): SelectQuery<S, N>;
export function select(
  table: Table,
  projection: Projection = table.columns,
): SelectQuery<Selection> {
  const { selection, projection: nested } = shape(projection);
  assertScope(Object.values(selection), [table.ref]);
  return build({
    selection,
    ...(nested ? { projection: nested } : {}),
    tables: Object.freeze([table]),
    outer: Object.freeze([]),
    nullable: new Set(),
    hasWindow: Object.values(selection).some((value) => value.phase === 'window'),
    qualifyWindow: false,
    ast: Object.freeze({
      kind: 'select',
      from: table.source,
      projections: projections(selection),
      ...(table.source.kind === 'cte' ? { with: Object.freeze([table.source]) } : {}),
    }),
  });
}

/** Collects self-references outside completed recursive CTEs, which validated their own. */
function selfReferences(value: unknown, found: SelfReferenceNode[] = []): SelfReferenceNode[] {
  if (typeof value !== 'object' || value === null) return found;
  const node = value as { readonly kind?: unknown; readonly self?: unknown };
  if (node.kind === 'self-reference') found.push(value as SelfReferenceNode);
  else if (node.kind !== 'cte' || !node.self)
    for (const item of Object.values(value)) selfReferences(item, found);
  return found;
}
function mentions(value: unknown, test: (node: object) => boolean): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (test(value) || Object.values(value).some((item) => mentions(item, test)))
  );
}

/**
 * Defines `WITH RECURSIVE name (...) AS (anchor UNION ALL recursive)`.
 *
 * The anchor's projection is the row contract. The callback receives `self`, the CTE being defined,
 * and returns the recursive branch, which must produce the same aliases and SQL types and reference
 * `self` exactly once in FROM or a join. Columns the branch can make NULL must be listed in
 * `nullable`. The result is a CTE table to select from, join, or combine.
 *
 * Recursion ends only when the branch returns no rows.
 *
 * @param name - An uppercase name; Snowflake treats only uppercase names as recursive.
 * @throws `TypeError` when the name is not uppercase or a branch breaks the rules above.
 * @example
 * ```ts
 * const chain = recursiveCte(
 *   'CHAIN',
 *   select(employees, { id: employees.columns.id, managerId: employees.columns.managerId }).where(
 *     isNull(employees.columns.managerId),
 *   ),
 *   (self) =>
 *     select(employees)
 *       .innerJoin(self, eq(employees.columns.managerId, self.columns.id))
 *       .select({ id: employees.columns.id, managerId: employees.columns.managerId }),
 * );
 * select(chain);
 * ```
 */
export function recursiveCte<
  const N extends string,
  A extends SetOperand,
  Q extends SetOperand,
  const Nullable extends keyof OperandRow<A> & string = never,
>(
  name: N & RecursiveName<N>,
  anchor: A,
  recursive: (
    self: Table<SetColumns<RecursiveRow<OperandRow<A>, Nullable>, N, OperandTypes<A>>, N>,
  ) => Q &
    RecursiveOperand<
      RecursiveRow<OperandRow<A>, Nullable>,
      OperandRow<Q>,
      OperandTypes<A>,
      OperandTypes<Q>
    >,
  options?: { readonly nullable?: readonly Nullable[] },
): Table<SetColumns<RecursiveRow<OperandRow<A>, Nullable>, N, OperandTypes<A>>, N>;
export function recursiveCte(
  name: string,
  anchor: unknown,
  recursive: (self: Table) => unknown,
  options: { readonly nullable?: readonly string[] } = {},
): Table {
  if (!/^[A-Z_][A-Z0-9_$]*$/.test(name))
    throw new TypeError(
      'Snowflake only recognizes recursive CTEs named with uppercase letters, digits, _ or $.',
    );
  const left = resolveOperand(anchor, 'A recursive CTE anchor must be built by select().');
  if (selfReferences(left.ast).length)
    throw new TypeError('A recursive CTE anchor cannot reference a recursive CTE being defined.');
  // Snowflake fails internally when an anchor reads another recursive CTE.
  if (
    mentions(
      left.ast,
      (item) => (item as CteNode).kind === 'cte' && Boolean((item as CteNode).self),
    )
  )
    throw new TypeError('A recursive CTE anchor cannot read another recursive CTE.');
  const nullable = new Set(options.nullable);
  for (const key of nullable)
    if (!Object.hasOwn(left.outputs, key))
      throw new TypeError(`Recursive CTE has no column ${key} to declare nullable.`);
  const contract: Record<string, Output> = Object.fromEntries(
    Object.entries(left.outputs).map(([key, output]) => [
      key,
      nullable.has(key) ? { ...output, nullable: true } : output,
    ]),
  );
  const node = identifier(name);
  const reference: SelfReferenceNode = Object.freeze({
    kind: 'self-reference',
    name: node,
    columns: Object.freeze(Object.keys(contract)),
  });
  const columns = Object.fromEntries(
    Object.entries(contract).map(([key, output]) => [key, outputColumn(key, output)]),
  );
  const self = bindTable(node, columns, reference, name);
  const branch = recursive(self);
  const right = resolveOperand(branch, 'A recursive branch must be built by select().');
  const ast = right.ast;
  if (ast.kind !== 'select') throw new TypeError('A recursive branch must be a single SELECT.');
  if (
    ast.distinct ||
    ast.groupBy ||
    ast.having ||
    ast.qualify ||
    ast.orderBy ||
    ast.limit !== undefined ||
    ast.offset !== undefined ||
    Object.values(right.outputs).some((output) => output.source.phase !== 'scalar')
  )
    throw new TypeError('A recursive branch supports only scalar projections, filters, and joins.');
  const found = selfReferences(ast);
  if (found.some((item) => item !== reference))
    throw new TypeError('A recursive branch can only reference its own CTE.');
  const position = [ast.from, ...(ast.joins ?? []).map((join) => join.source)].indexOf(reference);
  if (position < 0 || found.length !== 1)
    throw new TypeError(
      'A recursive branch must reference its CTE exactly once, directly in FROM or a join.',
    );
  let outer = false;
  (ast.joins ?? []).forEach((join, index) => {
    const at = index + 1;
    if (join.kind === 'ASOF') throw new TypeError('A recursive branch cannot use ASOF joins.');
    const outerJoin = join.kind === 'LEFT' || join.kind === 'RIGHT' || join.kind === 'FULL';
    // Snowflake fails internally on inner joins that follow an outer join here.
    if (outer && !outerJoin)
      throw new TypeError('Outer joins must follow every other join in a recursive branch.');
    outer = outerJoin;
    if (
      (join.kind === 'LEFT' && position === at) ||
      (join.kind === 'RIGHT' && position < at) ||
      (join.kind === 'FULL' && position <= at)
    )
      throw new TypeError('Outer joins must keep the recursive reference on the preserved side.');
    if (join.kind === 'LATERAL' && mentions(join.source, (item) => item === self.ref))
      throw new TypeError('FLATTEN cannot read the recursive reference.');
  });
  const query = combine('UNION ALL', left, branch).ast;
  for (const [key, output] of Object.entries(right.outputs))
    if (output.nullable && !(contract[key] as Output).nullable)
      throw new TypeError(`Recursive branch column ${key} can be NULL; declare it nullable.`);
  return bindTable(
    node,
    columns,
    Object.freeze({ kind: 'cte', name: node, query, self: reference }),
    name,
  );
}
type IsSingle<K, All = K> = [K] extends [never]
  ? false
  : K extends unknown
    ? [All] extends [K]
      ? true
      : false
    : never;
type SingleColumn<S> =
  true extends IsSingle<keyof S> ? unknown : { readonly __subquery: 'project exactly one column' };
type ComparableColumn<E extends AnyExpression, S extends Selection, N extends string> = [
  NonNullable<InferSelection<S, N>[keyof S]>,
] extends [NonNullable<InferExpression<E>>]
  ? [ExpressionDataType<S[keyof S]>] extends [ComparableType<ExpressionDataType<E>>]
    ? unknown
    : { readonly __subquery: 'project a column comparable with the operand' }
  : { readonly __subquery: 'project a column comparable with the operand' };
interface Subquery {
  readonly outerSources: readonly SourceReference[];
}

function subquery(query: Subquery, single: boolean) {
  const state = states.get(query);
  if (!state) throw new TypeError('Subqueries require a query built by select().');
  assertFlat(state);
  const ast = checkedAst(state);
  if (single && ast.projections.length !== 1)
    throw new TypeError('Scalar and IN subqueries must project exactly one column.');
  const correlated = query.outerSources;
  if (correlated.length && (ast.limit !== undefined || ast.offset !== undefined))
    throw new TypeError('Snowflake rejects LIMIT and OFFSET in correlated subqueries.');
  return { state, ast, correlated };
}
function existence<Outer extends string>(
  query: Subquery,
  negate: boolean,
): Expression<boolean, Outer, never, 'boolean'> {
  const { ast, correlated } = subquery(query, false);
  return expression({ kind: 'exists', query: ast, correlated, negate }, z.boolean(), {
    dataType: 'boolean',
    refs: correlated,
    nullRefs: [],
  });
}
/**
 * Tests whether a subquery returns any row, with `EXISTS (...)`.
 *
 * Use `.correlate(outer)` on the subquery to reference the enclosing query.
 */
export function exists<
  S extends Selection,
  Scope extends string,
  Nullable extends string,
  Outer extends string,
>(query: SelectQuery<S, Scope, Nullable, Outer>): Expression<boolean, Outer, never, 'boolean'> {
  return existence(query, false);
}
/** Tests whether a subquery returns no rows, with `NOT EXISTS (...)`. */
export function notExists<
  S extends Selection,
  Scope extends string,
  Nullable extends string,
  Outer extends string,
>(query: SelectQuery<S, Scope, Nullable, Outer>): Expression<boolean, Outer, never, 'boolean'> {
  return existence(query, true);
}
/**
 * Embeds a single-column query as a scalar subquery.
 *
 * The result keeps the column's SQL type and is always nullable, because an empty result reads as
 * NULL. Snowflake rejects an uncorrelated subquery that returns several rows at execution, and only
 * accepts correlated scalar subqueries that project an aggregate without GROUP BY.
 *
 * @example
 * ```ts
 * const orderCount = scalar(
 *   select(orders, { n: count() })
 *     .correlate(customers)
 *     .where(eq(orders.columns.customerId, customers.columns.id)),
 * );
 * select(customers, { id: customers.columns.id, orderCount });
 * ```
 */
export function scalar<
  S extends Selection,
  Scope extends string,
  Nullable extends string,
  Outer extends string,
>(
  query: SelectQuery<S, Scope, Nullable, Outer> & SingleColumn<S>,
): Expression<
  InferSelection<S, Nullable>[keyof S] | null,
  Outer,
  Outer,
  ExpressionDataType<S[keyof S]>
> {
  const { state, ast, correlated } = subquery(query, true);
  const value = Object.values(state.selection)[0] as AnyExpression;
  if (correlated.length && (value.phase !== 'aggregate' || ast.groupBy?.length))
    throw new TypeError('A correlated scalar subquery must project an aggregate without GROUP BY.');
  const node: ExpressionNode = { kind: 'subquery', query: ast, correlated };
  return expression(node, value.readSchema.nullable(), {
    dataType: value.dataType,
    valueSchema: value.valueSchema.nullable(),
    refs: correlated,
    ...(value.wireType ? { wireType: value.wireType } : {}),
    encode: (item) => (item === null ? scalarParameter(null) : value.encode(item)),
  }) as Expression<
    InferSelection<S, Nullable>[keyof S] | null,
    Outer,
    Outer,
    ExpressionDataType<S[keyof S]>
  >;
}
/**
 * Tests whether a value is among the rows of a single-column query, with `IN (...)`, or `NOT IN`
 * when `negate` is true. The column must be comparable with the value.
 */
export function inSubquery<
  E extends AnyExpression,
  S extends Selection,
  Scope extends string,
  Nullable extends string,
  Outer extends string,
>(
  value: E,
  query: SelectQuery<S, Scope, Nullable, Outer> &
    SingleColumn<S> &
    ComparableColumn<E, S, Nullable>,
  negate = false,
): Predicate<ExpressionScope<E> | Outer> {
  const { state, ast, correlated } = subquery(query, true);
  assertNotType(value, spatialTypes, 'IN');
  assertComparable(value, Object.values(state.selection)[0] as AnyExpression);
  return expression(
    { kind: 'in-subquery', operand: value.expression, query: ast, correlated, negate },
    z.boolean().nullable(),
    { dataType: 'boolean', refs: [...new Set([...value.refs, ...correlated])], phase: value.phase },
  );
}
