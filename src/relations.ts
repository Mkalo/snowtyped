import { type AnyExpression, type Expression, inArray } from './expressions.js';
import { narrow, type SelectQuery, sameNode, select } from './query.js';
import {
  type ColumnMap,
  type InferSelection,
  isLeaf,
  type Projection,
  type Table,
} from './schema.js';

/** The SQL types relation keys can have, whose decoded values identify a row unambiguously. */
export type RelationKeyType = 'integer' | 'decimal' | 'text' | 'date';
/** Whether a parent row has at most one related row (`'one'`) or any number (`'many'`). */
export type RelationCardinality = 'one' | 'many';
type AnySelect = SelectQuery<Projection, string, string>;
interface ChildQuery {
  readonly kind: 'select' | 'loaded';
  readonly rowType?: unknown;
}
type Runtime = AnySelect | LoadedQuery<unknown>;
type ChildRow<Q> = Q extends { readonly rowType?: infer R } ? R : never;

/** A relation declared with {@link one} or {@link many}, loaded by {@link withRelations}. */
export interface Relation<
  C extends RelationCardinality = RelationCardinality,
  Row = unknown,
  Parent extends string = string,
> {
  /** Identifies a relation. */
  readonly kind: 'relation';
  /** Whether a parent has at most one related row or any number. */
  readonly cardinality: C;
  /** The parent's key. */
  readonly from: AnyExpression;
  /** The related table's key, matched against the parent's. */
  readonly to: AnyExpression;
  /** The related query, before it is filtered by parent keys. */
  readonly query: ChildQuery;
  /** @internal */
  readonly rowType?: Row;
  /** @internal */
  readonly parentScopeType?: Parent;
}
/**
 * The value a relation adds to each parent row: an array for `many`, an object or `null` for `one`.
 */
export type RelationRow<R> =
  R extends Relation<infer C, infer Row> ? (C extends 'many' ? Row[] : Row | null) : never;
type Simplify<T> = { [K in keyof T]: T[K] };
/** A parent row with its loaded relations. */
export type LoadedRow<Row, R> = Simplify<Row & { -readonly [K in keyof R]: RelationRow<R[K]> }>;
/** A query with relations, created by {@link withRelations}. Execute or stream it with a client. */
export interface LoadedQuery<Row> {
  /** Identifies a query with relations. */
  readonly kind: 'loaded';
  /** The parent query. */
  readonly query: AnySelect;
  /** The relations, keyed by the property they add to parent rows. */
  readonly relations: Readonly<Record<string, Relation>>;
  /** The number of distinct parent keys per related query. */
  readonly batchSize: number;
  /** @internal */
  readonly rowType?: Row;
}
/** Options of {@link withRelations}. */
export interface LoadOptions {
  /**
   * Distinct parent keys per related query, from 1 to 16384 and 1000 by default. Streams also load
   * children per this many parents.
   */
  readonly batchSize?: number;
}

function relation(
  cardinality: RelationCardinality,
  table: Table,
  keys: { readonly from: AnyExpression; readonly to: AnyExpression },
  query: ((rows: AnySelect) => ChildQuery) | undefined,
): Relation {
  for (const key of [keys.from, keys.to])
    if (!['integer', 'decimal', 'text', 'date'].includes(key.dataType))
      throw new TypeError(
        `Relation keys must be INTEGER, DECIMAL, TEXT, or DATE, not ${key.dataType.toUpperCase()}.`,
      );
  if (keys.from.dataType !== keys.to.dataType)
    throw new TypeError('Relation keys must share one SQL type.');
  if (keys.from.phase !== 'scalar' || keys.to.phase !== 'scalar')
    throw new TypeError('Relation keys must be scalar expressions.');
  const base = select(table) as unknown as AnySelect;
  const child = (query ? query(base) : base) as Runtime;
  const parent = child.kind === 'loaded' ? child.query : child;
  if (parent.ast.limit !== undefined || parent.ast.offset !== undefined)
    throw new TypeError(
      'Related queries cannot use LIMIT or OFFSET across parents; use QUALIFY with rowNumber() partitioned by the key.',
    );
  narrow(parent, inArray(keys.to as Expression<unknown, string, string, 'integer'>, []));
  return Object.freeze({ kind: 'relation', cardinality, ...keys, query: child });
}

/**
 * Declares that each parent row has at most one row of `table` whose `to` key equals the parent's
 * `from` key.
 *
 * Keys must be INTEGER, DECIMAL, TEXT, or DATE values of one shared SQL type. The optional `query`
 * callback shapes the related query: project, filter, join, order, or nest relations with
 * {@link withRelations}. It cannot use `.limit()` or `.offset()`, which would cut across parents.
 *
 * @throws `TypeError` when the keys have unsupported or different types, or the related query is
 * paginated.
 * @example
 * ```ts
 * const customer = one(customers, { from: orders.columns.customerId, to: customers.columns.id });
 * withRelations(select(orders), { customer });
 * ```
 */
export function one<
  C extends ColumnMap,
  N extends string,
  P extends string,
  D extends RelationKeyType,
  Q extends ChildQuery = SelectQuery<C, N>,
>(
  table: Table<C, N>,
  keys: {
    readonly from: Expression<unknown, P, string, D>;
    readonly to: Expression<unknown, NoInfer<N>, string, NoInfer<D>>;
  },
  query?: (rows: SelectQuery<C, N>) => Q,
): Relation<'one', ChildRow<Q>, P> {
  return relation('one', table, keys, query as never) as Relation<'one', ChildRow<Q>, P>;
}
/**
 * Declares that each parent row has any number of rows of `table` whose `to` key equals the
 * parent's `from` key.
 *
 * Accepts the same keys and `query` callback as {@link one}. For a per-parent limit, use
 * `.qualify()` with {@link rowNumber} partitioned by the `to` key.
 *
 * @example
 * ```ts
 * const customerOrders = many(
 *   orders,
 *   { from: customers.columns.id, to: orders.columns.customerId },
 *   (rows) => rows.orderBy(asc(orders.columns.id)),
 * );
 * ```
 */
export function many<
  C extends ColumnMap,
  N extends string,
  P extends string,
  D extends RelationKeyType,
  Q extends ChildQuery = SelectQuery<C, N>,
>(
  table: Table<C, N>,
  keys: {
    readonly from: Expression<unknown, P, string, D>;
    readonly to: Expression<unknown, NoInfer<N>, string, NoInfer<D>>;
  },
  query?: (rows: SelectQuery<C, N>) => Q,
): Relation<'many', ChildRow<Q>, P> {
  return relation('many', table, keys, query as never) as Relation<'many', ChildRow<Q>, P>;
}

/**
 * Adds relations to a query as properties of its rows.
 *
 * The parent query runs once and keeps its own pagination, grouping, and row count. Each relation
 * then runs one query per batch of distinct parent keys, as `WHERE to IN (...)` added to the
 * related query's filter. Executing the result returns every statement's ID in `queryIds`, parent
 * first.
 *
 * A key the parent does not project is added as a hidden column and removed from the rows, except
 * in DISTINCT queries, which must project it.
 *
 * @param relations - Relations keyed by the property they add, which cannot repeat a projection
 * key.
 * @throws `TypeError` when there are no relations or the batch size is not from 1 to 16384.
 * @example
 * ```ts
 * const customerOrders = many(orders, {
 *   from: customers.columns.id,
 *   to: orders.columns.customerId,
 * });
 * const page = withRelations(select(customers).limit(20), { orders: customerOrders });
 * const { rows, queryIds } = await db.execute(page);
 * ```
 */
export function withRelations<
  S extends Projection,
  Scope extends string,
  Nullable extends string,
  const R extends Readonly<Record<string, Relation<RelationCardinality, unknown, Scope>>>,
>(
  query: SelectQuery<S, Scope, Nullable>,
  relations: R & {
    readonly [K in keyof R & keyof S]: { readonly relationNameRepeatsAProjectionKey: K };
  },
  options: LoadOptions = {},
): LoadedQuery<LoadedRow<InferSelection<S, Nullable>, R>> {
  const batchSize = options.batchSize ?? 1000;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 16384)
    throw new TypeError('Relation batch size must be an integer from 1 to 16384.');
  const names = Object.keys(relations);
  if (!names.length) throw new TypeError('withRelations needs at least one relation.');
  for (const name of names) {
    if (name === '__proto__') throw new TypeError('Reserved relation name.');
    if (Object.hasOwn(query.selection, name))
      throw new TypeError(`Relation ${name} repeats a projection key.`);
    const value = (relations as Record<string, Relation>)[name];
    if (value?.kind !== 'relation') throw new TypeError(`${name} is not a relation.`);
  }
  const loaded = Object.freeze({
    kind: 'loaded',
    query: query as unknown as AnySelect,
    relations: Object.freeze({ ...relations }) as Readonly<Record<string, Relation>>,
    batchSize,
  });
  plan(loaded);
  return loaded as LoadedQuery<LoadedRow<InferSelection<S, Nullable>, R>>;
}

interface Plan {
  readonly query: AnySelect;
  /** Aliases added only to match rows, removed from decoded rows. */
  readonly hidden: readonly string[];
  readonly batchSize: number;
  readonly relations: readonly {
    readonly name: string;
    readonly value: Relation;
    /** Top-level aliases holding the keys. */
    readonly from: string;
    readonly to: string;
    readonly query: AnySelect;
    /** Hidden keys of the related rows, removed once they are matched. */
    readonly hidden: readonly string[];
    readonly child?: Plan;
  }[];
}
/**
 * Projects every key rows are matched by, reusing top-level leaves and hiding the rest. A leaf
 * inside a nested object can read NULL when its object collapses, so it is never reused.
 */
function keyed(query: AnySelect, keys: readonly AnyExpression[], names: readonly string[]) {
  const extra: Record<string, AnyExpression> = {};
  const used = new Set([...Object.keys(query.selection), ...names]);
  const paths = keys.map((key) => {
    const leaf = Object.entries(query.selection).find(
      ([, value]) => isLeaf(value) && sameNode(value.expression, key.expression),
    );
    if (leaf) return leaf[0];
    const existing = Object.entries(extra).find(([, value]) =>
      sameNode(value.expression, key.expression),
    );
    if (existing) return existing[0];
    let alias = '__sflib_key';
    while (used.has(alias)) alias += '_';
    used.add(alias);
    extra[alias] = key;
    return alias;
  });
  const hidden = Object.keys(extra);
  if (!hidden.length) return { query, paths, hidden };
  if (query.ast.distinct)
    throw new TypeError('A DISTINCT query must project the keys its relations match on.');
  const next = query.select({ ...query.selection, ...extra } as never) as unknown as AnySelect;
  next.compile();
  return { query: next, paths, hidden };
}
const plans = new WeakMap<object, Plan>();
function plan(loaded: LoadedQuery<unknown>): Plan {
  const cached = plans.get(loaded);
  if (cached) return cached;
  const entries = Object.entries(loaded.relations);
  const parent = keyed(
    loaded.query,
    entries.map(([, value]) => value.from),
    entries.map(([name]) => name),
  );
  const result: Plan = {
    query: parent.query,
    hidden: parent.hidden,
    batchSize: loaded.batchSize,
    relations: entries.map(([name, value], index) => {
      const related = value.query as Runtime;
      const inner = related.kind === 'loaded' ? plan(related) : undefined;
      const target = inner
        ? keyed(inner.query, [value.to], Object.keys((related as LoadedQuery<unknown>).relations))
        : keyed(related as AnySelect, [value.to], []);
      return {
        name,
        value,
        from: parent.paths[index] as string,
        to: target.paths[0] as string,
        query: target.query,
        hidden: [...(inner?.hidden ?? []), ...target.hidden],
        ...(inner ? { child: inner } : {}),
      };
    }),
  };
  plans.set(loaded, result);
  return result;
}

/** Decoded keys compare by value; DECIMAL text can differ in scale only. */
function canonical(value: unknown, type: string): string {
  const text = String(value);
  if (type !== 'decimal') return text;
  const [, sign, whole, fraction] = /^(-?)0*(\d+?)(?:\.(\d*?)0*)?$/.exec(text) as RegExpExecArray;
  const number = `${whole}${fraction ? `.${fraction}` : ''}`;
  return number === '0' ? '0' : `${sign}${number}`;
}
function strip(rows: readonly Record<string, unknown>[], hidden: readonly string[]) {
  for (const row of rows) for (const alias of hidden) delete row[alias];
}

export type Execute = (query: AnySelect) => Promise<{ rows: readonly unknown[]; queryId: string }>;

async function fetch(
  current: Plan,
  query: AnySelect,
  execute: Execute,
  queryIds: string[],
): Promise<Record<string, unknown>[]> {
  const result = await execute(query);
  queryIds.push(result.queryId);
  const rows = result.rows as Record<string, unknown>[];
  await attach(current, rows, execute, queryIds);
  return rows;
}
/** Leaves each plan's hidden keys in place; the caller strips them after matching. */
async function attach(
  current: Plan,
  rows: Record<string, unknown>[],
  execute: Execute,
  queryIds: string[],
): Promise<void> {
  for (const item of current.relations) {
    const parentKeys = rows.map((row) => row[item.from] ?? null);
    const distinct = new Map<string, unknown>();
    const type = item.value.to.dataType;
    for (const key of parentKeys) if (key !== null) distinct.set(canonical(key, type), key);
    const values = [...distinct.values()];
    const matched = new Map<string, Record<string, unknown>[]>();
    for (let start = 0; start < values.length; start += current.batchSize) {
      const query = narrow(
        item.query,
        inArray(
          item.value.to as Expression<unknown, string, string, 'integer'>,
          values.slice(start, start + current.batchSize) as never[],
        ),
      );
      const found = item.child
        ? await fetch(item.child, query, execute, queryIds)
        : await execute(query).then((result) => {
            queryIds.push(result.queryId);
            return result.rows as Record<string, unknown>[];
          });
      for (const row of found) {
        const id = canonical(row[item.to], type);
        const list = matched.get(id);
        if (list) list.push(row);
        else matched.set(id, [row]);
      }
      strip(found, item.hidden);
    }
    rows.forEach((row, index) => {
      const key = parentKeys[index];
      const list = key === null ? [] : (matched.get(canonical(key, type)) ?? []);
      if (item.value.cardinality === 'many') row[item.name] = [...list];
      else if (list.length > 1)
        throw new TypeError(
          `Relation ${item.name} matched ${list.length} rows for one parent key.`,
        );
      else row[item.name] = list[0] ?? null;
    });
  }
}

export interface Executed {
  readonly rows: readonly unknown[];
  readonly queryIds: readonly string[];
}
/** Runs the parent query, then each relation's batches in declaration order. */
export async function run(loaded: LoadedQuery<unknown>, execute: Execute): Promise<Executed> {
  const current = plan(loaded);
  const queryIds: string[] = [];
  const rows = await fetch(current, current.query, execute, queryIds);
  strip(rows, current.hidden);
  return { rows, queryIds };
}
/** Streams parents and loads their relations per batch of parent rows. */
export async function* stream(
  loaded: LoadedQuery<unknown>,
  parents: (query: AnySelect) => AsyncIterable<unknown>,
  execute: Execute,
): AsyncGenerator<unknown> {
  const current = plan(loaded);
  let batch: Record<string, unknown>[] = [];
  const flush = async () => {
    await attach(current, batch, execute, []);
    strip(batch, current.hidden);
    const rows = batch;
    batch = [];
    return rows;
  };
  for await (const row of parents(current.query)) {
    batch.push(row as Record<string, unknown>);
    if (batch.length === current.batchSize) yield* await flush();
  }
  if (batch.length) yield* await flush();
}
