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
  type SetOperationNode,
  type SetOperator,
  type SourceReference,
} from './ast.js';
import {
  type AnyExpression,
  assertNotType,
  assertPredicate,
  type Expression,
  type ExpressionDataType,
  type KeyType,
  type Ordering,
  type Predicate,
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
  type Selection,
  type Table,
} from './schema.js';

export type ScopedSelection<S extends string> = Readonly<
  Record<string, Expression<unknown, S, string>>
>;
export type DerivedColumns<S extends Selection, N extends string, Nullable extends string> = {
  [K in keyof S]: Column<InferSelection<S, Nullable>[K], true, N, 'none', ExpressionDataType<S[K]>>;
};
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
export interface SetOperand {
  readonly kind: 'select' | 'set';
  readonly rowType?: object;
  readonly sqlTypes?: object;
}
export type OperandRow<Q> = Q extends { readonly rowType?: infer R } ? R : never;
export type OperandTypes<Q> = Q extends { readonly sqlTypes?: infer T } ? T : never;
export type SelectionTypes<S extends Selection> = { [K in keyof S]: ExpressionDataType<S[K]> };
type ColumnType<T, K> = K extends keyof T ? (T[K] extends DataType ? T[K] : DataType) : DataType;
/** Branches match by projection alias; each alias needs the same SQL type in both branches. */
export type CompatibleOperand<L, R, LT = object, RT = object> = [
  SetMismatch<L, R> | TypeMismatch<LT, RT>,
] extends [never]
  ? unknown
  : { readonly incompatibleSetColumns: SetMismatch<L, R> | TypeMismatch<LT, RT> };
export type UnionRow<L, R> = { [K in keyof L]: L[K] | R[K & keyof R] };
export type IntersectRow<L, R> = {
  [K in keyof L]: null extends R[K & keyof R] ? L[K] : Present<L[K]>;
};
export type SetScope = '__sflib_result';
export type SetColumns<Row, N extends string = SetScope, Types = object> = {
  [K in keyof Row]: Column<Row[K], true, N, 'none', ColumnType<Types, K>>;
};
interface SetOperations<Row, Types> {
  union<Q extends SetOperand>(
    other: Q & CompatibleOperand<Row, OperandRow<Q>, Types, OperandTypes<Q>>,
  ): SetQuery<UnionRow<Row, OperandRow<Q>>, Types>;
  unionAll<Q extends SetOperand>(
    other: Q & CompatibleOperand<Row, OperandRow<Q>, Types, OperandTypes<Q>>,
  ): SetQuery<UnionRow<Row, OperandRow<Q>>, Types>;
  intersect<Q extends SetOperand>(
    other: Q & CompatibleOperand<Row, OperandRow<Q>, Types, OperandTypes<Q>>,
  ): SetQuery<IntersectRow<Row, OperandRow<Q>>, Types>;
  except<Q extends SetOperand>(
    other: Q & CompatibleOperand<Row, OperandRow<Q>, Types, OperandTypes<Q>>,
  ): SetQuery<Row, Types>;
}
export interface SetQuery<Row, Types = object> extends SetOperations<Row, Types> {
  readonly kind: 'set';
  readonly ast: SetOperationNode;
  readonly columns: SetColumns<Row, SetScope, Types>;
  readonly selection: SetColumns<Row, SetScope, Types>;
  readonly nullableSources: ReadonlySet<symbol>;
  readonly rowType?: Row;
  readonly sqlTypes?: Types;
  orderBy(...values: readonly Ordering<SetScope>[]): SetQuery<Row, Types>;
  limit(value: number): SetQuery<Row, Types>;
  offset(value: number): SetQuery<Row, Types>;
  as<const N extends string>(name: N): Table<SetColumns<Row, N, Types>, N>;
  asCte<const N extends string>(name: N): Table<SetColumns<Row, N, Types>, N>;
  compile(): CompiledQuery;
}
export interface SelectQuery<
  S extends Selection,
  Scope extends string = string,
  Nullable extends string = never,
> extends SetOperations<InferSelection<S, Nullable>, SelectionTypes<S>> {
  readonly kind: 'select';
  readonly ast: SelectNode;
  readonly selection: S;
  readonly nullableSources: ReadonlySet<symbol>;
  readonly sourceScopeType?: Scope;
  readonly nullableScopeType?: Nullable;
  readonly rowType?: InferSelection<S, Nullable>;
  readonly sqlTypes?: SelectionTypes<S>;
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
    ...values: readonly Expression<unknown, Scope, string, KeyType>[]
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
function sameNode(left: unknown, right: unknown): boolean {
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
function assertGrouped(node: ExpressionNode, keys: readonly ExpressionNode[]): void {
  if (keys.some((key) => sameNode(key, node))) return;
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
  for (const child of children(node)) assertGrouped(child, keys);
}
/** Snowflake groups a query with GROUP BY or any aggregate outside a window function's own call. */
function assertGrouping(ast: SelectNode): void {
  const values = [
    ...ast.projections.map((item) => item.column),
    ...(ast.having ? [ast.having] : []),
    ...(ast.qualify ? [ast.qualify] : []),
  ];
  const orders = (ast.orderBy ?? []).map((item) => item.expression);
  if (!ast.groupBy?.length && ![...values, ...orders].some(containsAggregate)) return;
  for (const value of [...values, ...orders]) assertGrouped(value, ast.groupBy ?? []);
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
function combine(
  operator: SetOperator,
  left: Operand,
  other: unknown,
): SetQuery<Record<string, unknown>> {
  const resolve = typeof other === 'object' && other !== null ? operands.get(other) : undefined;
  if (!resolve) throw new TypeError('Set operations combine queries built by select().');
  const right = resolve();
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

function build<S extends Selection, Scope extends string, Nullable extends string>(
  state: State,
): SelectQuery<S, Scope, Nullable> {
  const refs = state.tables.map((table) => table.ref);
  function next(patch: Partial<State>, ast: Partial<SelectNode> = {}) {
    return build({
      ...state,
      ...patch,
      ast: Object.freeze({ ...state.ast, ...ast }),
    });
  }
  function join(kind: JoinNode['kind'], table: Table, on?: Predicate, match?: Predicate) {
    if (refs.some((ref) => ref.id === table.ref.id || ref.name === table.ref.name))
      throw new TypeError('Join sources need distinct names; alias repeated tables.');
    if (table.source.kind === 'flatten' && kind !== 'LATERAL')
      throw new TypeError('FLATTEN must use lateralJoin.');
    if (kind === 'LATERAL' && table.source.kind !== 'flatten')
      throw new TypeError('lateralJoin requires FLATTEN.');
    const available = [...refs, table.ref];
    const predicates = [...(on ? [on] : []), ...(match ? [match] : [])];
    assertScope(predicates, available);
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
    assertScope([value], refs);
    assertPredicate(value, key.toUpperCase());
    if (key === 'where' && value.phase !== 'scalar')
      throw new TypeError('WHERE requires scalar expressions; use HAVING or QUALIFY.');
    if (key === 'having' && value.phase === 'window')
      throw new TypeError('HAVING cannot contain window expressions.');
    return next(key === 'qualify' ? { qualifyWindow: value.phase === 'window' } : {}, {
      [key]: value.expression,
    });
  }
  function checkedAst(): SelectNode {
    if (state.ast.qualify && !state.hasWindow && !state.qualifyWindow)
      throw new TypeError('QUALIFY requires a window function.');
    assertGrouping(state.ast);
    return state.ast;
  }
  const operand = (): Operand => ({
    ast: checkedAst(),
    outputs: outputs(state.selection, state.nullable),
  });
  const query = Object.freeze({
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
      for (const value of values) assertNotType(value, spatialTypes, 'GROUP BY');
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
    limit: (value: number) => next({}, { limit: bound('LIMIT', value) }),
    offset: (value: number) => next({}, { offset: bound('OFFSET', value) }),
    union: (other: unknown) => combine('UNION', operand(), other),
    unionAll: (other: unknown) => combine('UNION ALL', operand(), other),
    intersect: (other: unknown) => combine('INTERSECT', operand(), other),
    except: (other: unknown) => combine('EXCEPT', operand(), other),
    as: (name: string) => derivedTable(operand().outputs, checkedAst(), name, false),
    asCte: (name: string) => derivedTable(operand().outputs, checkedAst(), name, true),
    compile: () => compileAst(checkedAst()),
  }) as unknown as SelectQuery<S, Scope, Nullable>;
  operands.set(query, operand);
  return query;
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
