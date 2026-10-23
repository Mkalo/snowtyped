import {
  type CompiledQuery,
  compileAst,
  type DefaultNode,
  type DeleteNode,
  type MergeNode,
  type StatementNode,
  type UpdateNode,
} from './ast.js';
import {
  assertPredicate,
  type ComparableType,
  comparable,
  type Expression,
  type ExpressionDataType,
  isExpression,
  type Predicate,
} from './expressions.js';
import { assertScope } from './query.js';
import type { AnyColumn, ColumnMap, InferColumn, Table } from './schema.js';

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
export type InsertValues<C extends ColumnMap> = { [K in RequiredKeys<C>]: InferColumn<C[K]> } & {
  [K in Exclude<WritableKeys<C>, RequiredKeys<C>>]?: InferColumn<C[K]>;
};
type Assignment<C extends AnyColumn, Scope extends string> = Expression<
  InferColumn<C>,
  Scope,
  string,
  ComparableType<ExpressionDataType<C>>
>;
export type UpdateValues<C extends ColumnMap, Scope extends string = string> = {
  [K in WritableKeys<C>]?: InferColumn<C[K]> | Assignment<C[K], Scope>;
};
export interface MutationQuery {
  readonly kind: 'mutation';
  readonly ast: StatementNode;
  compile(): CompiledQuery;
}
export interface FilteredMutation<Scope extends string> extends MutationQuery {
  where(predicate: Predicate<Scope>): FilteredMutation<Scope>;
}
export interface MergeQuery<C extends ColumnMap, Scope extends string> extends MutationQuery {
  whenMatchedUpdate(values: UpdateValues<C, Scope>): MergeQuery<C, Scope>;
  whenMatchedDelete(): MergeQuery<C, Scope>;
  whenNotMatchedInsert(
    values: {
      [K in keyof InsertValues<C>]: InsertValues<C>[K] | Assignment<C[K & keyof C], Scope>;
    },
  ): MergeQuery<C, Scope>;
}

function checkTable(table: Table): void {
  if (table.source.kind !== 'table') throw new TypeError('Mutations require a base table.');
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
function entries(table: Table, values: Readonly<Record<string, unknown>>, refs = [table.ref]) {
  const items = Object.entries(values);
  if (!items.length) throw new TypeError('A mutation needs at least one column value.');
  return Object.freeze(
    items.map(([key, value]) => {
      const column = writable(table, key);
      if (isExpression(value)) {
        assertScope([value], refs);
        if (value.phase !== 'scalar')
          throw new TypeError('Mutation values cannot contain aggregate or window functions.');
        if (!comparable(column.dataType, value.dataType))
          throw new TypeError(
            `Cannot assign a ${value.dataType.toUpperCase()} expression to ${column.dataType.toUpperCase()} column ${key}.`,
          );
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

function filtered<N extends string>(
  table: Table<ColumnMap, N>,
  ast: UpdateNode | DeleteNode,
): FilteredMutation<N> {
  return Object.freeze({
    ...mutation(ast),
    where(predicate: Predicate<N>) {
      assertScope([predicate], [table.ref]);
      assertPredicate(predicate, 'WHERE');
      if (predicate.phase !== 'scalar') throw new TypeError('Mutation filters must be scalar.');
      return filtered(table, Object.freeze({ ...ast, where: predicate.expression }));
    },
  });
}
export function update<C extends ColumnMap, N extends string>(
  table: Table<C, N>,
  values: NoInfer<UpdateValues<C, N>>,
): FilteredMutation<N> {
  checkTable(table);
  return filtered(
    table,
    Object.freeze({ kind: 'update', table: table.node, assignments: entries(table, values) }),
  );
}
export function deleteFrom<C extends ColumnMap, N extends string>(
  table: Table<C, N>,
): FilteredMutation<N> {
  checkTable(table);
  return filtered(table, Object.freeze({ kind: 'delete', table: table.node }));
}

export function mergeInto<
  C extends ColumnMap,
  T extends string,
  S extends ColumnMap,
  N extends string,
>(target: Table<C, T>, source: Table<S, N>, on: Predicate<T | N>): MergeQuery<C, T | N> {
  checkTable(target);
  if (target.ref.name === source.ref.name)
    throw new TypeError('MERGE sources need distinct names.');
  assertScope([on], [target.ref, source.ref]);
  assertPredicate(on, 'MERGE');
  if (on.phase !== 'scalar') throw new TypeError('MERGE requires a scalar match predicate.');
  const base: MergeNode = Object.freeze({
    kind: 'merge',
    target: Object.freeze({ kind: 'table', name: target.node, alias: target.ref.qualifier }),
    source: source.source,
    on: on.expression,
  });
  function build(ast: MergeNode): MergeQuery<C, T | N> {
    return Object.freeze({
      ...mutation(ast),
      compile() {
        if (!ast.matched && !ast.insert && !ast.deleteMatched)
          throw new TypeError('MERGE needs at least one action.');
        return compileAst(ast);
      },
      whenMatchedUpdate(values: UpdateValues<C>) {
        const { deleteMatched: _, ...previous } = ast;
        return build(
          Object.freeze({
            ...previous,
            matched: entries(target, values, [target.ref, source.ref]),
          }),
        );
      },
      whenMatchedDelete() {
        const { matched: _, ...previous } = ast;
        return build(Object.freeze({ ...previous, deleteMatched: true }));
      },
      whenNotMatchedInsert(values: Record<string, unknown>) {
        const completed = Object.fromEntries(
          provided(target, values).map((key) => [key, values[key]]),
        );
        const items = entries(target, completed, [target.ref, source.ref]);
        return build(
          Object.freeze({
            ...ast,
            insert: Object.freeze({
              columns: Object.freeze(items.map((item) => item.column)),
              values: Object.freeze(items.map((item) => item.value)),
            }),
          }),
        );
      },
    });
  }
  return build(base);
}
