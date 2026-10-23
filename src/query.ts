import * as z from 'zod';
import {
  type CompiledQuery,
  type CteNode,
  compileAst,
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
import type { AnyExpression, Expression, Ordering, Predicate } from './expressions.js';
import {
  type AnyColumn,
  bindColumn,
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
export interface SetOperand {
  readonly kind: 'select' | 'set';
  readonly rowType?: object;
}
export type OperandRow<Q> = Q extends { readonly rowType?: infer R } ? R : never;
/** Branches match by projection alias; each alias needs the same domain in both branches. */
export type CompatibleOperand<L, R> = [SetMismatch<L, R>] extends [never]
  ? unknown
  : { readonly incompatibleSetColumns: SetMismatch<L, R> };
export type UnionRow<L, R> = { [K in keyof L]: L[K] | R[K & keyof R] };
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
/** The recursive branch must produce rows of the contract that its self-reference reads. */
export type RecursiveOperand<Contract, R> = ([RecursiveMismatch<Contract, R>] extends [never]
  ? unknown
  : { readonly incompatibleRecursiveColumns: RecursiveMismatch<Contract, R> }) &
  ([UndeclaredNull<Contract, R>] extends [never]
    ? unknown
    : { readonly undeclaredNullableColumns: UndeclaredNull<Contract, R> });
export type RecursiveRow<Row, Nullable extends PropertyKey = never> = {
  [K in keyof Row]: K extends Nullable ? Row[K] | null : Row[K];
};
export type RecursiveName<N extends string> =
  N extends Uppercase<N> ? unknown : { readonly recursiveCteNamesMustBeUppercase: N };
export type SetScope = '__sflib_result';
export type SetColumns<Row, N extends string = SetScope> = {
  [K in keyof Row]: Column<Row[K], true, N>;
};
interface SetOperations<Row> {
  union<Q extends SetOperand>(
    other: Q & CompatibleOperand<Row, OperandRow<Q>>,
  ): SetQuery<UnionRow<Row, OperandRow<Q>>>;
  unionAll<Q extends SetOperand>(
    other: Q & CompatibleOperand<Row, OperandRow<Q>>,
  ): SetQuery<UnionRow<Row, OperandRow<Q>>>;
  intersect<Q extends SetOperand>(
    other: Q & CompatibleOperand<Row, OperandRow<Q>>,
  ): SetQuery<IntersectRow<Row, OperandRow<Q>>>;
  except<Q extends SetOperand>(other: Q & CompatibleOperand<Row, OperandRow<Q>>): SetQuery<Row>;
}
export interface SetQuery<Row> extends SetOperations<Row> {
  readonly kind: 'set';
  readonly ast: SetOperationNode;
  readonly columns: SetColumns<Row>;
  readonly selection: SetColumns<Row>;
  readonly nullableSources: ReadonlySet<symbol>;
  readonly rowType?: Row;
  orderBy(...values: readonly Ordering<SetScope>[]): SetQuery<Row>;
  limit(value: number): SetQuery<Row>;
  offset(value: number): SetQuery<Row>;
  as<const N extends string>(name: N): Table<SetColumns<Row, N>, N>;
  asCte<const N extends string>(name: N): Table<SetColumns<Row, N>, N>;
  compile(): CompiledQuery;
}
export interface SelectQuery<
  S extends Selection,
  Scope extends string = string,
  Nullable extends string = never,
> extends SetOperations<InferSelection<S, Nullable>> {
  readonly kind: 'select';
  readonly ast: SelectNode;
  readonly selection: S;
  readonly nullableSources: ReadonlySet<symbol>;
  readonly sourceScopeType?: Scope;
  readonly nullableScopeType?: Nullable;
  readonly rowType?: InferSelection<S, Nullable>;
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

interface Output {
  readonly source: AnyExpression;
  readonly read: z.ZodType;
  readonly value: z.ZodType;
  readonly nullable: boolean;
}
const untypedDomains = [
  ['boolean', true],
  ['text', ''],
  ['binary', new Uint8Array()],
] as const;
function domain(expression: AnyExpression): string | undefined {
  return (
    expression.wireType ??
    untypedDomains.find(([, probe]) => expression.valueSchema.safeParse(probe).success)?.[0]
  );
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
    dataType: 'text',
    required: true,
    readSchema: output.nullable ? output.read.nullable() : output.read,
    valueSchema: output.nullable ? output.value.nullable() : output.value,
    notNull() {
      return this as Column<unknown, true>;
    },
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
      if (domain(l.source) !== domain(r.source))
        throw new TypeError(`Set operation column ${key} combines different domains.`);
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
  function checkedAst(): SelectNode {
    if (state.ast.qualify && !state.hasWindow && !state.qualifyWindow)
      throw new TypeError('QUALIFY requires a window function.');
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
 * Defines `WITH RECURSIVE name (...) AS (anchor UNION ALL recursive)`. The anchor's projection
 * is the row contract, widened by `nullable`; the recursive branch reads it through `self`.
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
    self: Table<SetColumns<RecursiveRow<OperandRow<A>, Nullable>, N>, N>,
  ) => Q & RecursiveOperand<RecursiveRow<OperandRow<A>, Nullable>, OperandRow<Q>>,
  options?: { readonly nullable?: readonly Nullable[] },
): Table<SetColumns<RecursiveRow<OperandRow<A>, Nullable>, N>, N>;
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
