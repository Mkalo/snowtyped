import {
  type CompiledQuery,
  compileAst,
  type DeleteNode,
  type MergeNode,
  type StatementNode,
  type UpdateNode,
} from './ast.js';
import { type Expression, isExpression, type Predicate } from './expressions.js';
import { assertScope } from './query.js';
import type { AnyColumn, ColumnMap, InferColumn, Table } from './schema.js';

type RequiredKeys<C extends ColumnMap> = {
  [K in keyof C]: C[K]['required'] extends true ? K : never;
}[keyof C];
export type InsertValues<C extends ColumnMap> = { [K in RequiredKeys<C>]: InferColumn<C[K]> } & {
  [K in Exclude<keyof C, RequiredKeys<C>>]?: InferColumn<C[K]>;
};
export type UpdateValues<C extends ColumnMap, Scope extends string = string> = {
  [K in keyof C]?: InferColumn<C[K]> | Expression<InferColumn<C[K]>, Scope>;
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
      [K in keyof InsertValues<C>]: InsertValues<C>[K] | Expression<InsertValues<C>[K], Scope>;
    },
  ): MergeQuery<C, Scope>;
}

function checkTable(table: Table): void {
  if (table.source.kind !== 'table') throw new TypeError('Mutations require a base table.');
}
function mutation(ast: StatementNode): MutationQuery {
  return Object.freeze({ kind: 'mutation', ast, compile: () => compileAst(ast) });
}
function entries(table: Table, values: Readonly<Record<string, unknown>>, refs = [table.ref]) {
  const items = Object.entries(values);
  if (!items.length) throw new TypeError('A mutation needs at least one column value.');
  return Object.freeze(
    items.map(([key, value]) => {
      if (!Object.hasOwn(table.columns, key))
        throw new TypeError(`Unknown mutation column: ${key}`);
      const column = table.columns[key] as AnyColumn;
      if (isExpression(value)) assertScope([value], refs);
      return Object.freeze({
        column: column.node,
        value: isExpression(value) ? value.expression : column.encode(value),
      });
    }),
  );
}

export function insert<C extends ColumnMap>(
  table: Table<C>,
  input: NoInfer<InsertValues<C>> | readonly NoInfer<InsertValues<C>>[],
): MutationQuery {
  checkTable(table);
  const rows = Array.isArray(input) ? input : [input];
  if (!rows.length) throw new TypeError('INSERT needs at least one row.');
  const keys = Object.keys(table.columns);
  const encoded = rows.map((row) => {
    for (const key of Object.keys(row))
      if (!Object.hasOwn(table.columns, key))
        throw new TypeError(`Unknown mutation column: ${key}`);
    return Object.freeze(
      keys.map((key) => {
        const column = table.columns[key] as AnyColumn;
        return column.encode(Object.hasOwn(row, key) ? row[key] : null);
      }),
    );
  });
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
          Object.keys(target.columns).map((key) => [
            key,
            Object.hasOwn(values, key) ? values[key] : null,
          ]),
        );
        for (const key of Object.keys(values))
          if (!Object.hasOwn(target.columns, key))
            throw new TypeError(`Unknown mutation column: ${key}`);
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
