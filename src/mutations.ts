import {
  type CompiledQuery,
  compileAst,
  type DefaultNode,
  type DeleteNode,
  type ExpressionNode,
  type MergeBranchNode,
  type MergeNode,
  type SourceReference,
  type StatementNode,
  type UpdateNode,
} from './ast.js';
import {
  type AnyExpression,
  assertPredicate,
  type ComparableType,
  comparable,
  type Expression,
  type ExpressionDataType,
  isExpression,
  type Predicate,
} from './expressions.js';
import { assertScope, type SelectQuery } from './query.js';
import {
  type AnyColumn,
  type ColumnMap,
  type InferColumn,
  type InferSelection,
  isLeaf,
  type Selection,
  type Table,
} from './schema.js';

type WritableKeys<C extends ColumnMap> = {
  [K in keyof C]: C[K]['serverValue'] extends { readonly kind: 'virtual' } ? never : K;
}[keyof C];
type RequiredKeys<C extends ColumnMap> = {
  [K in WritableKeys<C>]: C[K]['required'] extends true
    ? C[K]['serverValue'] extends null
      ? K
      : never
    : never;
}[WritableKeys<C>];
/**
 * A row for {@link insert}: required columns without a server value must be present, other writable
 * columns are optional, and virtual columns are excluded.
 */
export type InsertValues<C extends ColumnMap> = { [K in RequiredKeys<C>]: InferColumn<C[K]> } & {
  [K in Exclude<WritableKeys<C>, RequiredKeys<C>>]?: InferColumn<C[K]>;
};
/**
 * The row {@link insert} accepts for a table: {@link InsertValues} of its columns.
 *
 * @example
 * ```ts
 * type NewCustomer = InferInsert<typeof customers>;
 * // { id: bigint; name: string; email?: string | null }
 * ```
 */
export type InferInsert<T> =
  T extends Table<infer C extends ColumnMap> ? Simplify<InsertValues<C>> : never;
/**
 * The literal values {@link update} accepts for a table: every writable column, optional. Virtual
 * columns are excluded. {@link UpdateValues} additionally accepts expressions.
 *
 * @example
 * ```ts
 * type CustomerPatch = InferUpdate<typeof customers>;
 * // { id?: bigint; name?: string; email?: string | null }
 * ```
 */
export type InferUpdate<T> =
  T extends Table<infer C extends ColumnMap>
    ? { [K in WritableKeys<C>]?: InferColumn<C[K]> }
    : never;
type Simplify<T> = { [K in keyof T]: T[K] };
type Assignment<C extends AnyColumn, Scope extends string> = Expression<
  InferColumn<C>,
  Scope,
  string,
  ComparableType<ExpressionDataType<C>>
>;
/**
 * Assignments for {@link update}, {@link updateFrom}, and MERGE: writable columns mapped to
 * literals or expressions of an assignable SQL type.
 */
export type UpdateValues<C extends ColumnMap, Scope extends string = string> = {
  [K in WritableKeys<C>]?: InferColumn<C[K]> | Assignment<C[K], Scope>;
};
/**
 * Resolves to `unknown` when a query's rows fit the target table for {@link insertFrom}, and to
 * `never` otherwise.
 */
export type InsertSource<C extends ColumnMap, Row> = [
  Exclude<keyof Row, keyof InsertValues<C>>,
] extends [never]
  ? Row extends InsertValues<C>
    ? unknown
    : never
  : never;
type SourceTypes<C extends ColumnMap, S extends Selection> = true extends {
  [K in keyof S & keyof C]: ExpressionDataType<S[K]> extends ComparableType<
    ExpressionDataType<C[K]>
  >
    ? false
    : true;
}[keyof S & keyof C]
  ? never
  : unknown;
/**
 * An INSERT, UPDATE, DELETE, or MERGE statement. Executing it resolves to `{ affectedRows, queryId
 * }`.
 */
export interface MutationQuery {
  /** Identifies a mutation. */
  readonly kind: 'mutation';
  /** The statement's syntax tree. */
  readonly ast: StatementNode;
  /** Compiles the statement to SQL text and bind values without executing it. */
  compile(): CompiledQuery;
}
/**
 * An UPDATE or DELETE that can be filtered with `.where()`. Without a filter it affects every row
 * of the table.
 */
export interface FilteredMutation<Scope extends string> extends MutationQuery {
  /**
   * Filters the affected rows with WHERE, replacing an earlier filter. The join predicate of
   * {@link updateFrom} and {@link deleteUsing} is kept.
   */
  where(predicate: Predicate<Scope>): FilteredMutation<Scope>;
}
/**
 * A MERGE statement built by {@link mergeInto}. Branches are emitted in the order they are added,
 * and compiling requires at least one.
 *
 * An unconditional branch must be the last of its kind: adding it again replaces it, and adding a
 * conditional branch after it throws.
 */
export interface MergeQuery<
  C extends ColumnMap,
  Scope extends string,
  Source extends string = Scope,
> extends MutationQuery {
  /**
   * Adds `WHEN MATCHED [AND condition] THEN UPDATE SET ...`. Values may reference the target and
   * the source.
   */
  whenMatchedUpdate(
    values: UpdateValues<C, Scope>,
    condition?: Predicate<Scope>,
  ): MergeQuery<C, Scope, Source>;
  /** Adds `WHEN MATCHED [AND condition] THEN DELETE`. */
  whenMatchedDelete(condition?: Predicate<Scope>): MergeQuery<C, Scope, Source>;
  /**
   * Adds `WHEN NOT MATCHED [AND condition] THEN INSERT ...`. Values and the condition can only
   * reference the source, because the target row does not exist.
   */
  whenNotMatchedInsert(
    values: {
      [K in keyof InsertValues<C>]: InsertValues<C>[K] | Assignment<C[K & keyof C], Source>;
    },
    condition?: Predicate<Source>,
  ): MergeQuery<C, Scope, Source>;
}

function checkTable(table: Table): void {
  if (table.source.kind !== 'table') throw new TypeError('Mutations require a base table.');
}
function checkSource(target: Table, source: Table): void {
  checkTable(target);
  if (!['table', 'derived', 'cte'].includes(source.source.kind))
    throw new TypeError('Mutation sources must be tables, derived queries, or CTEs.');
  if (target.ref.name === source.ref.name)
    throw new TypeError('Mutation sources need distinct names.');
}
function condition(
  predicate: Predicate,
  refs: readonly SourceReference[],
  keyword: string,
  clause: string,
) {
  assertScope([predicate], refs);
  assertPredicate(predicate, keyword);
  if (predicate.phase !== 'scalar') throw new TypeError(`${clause} must be scalar.`);
  return predicate.expression;
}
function mutation(ast: StatementNode): MutationQuery {
  return Object.freeze({ kind: 'mutation', ast, compile: () => compileAst(ast) });
}
function writable(table: Table, key: string): AnyColumn {
  if (!Object.hasOwn(table.columns, key)) throw new TypeError(`Unknown mutation column: ${key}`);
  const column = table.columns[key] as AnyColumn;
  if (column.serverValue?.kind === 'virtual')
    throw new TypeError(`Cannot write virtual column: ${key}`);
  return column;
}
function assignable(column: AnyColumn, value: AnyExpression, key: string): void {
  if (!comparable(column.dataType, value.dataType))
    throw new TypeError(
      `Cannot assign a ${value.dataType.toUpperCase()} expression to ${column.dataType.toUpperCase()} column ${key}.`,
    );
}
function provided(table: Table, values: Readonly<Record<string, unknown>>): string[] {
  for (const key of Object.keys(values)) writable(table, key);
  return Object.keys(table.columns).filter((key) => {
    const column = table.columns[key] as AnyColumn;
    if (Object.hasOwn(values, key) && values[key] !== undefined) return true;
    if (column.required && !column.serverValue)
      throw new TypeError(`Missing required insert column: ${key}`);
    return false;
  });
}
function entries(
  table: Table,
  values: Readonly<Record<string, unknown>>,
  refs: readonly SourceReference[] = [table.ref],
) {
  const items = Object.entries(values);
  if (!items.length) throw new TypeError('A mutation needs at least one column value.');
  return Object.freeze(
    items.map(([key, value]) => {
      const column = writable(table, key);
      if (isExpression(value)) {
        assertScope([value], refs);
        if (value.phase !== 'scalar')
          throw new TypeError('Mutation values cannot contain aggregate or window functions.');
        assignable(column, value, key);
      }
      return Object.freeze({
        column: column.node,
        value: isExpression(value) ? value.expression : column.encodeWrite(value),
      });
    }),
  );
}

/** The same wrapper with NULL binds, so a defaulted cell keeps the column's SQL type. */
function nullParameters<T>(node: T): T {
  if (Array.isArray(node)) return Object.freeze(node.map(nullParameters)) as T;
  if (typeof node !== 'object' || node === null) return node;
  if ((node as { kind?: unknown }).kind === 'parameter')
    return Object.freeze({ kind: 'parameter', value: null }) as T;
  return Object.freeze(
    Object.fromEntries(Object.entries(node).map(([key, value]) => [key, nullParameters(value)])),
  ) as T;
}

/**
 * Inserts one row or an array of rows into a base table.
 *
 * Omitted columns are left out of the statement, so Snowflake applies their default, identity, or
 * NULL; rows that omit different columns compile to one `INSERT ALL`. An explicit `null` writes SQL
 * NULL. Values are validated against the declared columns.
 *
 * @throws `TypeError` when there are no rows, a required column is missing, or a value is invalid.
 * @example
 * ```ts
 * await db.execute(insert(customers, { id: 1n, name: 'Ada', email: null }));
 * ```
 */
export function insert<C extends ColumnMap>(
  table: Table<C>,
  input: NoInfer<InsertValues<C>> | readonly NoInfer<InsertValues<C>>[],
): MutationQuery {
  checkTable(table);
  const rows: readonly Readonly<Record<string, unknown>>[] = Array.isArray(input) ? input : [input];
  if (!rows.length) throw new TypeError('INSERT needs at least one row.');
  const present = rows.map((row) => new Set(provided(table, row)));
  let keys = Object.keys(table.columns).filter((key) => present.some((row) => row.has(key)));
  if (!keys.length) {
    const fallback = Object.keys(table.columns).find(
      (key) => (table.columns[key] as AnyColumn).serverValue?.kind !== 'virtual',
    );
    if (fallback === undefined) throw new TypeError('INSERT needs a writable column.');
    keys = [fallback];
  }
  const written = rows.map((row, index) =>
    keys.map((key) =>
      (present[index] as Set<string>).has(key)
        ? (table.columns[key] as AnyColumn).encodeWrite(row[key])
        : undefined,
    ),
  );
  const defaults = keys.map((_, position): DefaultNode => {
    const sample = written.map((row) => row[position]).find((value) => value !== undefined);
    return Object.freeze({
      kind: 'default',
      ...(sample && sample.kind !== 'parameter' ? { placeholder: nullParameters(sample) } : {}),
    });
  });
  const encoded = written.map((row) =>
    Object.freeze(row.map((value, position) => value ?? (defaults[position] as DefaultNode))),
  );
  return mutation(
    Object.freeze({
      kind: 'insert',
      table: table.node,
      columns: Object.freeze(keys.map((key) => (table.columns[key] as AnyColumn).node)),
      rows: Object.freeze(encoded),
    }),
  );
}

/**
 * Inserts the rows of a query with `INSERT INTO ... SELECT`, mapping each projection alias to the
 * target column of the same key.
 *
 * The selected row type, including nullability from outer joins, must fit the target, and required
 * columns without a server value must be selected.
 *
 * @example
 * ```ts
 * insertFrom(target, select(staged, { id: staged.columns.id, name: staged.columns.name }));
 * ```
 */
export function insertFrom<
  C extends ColumnMap,
  S extends Selection,
  Scope extends string,
  Nullable extends string,
>(
  table: Table<C>,
  query: SelectQuery<S, Scope, Nullable> &
    InsertSource<C, InferSelection<S, Nullable>> &
    SourceTypes<C, S>,
): MutationQuery {
  checkTable(table);
  query.compile();
  if (!Object.values(query.selection).every(isLeaf))
    throw new TypeError('An INSERT source needs flat columns, not nested projections.');
  const keys = Object.keys(query.selection);
  const columns = keys.map((key) => {
    const column = writable(table, key);
    assignable(column, query.selection[key] as AnyExpression, key);
    return column.node;
  });
  for (const [key, column] of Object.entries(table.columns))
    if (column.required && !column.serverValue && !keys.includes(key))
      throw new TypeError(`INSERT source is missing required column: ${key}`);
  return mutation(
    Object.freeze({
      kind: 'insert',
      table: table.node,
      columns: Object.freeze(columns),
      rows: Object.freeze([]),
      query: query.ast,
    }),
  );
}

function filtered<N extends string>(
  refs: readonly SourceReference[],
  ast: UpdateNode | DeleteNode,
  on?: ExpressionNode,
): FilteredMutation<N> {
  return Object.freeze({
    ...mutation(ast),
    where(predicate: Predicate<N>) {
      const where = condition(predicate, refs, 'WHERE', 'Mutation filters');
      return filtered(
        refs,
        Object.freeze({
          ...ast,
          where: on
            ? Object.freeze({
                kind: 'logical',
                operator: 'AND',
                operands: Object.freeze([on, where]),
              })
            : where,
        }),
        on,
      );
    },
  });
}
/**
 * Updates rows of a base table. Values are literals or expressions of the same table.
 *
 * Without `.where()`, every row is updated.
 *
 * @example
 * ```ts
 * await db.execute(update(customers, { name: 'Grace' }).where(eq(customers.columns.id, 1n)));
 * ```
 */
export function update<C extends ColumnMap, N extends string>(
  table: Table<C, N>,
  values: NoInfer<UpdateValues<C, N>>,
): FilteredMutation<N> {
  checkTable(table);
  return filtered(
    [table.ref],
    Object.freeze({ kind: 'update', table: table.node, assignments: entries(table, values) }),
  );
}
/**
 * Updates rows of `target` that match rows of `source` with `UPDATE ... FROM`. Values may reference
 * both tables.
 *
 * The `on` join predicate is required, so a missing filter cannot update every row with an
 * arbitrary match. `.where()` adds filters to it.
 *
 * @param source - A base table, a derived query (`.as()`), or a CTE (`.asCte()`), which is inlined.
 * @example
 * ```ts
 * updateFrom(target, staged, eq(target.columns.id, staged.columns.id), {
 *   name: staged.columns.name,
 * });
 * ```
 */
export function updateFrom<
  C extends ColumnMap,
  T extends string,
  S extends ColumnMap,
  N extends string,
>(
  target: Table<C, T>,
  source: Table<S, N>,
  on: Predicate<T | N>,
  values: NoInfer<UpdateValues<C, T | N>>,
): FilteredMutation<T | N> {
  checkSource(target, source);
  const refs = [target.ref, source.ref];
  const join = condition(on, refs, 'UPDATE FROM', 'UPDATE FROM join predicates');
  return filtered(
    refs,
    Object.freeze({
      kind: 'update',
      table: target.node,
      alias: target.ref.qualifier,
      assignments: entries(target, values, refs),
      from: source.source,
      where: join,
    }),
    join,
  );
}
/**
 * Deletes rows of a base table. Without `.where()`, every row is deleted.
 *
 * @example
 * ```ts
 * await db.execute(deleteFrom(customers).where(eq(customers.columns.id, 1n)));
 * ```
 */
export function deleteFrom<C extends ColumnMap, N extends string>(
  table: Table<C, N>,
): FilteredMutation<N> {
  checkTable(table);
  return filtered([table.ref], Object.freeze({ kind: 'delete', table: table.node }));
}
/**
 * Deletes rows of `target` that match rows of `source` with `DELETE ... USING`.
 *
 * The `on` join predicate is required, and `.where()` adds filters to it.
 *
 * @param source - A base table, a derived query (`.as()`), or a CTE (`.asCte()`), which is inlined.
 */
export function deleteUsing<
  C extends ColumnMap,
  T extends string,
  S extends ColumnMap,
  N extends string,
>(target: Table<C, T>, source: Table<S, N>, on: Predicate<T | N>): FilteredMutation<T | N> {
  checkSource(target, source);
  const refs = [target.ref, source.ref];
  const join = condition(on, refs, 'DELETE USING', 'DELETE USING join predicates');
  return filtered(
    refs,
    Object.freeze({
      kind: 'delete',
      table: target.node,
      alias: target.ref.qualifier,
      using: source.source,
      where: join,
    }),
    join,
  );
}

/**
 * Starts a MERGE of `source` into `target`, matched with `on`. Add branches with the
 * {@link MergeQuery} methods.
 *
 * @param source - A base table, a derived query (`.as()`), or a CTE (`.asCte()`), which is inlined.
 * @example
 * ```ts
 * mergeInto(target, staged, eq(target.columns.id, staged.columns.id))
 *   .whenMatchedDelete(eq(staged.columns.name, 'gone'))
 *   .whenMatchedUpdate({ name: staged.columns.name })
 *   .whenNotMatchedInsert({ id: staged.columns.id, name: staged.columns.name });
 * ```
 */
export function mergeInto<
  C extends ColumnMap,
  T extends string,
  S extends ColumnMap,
  N extends string,
>(target: Table<C, T>, source: Table<S, N>, on: Predicate<T | N>): MergeQuery<C, T | N, N> {
  checkSource(target, source);
  const refs = [target.ref, source.ref];
  const base: MergeNode = Object.freeze({
    kind: 'merge',
    target: Object.freeze({ kind: 'table', name: target.node, alias: target.ref.qualifier }),
    source: source.source,
    on: condition(on, refs, 'MERGE', 'MERGE match predicates'),
    branches: Object.freeze([]),
  });
  function add(ast: MergeNode, branch: MergeBranchNode): MergeQuery<C, T | N, N> {
    const matched = (item: MergeBranchNode) =>
      (item.kind === 'not-matched-insert') === (branch.kind === 'not-matched-insert');
    const branches = ast.branches as readonly MergeBranchNode[];
    const fallback = branches.findIndex((item) => matched(item) && !item.condition);
    if (fallback >= 0 && branch.condition)
      throw new TypeError(
        'Unreachable MERGE branch: an unconditional branch must be the last of its kind.',
      );
    const next =
      fallback >= 0
        ? branches.map((item, index) => (index === fallback ? branch : item))
        : [...branches, branch];
    return build(Object.freeze({ ...ast, branches: Object.freeze(next) }));
  }
  function when(predicate: Predicate | undefined, scope: readonly SourceReference[]) {
    return predicate
      ? { condition: condition(predicate, scope, 'MERGE branch', 'MERGE branch conditions') }
      : {};
  }
  function build(ast: MergeNode): MergeQuery<C, T | N, N> {
    return Object.freeze({
      ...mutation(ast),
      compile() {
        if (!ast.branches?.length) throw new TypeError('MERGE needs at least one action.');
        return compileAst(ast);
      },
      whenMatchedUpdate(values: UpdateValues<C>, predicate?: Predicate) {
        return add(
          ast,
          Object.freeze({
            kind: 'matched-update',
            ...when(predicate, refs),
            assignments: entries(target, values, refs),
          }),
        );
      },
      whenMatchedDelete(predicate?: Predicate) {
        return add(ast, Object.freeze({ kind: 'matched-delete', ...when(predicate, refs) }));
      },
      whenNotMatchedInsert(values: Record<string, unknown>, predicate?: Predicate) {
        const completed = Object.fromEntries(
          provided(target, values).map((key) => [key, values[key]]),
        );
        const items = entries(target, completed, [source.ref]);
        return add(
          ast,
          Object.freeze({
            kind: 'not-matched-insert',
            ...when(predicate, [source.ref]),
            columns: Object.freeze(items.map((item) => item.column)),
            values: Object.freeze(items.map((item) => item.value)),
          }),
        );
      },
    });
  }
  return build(base);
}
