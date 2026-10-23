import {
  type CompiledQuery,
  compileAst,
  identifier,
  type JoinNode,
  type SelectNode,
  type SourceReference,
} from './ast.js';
import type { AnyExpression, Expression, Ordering, Predicate } from './expressions.js';
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
export interface SelectQuery<
  S extends Selection,
  Scope extends string = string,
  Nullable extends string = never,
> {
  readonly kind: 'select';
  readonly ast: SelectNode;
  readonly selection: S;
  readonly nullableSources: ReadonlySet<symbol>;
  readonly sourceScopeType?: Scope;
  readonly nullableScopeType?: Nullable;
  where(predicate: Predicate<Scope>): SelectQuery<S, Scope, Nullable>;
  select<const Next extends ScopedSelection<Scope>>(
    selection: Next,
  ): SelectQuery<Next, Scope, Nullable>;
  innerJoin<C extends ColumnMap, N extends string>(
    table: Table<C, N>,
    on: Predicate<Scope | N>,
  ): SelectQuery<S, Scope | N, Nullable>;
  leftJoin<C extends ColumnMap, N extends string>(
    table: Table<C, N>,
    on: Predicate<Scope | N>,
  ): SelectQuery<S, Scope | N, Nullable | N>;
  rightJoin<C extends ColumnMap, N extends string>(
    table: Table<C, N>,
    on: Predicate<Scope | N>,
  ): SelectQuery<S, Scope | N, Nullable | Scope>;
  fullJoin<C extends ColumnMap, N extends string>(
    table: Table<C, N>,
    on: Predicate<Scope | N>,
  ): SelectQuery<S, Scope | N, Nullable | Scope | N>;
  crossJoin<C extends ColumnMap, N extends string>(
    table: Table<C, N>,
  ): SelectQuery<S, Scope | N, Nullable>;
  lateralJoin<C extends ColumnMap, N extends string>(
    table: Table<C, N>,
  ): SelectQuery<S, Scope | N, Nullable>;
  asofJoin<C extends ColumnMap, N extends string>(
    table: Table<C, N>,
    match: Predicate<Scope | N>,
    on?: Predicate<Scope | N>,
  ): SelectQuery<S, Scope | N, Nullable | N>;
  groupBy(
    ...values: readonly Expression<unknown, Scope, string>[]
  ): SelectQuery<S, Scope, Nullable>;
  having(predicate: Predicate<Scope>): SelectQuery<S, Scope, Nullable>;
  qualify(predicate: Predicate<Scope>): SelectQuery<S, Scope, Nullable>;
  orderBy(...values: readonly Ordering<Scope>[]): SelectQuery<S, Scope, Nullable>;
  distinct(): SelectQuery<S, Scope, Nullable>;
  limit(value: number): SelectQuery<S, Scope, Nullable>;
  offset(value: number): SelectQuery<S, Scope, Nullable>;
  as<const N extends string>(name: N): Table<DerivedColumns<S, N, Nullable>, N>;
  asCte<const N extends string>(name: N): Table<DerivedColumns<S, N, Nullable>, N>;
  compile(): CompiledQuery;
}

interface State {
  readonly ast: SelectNode;
  readonly selection: Selection;
  readonly tables: readonly Table[];
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
function derivedServerValue(): never {
  throw new TypeError('Server values can only be declared on base table columns.');
}
function validateSelection(selection: Selection, tables: readonly Table[]): void {
  const entries = Object.entries(selection);
  if (!entries.length) throw new TypeError('A query needs at least one projected column.');
  for (const [key] of entries) {
    identifier(key);
    if (key === '__proto__') throw new TypeError('Reserved projection alias.');
  }
  assertScope(
    Object.values(selection),
    tables.map((table) => table.ref),
  );
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

function build<S extends Selection, Scope extends string, Nullable extends string>(
  state: State,
): SelectQuery<S, Scope, Nullable> {
  const refs = state.tables.map((table) => table.ref);
  function next(patch: Partial<State>, ast: Partial<SelectNode> = {}) {
    return build({ ...state, ...patch, ast: Object.freeze({ ...state.ast, ...ast }) });
  }
  function join(kind: JoinNode['kind'], table: Table, on?: Predicate, match?: Predicate) {
    if (refs.some((ref) => ref.id === table.ref.id || ref.name === table.ref.name))
      throw new TypeError('Join sources need distinct names; alias repeated tables.');
    if (table.source.kind === 'flatten' && kind !== 'LATERAL')
      throw new TypeError('FLATTEN must use lateralJoin.');
    if (kind === 'LATERAL' && table.source.kind !== 'flatten')
      throw new TypeError('lateralJoin requires FLATTEN.');
    const available = [...refs, table.ref];
    assertScope([...(on ? [on] : []), ...(match ? [match] : [])], available);
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
    assertScope([value], refs);
    if (key === 'where' && value.phase !== 'scalar')
      throw new TypeError('WHERE requires scalar expressions; use HAVING or QUALIFY.');
    if (key === 'having' && value.phase === 'window')
      throw new TypeError('HAVING cannot contain window expressions.');
    return next(key === 'qualify' ? { qualifyWindow: value.phase === 'window' } : {}, {
      [key]: value.expression,
    });
  }
  function derive(name: string, cte: boolean) {
    const ast = checkedAst();
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
          constraints: Object.freeze({}),
          encodeWrite: value.encode,
          readSchema: read,
          valueSchema: value.nullRefs.some((ref) => state.nullable.has(ref.id))
            ? value.valueSchema.nullable()
            : value.valueSchema,
          serverValue: null,
          notNull() {
            return this as Column<unknown, true>;
          },
          serverDefault: derivedServerValue,
          identity: derivedServerValue,
          virtual: derivedServerValue,
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
  function checkedAst(): SelectNode {
    if (state.ast.qualify && !state.hasWindow && !state.qualifyWindow)
      throw new TypeError('QUALIFY requires a window function.');
    return state.ast;
  }
  return Object.freeze({
    kind: 'select',
    ast: state.ast,
    selection: state.selection,
    nullableSources: state.nullable,
    where: (value: Predicate) => predicateClause('where', value),
    having: (value: Predicate) => predicateClause('having', value),
    qualify: (value: Predicate) => predicateClause('qualify', value),
    select(selection: Selection) {
      validateSelection(selection, state.tables);
      const snapshot = Object.freeze({ ...selection });
      return next(
        {
          selection: snapshot,
          hasWindow: Object.values(snapshot).some((value) => value.phase === 'window'),
        },
        { projections: projections(snapshot) },
      );
    },
    innerJoin: (table: Table, on: Predicate) => join('INNER', table, on),
    leftJoin: (table: Table, on: Predicate) => join('LEFT', table, on),
    rightJoin: (table: Table, on: Predicate) => join('RIGHT', table, on),
    fullJoin: (table: Table, on: Predicate) => join('FULL', table, on),
    crossJoin: (table: Table) => join('CROSS', table),
    lateralJoin: (table: Table) => join('LATERAL', table),
    asofJoin: (table: Table, match: Predicate, on?: Predicate) => join('ASOF', table, on, match),
    groupBy(...values: AnyExpression[]) {
      assertScope(values, refs);
      if (values.some((value) => value.phase !== 'scalar'))
        throw new TypeError('GROUP BY requires scalar expressions.');
      return next({}, { groupBy: Object.freeze(values.map((value) => value.expression)) });
    },
    orderBy(...values: Ordering[]) {
      assertScope(
        values.map((value) => value.value),
        refs,
      );
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
    compile: () => compileAst(checkedAst()),
  }) as unknown as SelectQuery<S, Scope, Nullable>;
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
  validateSelection(selection, [table]);
  const snapshot = Object.freeze({ ...selection });
  return build({
    selection: snapshot,
    tables: Object.freeze([table]),
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
