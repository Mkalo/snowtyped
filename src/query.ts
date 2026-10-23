import * as z from 'zod';
import {
  type CompiledQuery,
  compileAst,
  type ExpressionNode,
  identifier,
  type JoinNode,
  type SelectNode,
  type SourceReference,
} from './ast.js';
import {
  type AnyExpression,
  type Expression,
  type ExpressionScope,
  expression,
  type InferExpression,
  type Ordering,
  type Predicate,
  scalarParameter,
} from './expressions.js';
import {
  type AnyColumn,
  bindTable,
  type Column,
  type ColumnMap,
  type InferSelection,
  type Selection,
  type Table,
} from './schema.js';

export type ScopedSelection<S extends string> = Readonly<
  Record<string, Expression<unknown, S, string>>
>;
export type DerivedColumns<S extends Selection, N extends string, Nullable extends string> = {
  [K in keyof S]: Column<InferSelection<S, Nullable>[K], true, N>;
};
type TableName<T> = T extends Table<ColumnMap, infer N> ? N : never;
interface Uncorrelated {
  readonly outerScopeType?: never;
}
/** Outer names the enclosing sources a correlated subquery may reference. */
export interface SelectQuery<
  S extends Selection,
  Scope extends string = string,
  Nullable extends string = never,
  Outer extends string = never,
> {
  readonly kind: 'select';
  readonly ast: SelectNode;
  readonly selection: S;
  readonly nullableSources: ReadonlySet<symbol>;
  readonly outerSources: readonly SourceReference[];
  readonly sourceScopeType?: Scope;
  readonly nullableScopeType?: Nullable;
  readonly outerScopeType?: Outer;
  where(predicate: Predicate<Scope | Outer>): SelectQuery<S, Scope, Nullable, Outer>;
  select<const Next extends ScopedSelection<Scope | Outer>>(
    selection: Next,
  ): SelectQuery<Next, Scope, Nullable, Outer>;
  correlate<const T extends readonly [Table, ...Table[]]>(
    ...tables: T
  ): SelectQuery<S, Scope, Nullable, Outer | TableName<T[number]>>;
  innerJoin<C extends ColumnMap, N extends string>(
    table: Table<C, N>,
    on: Predicate<Scope | N | Outer>,
  ): SelectQuery<S, Scope | N, Nullable, Outer>;
  leftJoin<C extends ColumnMap, N extends string>(
    table: Table<C, N>,
    on: Predicate<Scope | N | Outer>,
  ): SelectQuery<S, Scope | N, Nullable | N, Outer>;
  rightJoin<C extends ColumnMap, N extends string>(
    table: Table<C, N>,
    on: Predicate<Scope | N | Outer>,
  ): SelectQuery<S, Scope | N, Nullable | Scope, Outer>;
  fullJoin<C extends ColumnMap, N extends string>(
    table: Table<C, N>,
    on: Predicate<Scope | N | Outer>,
  ): SelectQuery<S, Scope | N, Nullable | Scope | N, Outer>;
  crossJoin<C extends ColumnMap, N extends string>(
    table: Table<C, N>,
  ): SelectQuery<S, Scope | N, Nullable, Outer>;
  lateralJoin<C extends ColumnMap, N extends string>(
    table: Table<C, N>,
  ): SelectQuery<S, Scope | N, Nullable, Outer>;
  asofJoin<C extends ColumnMap, N extends string>(
    table: Table<C, N>,
    match: Predicate<Scope | N | Outer>,
    on?: Predicate<Scope | N | Outer>,
  ): SelectQuery<S, Scope | N, Nullable | N, Outer>;
  groupBy(
    ...values: readonly Expression<unknown, Scope | Outer, string>[]
  ): SelectQuery<S, Scope, Nullable, Outer>;
  having(predicate: Predicate<Scope | Outer>): SelectQuery<S, Scope, Nullable, Outer>;
  qualify(predicate: Predicate<Scope | Outer>): SelectQuery<S, Scope, Nullable, Outer>;
  orderBy(...values: readonly Ordering<Scope | Outer>[]): SelectQuery<S, Scope, Nullable, Outer>;
  distinct(): SelectQuery<S, Scope, Nullable, Outer>;
  limit(value: number): SelectQuery<S, Scope, Nullable, Outer>;
  offset(value: number): SelectQuery<S, Scope, Nullable, Outer>;
  as<const N extends string>(this: Uncorrelated, name: N): Table<DerivedColumns<S, N, Nullable>, N>;
  asCte<const N extends string>(
    this: Uncorrelated,
    name: N,
  ): Table<DerivedColumns<S, N, Nullable>, N>;
  compile(this: Uncorrelated): CompiledQuery;
}

interface State {
  readonly ast: SelectNode;
  readonly selection: Selection;
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
function validateSelection(selection: Selection): readonly AnyExpression[] {
  const entries = Object.entries(selection);
  if (!entries.length) throw new TypeError('A query needs at least one projected column.');
  for (const [key] of entries) {
    identifier(key);
    if (key === '__proto__') throw new TypeError('Reserved projection alias.');
  }
  return Object.values(selection);
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

const states = new WeakMap<object, State>();
function checkedAst(state: State): SelectNode {
  if (state.ast.qualify && !state.hasWindow && !state.qualifyWindow)
    throw new TypeError('QUALIFY requires a window function.');
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
    return build({ ...state, ...patch, ast: Object.freeze({ ...state.ast, ...ast }) });
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
    scoped([...(on ? [on] : []), ...(match ? [match] : [])], [table.ref]);
    if (table.dependencies.some((ref) => !refs.some((availableRef) => availableRef.id === ref.id)))
      throw new TypeError('Lateral input must refer to a preceding source.');
    if (on?.phase !== undefined && on.phase !== 'scalar')
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
    if (key === 'where' && value.phase !== 'scalar')
      throw new TypeError('WHERE requires scalar expressions; use HAVING or QUALIFY.');
    if (key === 'having' && value.phase === 'window')
      throw new TypeError('HAVING cannot contain window expressions.');
    return next(key === 'qualify' ? { qualifyWindow: value.phase === 'window' } : {}, {
      [key]: value.expression,
    });
  }
  function derive(name: string, cte: boolean) {
    const ast = uncorrelated();
    const node = identifier(name);
    const columns = Object.fromEntries(
      Object.entries(state.selection).map(([key, value]) => {
        // A derived column reads wire values, not already-decoded application values.
        const read = value.nullRefs.some((ref) => state.nullable.has(ref.id))
          ? value.readSchema.nullable()
          : value.readSchema;
        const col: AnyColumn = Object.freeze({
          ...value,
          node: identifier(key),
          dataType: 'text',
          required: true,
          readSchema: read,
          valueSchema: value.nullRefs.some((ref) => state.nullable.has(ref.id))
            ? value.valueSchema.nullable()
            : value.valueSchema,
          notNull() {
            return this as Column<unknown, true>;
          },
        });
        return [key, col];
      }),
    );
    return bindTable(
      node,
      columns,
      Object.freeze(
        cte
          ? { kind: 'cte', name: node, query: ast }
          : { kind: 'derived', alias: node, query: ast },
      ),
      name,
    );
  }
  const query = Object.freeze({
    kind: 'select',
    ast: state.ast,
    selection: state.selection,
    nullableSources: state.nullable,
    outerSources: Object.freeze(outerRefs),
    where: (value: Predicate) => predicateClause('where', value),
    having: (value: Predicate) => predicateClause('having', value),
    qualify: (value: Predicate) => predicateClause('qualify', value),
    select(selection: Selection) {
      scoped(validateSelection(selection));
      const snapshot = Object.freeze({ ...selection });
      return next(
        {
          selection: snapshot,
          hasWindow: Object.values(snapshot).some((value) => value.phase === 'window'),
        },
        { projections: projections(snapshot) },
      );
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
      return next({}, { groupBy: Object.freeze(values.map((value) => value.expression)) });
    },
    orderBy(...values: Ordering[]) {
      scoped(values.map((value) => value.value));
      return next({}, { orderBy: Object.freeze(values.map((value) => value.ast)) });
    },
    distinct: () => next({}, { distinct: true }),
    limit(value: number) {
      if (!Number.isSafeInteger(value) || value < 0)
        throw new TypeError('LIMIT must be a nonnegative safe integer.');
      return next({}, { limit: value });
    },
    offset(value: number) {
      if (!Number.isSafeInteger(value) || value < 0)
        throw new TypeError('OFFSET must be a nonnegative safe integer.');
      return next({}, { offset: value });
    },
    as: (name: string) => derive(name, false),
    asCte: (name: string) => derive(name, true),
    compile: () => compileAst(uncorrelated()),
  });
  states.set(query, state);
  return query as unknown as SelectQuery<S, Scope, Nullable>;
}

export function select<C extends ColumnMap, N extends string>(
  table: Table<C, N>,
): SelectQuery<C, N>;
export function select<
  C extends ColumnMap,
  N extends string,
  const S extends ScopedSelection<NoInfer<N>>,
>(table: Table<C, N>, selection: S): SelectQuery<S, N>;
export function select(table: Table, selection: Selection = table.columns): SelectQuery<Selection> {
  assertScope(validateSelection(selection), [table.ref]);
  const snapshot = Object.freeze({ ...selection });
  return build({
    selection: snapshot,
    tables: Object.freeze([table]),
    outer: Object.freeze([]),
    nullable: new Set(),
    hasWindow: Object.values(snapshot).some((value) => value.phase === 'window'),
    qualifyWindow: false,
    ast: Object.freeze({
      kind: 'select',
      from: table.source,
      projections: projections(snapshot),
      ...(table.source.kind === 'cte' ? { with: Object.freeze([table.source]) } : {}),
    }),
  });
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
type ComparableColumn<V, S extends Selection, N extends string> = [
  NonNullable<InferSelection<S, N>[keyof S]>,
] extends [NonNullable<V>]
  ? unknown
  : { readonly __subquery: 'project a column comparable with the operand' };
type AnySelectQuery = SelectQuery<Selection, string, string, string>;

function subquery(query: AnySelectQuery, single: boolean) {
  const state = states.get(query);
  if (!state) throw new TypeError('Subqueries require a query built by select().');
  const ast = checkedAst(state);
  if (single && ast.projections.length !== 1)
    throw new TypeError('Scalar and IN subqueries must project exactly one column.');
  const correlated = query.outerSources;
  if (correlated.length && (ast.limit !== undefined || ast.offset !== undefined))
    throw new TypeError('Snowflake rejects LIMIT and OFFSET in correlated subqueries.');
  return { state, ast, correlated };
}
function existence<Outer extends string>(
  query: AnySelectQuery,
  negate: boolean,
): Expression<boolean, Outer, never> {
  const { ast, correlated } = subquery(query, false);
  return expression({ kind: 'exists', query: ast, correlated, negate }, z.boolean(), {
    refs: correlated,
    nullRefs: [],
  });
}
export function exists<
  S extends Selection,
  Scope extends string,
  Nullable extends string,
  Outer extends string,
>(query: SelectQuery<S, Scope, Nullable, Outer>): Expression<boolean, Outer, never> {
  return existence(query, false);
}
export function notExists<
  S extends Selection,
  Scope extends string,
  Nullable extends string,
  Outer extends string,
>(query: SelectQuery<S, Scope, Nullable, Outer>): Expression<boolean, Outer, never> {
  return existence(query, true);
}
/**
 * An empty result reads as NULL. Snowflake rejects uncorrelated subqueries returning several
 * rows at execution, and only correlates scalar subqueries that are ungrouped aggregates.
 */
export function scalar<
  S extends Selection,
  Scope extends string,
  Nullable extends string,
  Outer extends string,
>(
  query: SelectQuery<S, Scope, Nullable, Outer> & SingleColumn<S>,
): Expression<InferSelection<S, Nullable>[keyof S] | null, Outer> {
  const { state, ast, correlated } = subquery(query, true);
  const value = Object.values(state.selection)[0] as AnyExpression;
  if (correlated.length && (value.phase !== 'aggregate' || ast.groupBy?.length))
    throw new TypeError('A correlated scalar subquery must project an aggregate without GROUP BY.');
  const node: ExpressionNode = { kind: 'subquery', query: ast, correlated };
  return expression(node, value.readSchema.nullable(), {
    valueSchema: value.valueSchema.nullable(),
    refs: correlated,
    ...(value.wireType ? { wireType: value.wireType } : {}),
    encode: (item) => (item === null ? scalarParameter(null) : value.encode(item)),
  }) as Expression<InferSelection<S, Nullable>[keyof S] | null, Outer>;
}
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
    ComparableColumn<InferExpression<E>, S, Nullable>,
  negate = false,
): Predicate<ExpressionScope<E> | Outer> {
  const { ast, correlated } = subquery(query, true);
  return expression(
    { kind: 'in-subquery', operand: value.expression, query: ast, correlated, negate },
    z.boolean().nullable(),
    { refs: [...new Set([...value.refs, ...correlated])], phase: value.phase },
  );
}
