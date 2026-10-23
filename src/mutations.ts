import {
  type CompiledQuery,
  compileAst,
  type DeleteNode,
  type ExpressionNode,
  type MergeBranchNode,
  type MergeNode,
  type SourceReference,
  type StatementNode,
  type UpdateNode,
} from './ast.js';
import { type Expression, isExpression, type Predicate } from './expressions.js';
import { assertScope, type SelectQuery } from './query.js';
import type {
  AnyColumn,
  ColumnMap,
  InferColumn,
  InferSelection,
  Selection,
  Table,
} from './schema.js';

type RequiredKeys<C extends ColumnMap> = {
  [K in keyof C]: C[K]['required'] extends true ? K : never;
}[keyof C];
export type InsertValues<C extends ColumnMap> = { [K in RequiredKeys<C>]: InferColumn<C[K]> } & {
  [K in Exclude<keyof C, RequiredKeys<C>>]?: InferColumn<C[K]>;
};
export type UpdateValues<C extends ColumnMap, Scope extends string = string> = {
  [K in keyof C]?: InferColumn<C[K]> | Expression<InferColumn<C[K]>, Scope>;
};
export type InsertSource<C extends ColumnMap, Row> = [Exclude<keyof Row, keyof C>] extends [never]
  ? Row extends InsertValues<C>
    ? unknown
    : never
  : never;
export interface MutationQuery {
  readonly kind: 'mutation';
  readonly ast: StatementNode;
  compile(): CompiledQuery;
}
export interface FilteredMutation<Scope extends string> extends MutationQuery {
  where(predicate: Predicate<Scope>): FilteredMutation<Scope>;
}
export interface MergeQuery<
  C extends ColumnMap,
  Scope extends string,
  Source extends string = Scope,
> extends MutationQuery {
  whenMatchedUpdate(
    values: UpdateValues<C, Scope>,
    condition?: Predicate<Scope>,
  ): MergeQuery<C, Scope, Source>;
  whenMatchedDelete(condition?: Predicate<Scope>): MergeQuery<C, Scope, Source>;
  whenNotMatchedInsert(
    values: {
      [K in keyof InsertValues<C>]: InsertValues<C>[K] | Expression<InsertValues<C>[K], Source>;
    },
    condition?: Predicate<Source>,
  ): MergeQuery<C, Scope, Source>;
}

function checkTable(table: Table): void {
  if (table.source.kind !== 'table') throw new TypeError('Mutations require a base table.');
}
function checkSource(target: Table, source: Table): void {
  checkTable(target);
  if (source.source.kind !== 'table' && source.source.kind !== 'derived')
    throw new TypeError('Mutation sources must be tables or derived queries.');
  if (target.ref.name === source.ref.name)
    throw new TypeError('Mutation sources need distinct names.');
}
function condition(predicate: Predicate, refs: readonly SourceReference[], clause: string) {
  assertScope([predicate], refs);
  if (predicate.phase !== 'scalar') throw new TypeError(`${clause} must be scalar.`);
  return predicate.expression;
}
function mutation(ast: StatementNode): MutationQuery {
  return Object.freeze({ kind: 'mutation', ast, compile: () => compileAst(ast) });
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

export function insertFrom<
  C extends ColumnMap,
  S extends Selection,
  Scope extends string,
  Nullable extends string,
>(
  table: Table<C>,
  query: SelectQuery<S, Scope, Nullable> & InsertSource<C, InferSelection<S, Nullable>>,
): MutationQuery {
  checkTable(table);
  query.compile();
  const keys = Object.keys(query.selection);
  for (const key of keys)
    if (!Object.hasOwn(table.columns, key)) throw new TypeError(`Unknown mutation column: ${key}`);
  for (const [key, column] of Object.entries(table.columns))
    if (column.required && !keys.includes(key))
      throw new TypeError(`INSERT source is missing required column: ${key}`);
  return mutation(
    Object.freeze({
      kind: 'insert',
      table: table.node,
      columns: Object.freeze(keys.map((key) => (table.columns[key] as AnyColumn).node)),
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
      const where = condition(predicate, refs, 'Mutation filters');
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
  const join = condition(on, refs, 'UPDATE FROM join predicates');
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
export function deleteFrom<C extends ColumnMap, N extends string>(
  table: Table<C, N>,
): FilteredMutation<N> {
  checkTable(table);
  return filtered([table.ref], Object.freeze({ kind: 'delete', table: table.node }));
}
export function deleteUsing<
  C extends ColumnMap,
  T extends string,
  S extends ColumnMap,
  N extends string,
>(target: Table<C, T>, source: Table<S, N>, on: Predicate<T | N>): FilteredMutation<T | N> {
  checkSource(target, source);
  const refs = [target.ref, source.ref];
  const join = condition(on, refs, 'DELETE USING join predicates');
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
    on: condition(on, refs, 'MERGE match predicates'),
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
    return predicate ? { condition: condition(predicate, scope, 'MERGE branch conditions') } : {};
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
        for (const key of Object.keys(values))
          if (!Object.hasOwn(target.columns, key))
            throw new TypeError(`Unknown mutation column: ${key}`);
        const completed = Object.fromEntries(
          Object.keys(target.columns).map((key) => [
            key,
            Object.hasOwn(values, key) ? values[key] : null,
          ]),
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
