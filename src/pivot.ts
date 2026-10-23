import * as z from 'zod';
import {
  compileAst,
  identifier,
  type PivotLiteral,
  type PivotNode,
  type SelectNode,
  type UnpivotNode,
} from './ast.js';
import { type AnyExpression, count, expression, max, min, sum } from './expressions.js';
import { select } from './query.js';
import {
  type AnyColumn,
  type BoundColumns,
  bindTable,
  type Column,
  type ColumnMap,
  type DataType,
  type InferColumn,
  type Table,
} from './schema.js';
import type { RawQuery } from './sql.js';

export type PivotAggregate = 'sum' | 'min' | 'max' | 'count';
export type PivotValue<A extends PivotAggregate, C> = A extends 'count'
  ? bigint
  : A extends 'sum'
    ? string
    : NonNullable<InferColumn<C>>;
type Key<C> = keyof C & string;
type Collisions<T, Taken> = { readonly [K in Extract<keyof T, Taken>]: never };

interface PivotInput<C extends ColumnMap, A extends PivotAggregate, V extends Key<C>, F, D> {
  readonly aggregate: A;
  readonly value: V;
  readonly for: F;
  /** Replaces missing groups; the pivoted columns become non-null. */
  readonly default?: D;
}
export interface PivotOptions<
  C extends ColumnMap,
  A extends PivotAggregate,
  V extends Key<C>,
  F extends Key<C>,
  In,
  D,
> extends PivotInput<C, A, V, F, D> {
  /** Output column names mapped to values of the `for` column. */
  readonly in: In;
}
export type PivotColumns<
  C extends ColumnMap,
  A extends PivotAggregate,
  V extends Key<C>,
  F extends Key<C>,
  In,
  D,
> = Omit<C, V | F> & {
  readonly [K in keyof In]: Column<
    PivotValue<A, C[V]>,
    A extends 'count' ? true : [D] extends [undefined] ? false : true
  >;
};
export interface UnpivotOptions<
  C extends ColumnMap,
  In extends readonly Key<C>[],
  V extends string,
  F extends string,
  I extends boolean,
> {
  readonly value: V;
  /** The output column holding each unpivoted column's key. */
  readonly for: F;
  readonly in: In;
  readonly includeNulls?: I;
}
type UnpivotValue<U, I extends boolean> = I extends true
  ? Column<NonNullable<U>, null extends U ? false : true>
  : Column<NonNullable<U>, true>;
export type UnpivotColumns<
  C extends ColumnMap,
  In extends readonly Key<C>[],
  V extends string,
  F extends string,
  I extends boolean,
> = Omit<C, In[number]> & { readonly [K in V]: UnpivotValue<InferColumn<C[In[number]]>, I> } & {
  readonly [K in F]: Column<In[number], true>;
};

function nonNull<T>(schema: z.ZodType<T>): z.ZodType<T> {
  return schema.refine((value) => value !== null, 'Expected a non-null value.');
}
function rename(key: string, value: AnyColumn): AnyColumn {
  return Object.freeze({
    ...value,
    node: identifier(key),
    notNull: () => rename(key, value.notNull()) as Column<unknown, true>,
  });
}
function output(
  key: string,
  base: AnyExpression,
  dataType: DataType,
  nullable: boolean,
  read = base.readSchema,
  value = base.valueSchema,
): AnyColumn {
  const node = identifier(key);
  return Object.freeze({
    ...expression(node, nullable ? read : nonNull(read), {
      valueSchema: nullable ? value : nonNull(value),
      ...(base.wireType ? { wireType: base.wireType } : {}),
      encode: (parsed: unknown) => base.encode(parsed),
    }),
    node,
    dataType,
    required: !nullable,
    notNull: () => output(key, base, dataType, false, read, value) as Column<unknown, true>,
  });
}
function input(source: Table): SelectNode {
  if (source.dependencies.length)
    throw new TypeError('PIVOT and UNPIVOT sources cannot depend on other sources.');
  return select(source).ast;
}
function column(source: Table, key: string, clause: string): AnyColumn {
  const value = Object.hasOwn(source.columns, key) ? source.columns[key] : undefined;
  if (!value) throw new TypeError(`Unknown ${clause} column: ${key}`);
  return value;
}
function claim(taken: Set<string>, key: string): void {
  identifier(key);
  if (key === '__proto__') throw new TypeError('Reserved column name.');
  if (taken.has(key)) throw new TypeError(`Duplicate output column: ${key}`);
  taken.add(key);
}

function aggregation(
  source: Table,
  name: string,
  options: PivotInput<ColumnMap, PivotAggregate, string, string, unknown>,
) {
  const value = column(source, options.value, 'PIVOT value');
  const by = column(source, options.for, 'PIVOT for');
  if (options.value === options.for)
    throw new TypeError('PIVOT value and for columns must differ.');
  let aggregate: AnyExpression;
  switch (options.aggregate) {
    case 'sum':
      if (!['integer', 'decimal', 'float'].includes(value.wireType as string))
        throw new TypeError('PIVOT sum requires a numeric value column.');
      aggregate = sum(value as Column<string>);
      break;
    case 'min':
      aggregate = min(value);
      break;
    case 'max':
      aggregate = max(value);
      break;
    case 'count':
      aggregate = count(value);
      break;
    default:
      throw new TypeError('Unsupported PIVOT aggregate.');
  }
  if (options.default === null) throw new TypeError('A PIVOT default cannot be null.');
  if (
    options.aggregate === 'sum' &&
    options.default !== undefined &&
    !/^-?\d+(?:\.\d+)?$/.test(String(options.default))
  )
    throw new TypeError('A PIVOT sum default must be decimal text.');
  const groups = Object.entries(source.columns).filter(
    ([key]) => key !== options.value && key !== options.for,
  );
  const node = {
    source: input(source),
    aggregate: options.aggregate.toUpperCase() as PivotNode['aggregate'],
    value: identifier(options.value),
    for: identifier(options.for),
    ...(options.default === undefined ? {} : { default: aggregate.encode(options.default) }),
    alias: identifier(name),
  };
  return { aggregate, value, by, groups, node };
}

/** Pivots declared values of one column into typed columns; other source columns group rows. */
export function pivot<
  C extends ColumnMap,
  const N extends string,
  A extends PivotAggregate,
  V extends Key<C>,
  F extends Exclude<Key<C>, V>,
  const In extends Readonly<Record<string, NonNullable<InferColumn<C[F]>>>>,
  D extends PivotValue<A, C[V]> | undefined = undefined,
>(
  source: Table<C>,
  name: N,
  options: PivotOptions<C, A, V, F, In & Collisions<In, Exclude<keyof C, V | F>>, D>,
): Table<BoundColumns<PivotColumns<C, A, V, F, In, D>, N>, N>;
export function pivot(
  source: Table,
  name: string,
  options: PivotOptions<
    ColumnMap,
    PivotAggregate,
    string,
    string,
    Readonly<Record<string, unknown>>,
    unknown
  >,
): Table {
  const { aggregate, value: measure, by, groups, node } = aggregation(source, name, options);
  const entries = Object.entries(options.in);
  if (!entries.length) throw new TypeError('PIVOT needs at least one value.');
  const taken = new Set<string>();
  const literals = new Set<string>();
  const values = entries.map(([key, value]) => {
    if (groups.some(([group]) => group === key))
      throw new TypeError(`PIVOT column collides with a grouping column: ${key}`);
    claim(taken, key);
    const encoded = by.encode(value);
    if (encoded.kind !== 'parameter' || encoded.value === null)
      throw new TypeError('PIVOT values must be non-null scalars.');
    const literal: PivotLiteral = encoded.value;
    if (literals.has(`${typeof literal}:${literal}`))
      throw new TypeError(`Duplicate PIVOT value: ${String(literal)}`);
    literals.add(`${typeof literal}:${literal}`);
    return literal;
  });
  const nullable = options.aggregate !== 'count' && options.default === undefined;
  const dataType: DataType =
    options.aggregate === 'count'
      ? 'integer'
      : options.aggregate === 'sum'
        ? 'decimal'
        : measure.dataType;
  const columns = Object.fromEntries([
    ...groups.map(([key, value]) => [key, rename(key, value)]),
    ...entries.map(([key]) => [key, output(key, aggregate, dataType, nullable)]),
  ]);
  const relation: PivotNode = Object.freeze({
    kind: 'pivot',
    ...node,
    values: Object.freeze(values),
    columns: Object.freeze(Object.keys(columns).map((key) => identifier(key))),
  });
  return bindTable(identifier(name), columns, relation, name);
}

/**
 * PIVOT ... IN (ANY): output columns are only known at execution, so the result is
 * an unvalidated raw query whose row type defaults to unknown.
 */
export function dynamicPivot<
  C extends ColumnMap,
  A extends PivotAggregate,
  V extends Key<C>,
  F extends Exclude<Key<C>, V>,
>(
  source: Table<C>,
  name: string,
  options: PivotInput<C, A, V, F, PivotValue<A, C[V]>> & { readonly order?: 'asc' | 'desc' },
): RawQuery<unknown>;
export function dynamicPivot(
  source: Table,
  name: string,
  options: PivotInput<ColumnMap, PivotAggregate, string, string, unknown> & {
    readonly order?: 'asc' | 'desc';
  },
): RawQuery<unknown> {
  const { node } = aggregation(source, name, options);
  const relation: PivotNode = Object.freeze({
    kind: 'pivot',
    ...node,
    values: Object.freeze(
      options.order
        ? { kind: 'any', direction: options.order === 'asc' ? 'ASC' : 'DESC' }
        : { kind: 'any' },
    ),
  });
  const compiled = compileAst(
    Object.freeze({ kind: 'select', from: relation, projections: Object.freeze([]) }),
  );
  return Object.freeze({
    kind: 'raw',
    strings: Object.freeze([compiled.sql]),
    values: Object.freeze([]),
    compile: () => compiled,
  });
}

/** Rotates same-typed columns into rows of (`for` = column key, `value` = column value). */
export function unpivot<
  C extends ColumnMap,
  const N extends string,
  const In extends readonly [Key<C>, ...Key<C>[]],
  const V extends string,
  const F extends string,
  I extends boolean = false,
>(
  source: Table<C>,
  name: N,
  options: UnpivotOptions<C, In, V, F, I>,
): Table<BoundColumns<UnpivotColumns<C, In, V, F, I>, N>, N>;
export function unpivot(
  source: Table,
  name: string,
  options: UnpivotOptions<ColumnMap, readonly string[], string, string, boolean>,
): Table {
  if (!options.in.length) throw new TypeError('UNPIVOT needs at least one column.');
  if (new Set(options.in).size !== options.in.length)
    throw new TypeError('UNPIVOT columns must be distinct.');
  const values = options.in.map((key) => column(source, key, 'UNPIVOT'));
  const first = values[0] as AnyColumn;
  const domain = (value: AnyColumn) => value.wireType ?? value.dataType;
  if (values.some((value) => domain(value) !== domain(first)))
    throw new TypeError('UNPIVOT columns must share one type.');
  const groups = Object.entries(source.columns).filter(([key]) => !options.in.includes(key));
  const taken = new Set(groups.map(([key]) => key));
  claim(taken, options.value);
  claim(taken, options.for);
  const includeNulls = options.includeNulls ?? false;
  const union = <T>(schemas: z.ZodType<T>[]) => z.union(schemas as [z.ZodType<T>, z.ZodType<T>]);
  const read = union(values.map((value) => value.readSchema));
  const valueSchema = union(values.map((value) => value.valueSchema));
  const base = expression(identifier(options.value), read, {
    valueSchema,
    ...(first.wireType ? { wireType: first.wireType } : {}),
    encode: (parsed: unknown) =>
      (values.find((value) => value.valueSchema.safeParse(parsed).success) as AnyColumn).encode(
        parsed,
      ),
  });
  const keys = z.enum(options.in as [string, ...string[]]);
  const label: AnyColumn = Object.freeze({
    ...expression(identifier(options.for), keys),
    node: identifier(options.for),
    dataType: 'text',
    required: true,
    notNull: () => label as Column<unknown, true>,
  });
  const columns = Object.fromEntries([
    ...groups.map(([key, value]) => [key, rename(key, value)]),
    [
      options.value,
      output(
        options.value,
        base,
        first.dataType,
        includeNulls && values.some((value) => value.readSchema.safeParse(null).success),
      ),
    ],
    [options.for, label],
  ]);
  const relation: UnpivotNode = Object.freeze({
    kind: 'unpivot',
    source: input(source),
    value: identifier(options.value),
    name: identifier(options.for),
    columns: Object.freeze(options.in.map((key) => identifier(key))),
    includeNulls,
    alias: identifier(name),
  });
  return bindTable(identifier(name), columns, relation, name);
}
