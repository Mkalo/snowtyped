import * as z from 'zod';
import type {
  BinaryNode,
  ExpressionNode,
  FrameBoundaryNode,
  IntervalUnit,
  OrderNode,
  SourceReference,
  WindowFrameNode,
  WireType,
} from './ast.js';

export interface Expression<
  T = unknown,
  Scope extends string = string,
  NullScope extends string = Scope,
> {
  readonly expression: ExpressionNode;
  readonly readSchema: z.ZodType<T>;
  readonly valueSchema: z.ZodType<T>;
  readonly refs: readonly SourceReference[];
  readonly nullRefs: readonly SourceReference[];
  readonly phase: 'scalar' | 'aggregate' | 'window';
  readonly wireType?: WireType;
  readonly scopeType?: Scope;
  readonly nullScopeType?: NullScope;
  encode(value: T): ExpressionNode;
}
export type AnyExpression = Expression<unknown, string, string>;
export type InferExpression<E> = E extends Expression<infer T, string, string> ? T : never;
export type ExpressionScope<E> = E extends Expression<unknown, infer S, string> ? S : never;
export type ExpressionNullScope<E> = E extends Expression<unknown, string, infer S> ? S : never;
export type Predicate<S extends string = string> = Expression<boolean | null, S>;

export function scalarParameter(value: unknown): ExpressionNode {
  if (typeof value === 'bigint')
    return Object.freeze({ kind: 'parameter', value: value.toString() });
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return Object.freeze({ kind: 'parameter', value });
  if (typeof value === 'number' && Number.isFinite(value))
    return Object.freeze({ kind: 'parameter', value });
  throw new TypeError('Unsupported expression parameter.');
}
export function expression<T, S extends string = never, N extends string = S>(
  node: ExpressionNode,
  readSchema: z.ZodType<T>,
  options: {
    readonly valueSchema?: z.ZodType<T>;
    readonly refs?: readonly SourceReference[];
    readonly nullRefs?: readonly SourceReference[];
    readonly phase?: AnyExpression['phase'];
    readonly wireType?: WireType;
    readonly encode?: (value: T) => ExpressionNode;
  } = {},
): Expression<T, S, N> {
  const valueSchema = options.valueSchema ?? readSchema;
  return Object.freeze({
    expression: Object.freeze(node),
    readSchema,
    valueSchema,
    refs: Object.freeze([...(options.refs ?? [])]),
    nullRefs: Object.freeze([...(options.nullRefs ?? options.refs ?? [])]),
    phase: options.phase ?? 'scalar',
    ...(options.wireType ? { wireType: options.wireType } : {}),
    encode(value: T) {
      const parsed = valueSchema.parse(value);
      return options.encode ? options.encode(parsed) : scalarParameter(parsed);
    },
  });
}
export function isExpression(value: unknown): value is AnyExpression {
  return typeof value === 'object' && value !== null && 'expression' in value;
}
function metadata(values: readonly AnyExpression[]) {
  return {
    refs: [...new Set(values.flatMap((value) => value.refs))],
    phase: values.some((value) => value.phase === 'window')
      ? ('window' as const)
      : values.some((value) => value.phase === 'aggregate')
        ? ('aggregate' as const)
        : ('scalar' as const),
  };
}
function comparison<L extends AnyExpression, R>(
  operator: BinaryNode['operator'],
  left: L,
  right: R,
): Predicate<ExpressionScope<L> | ExpressionScope<R>> {
  const values = isExpression(right) ? [left, right] : [left];
  if (right === null && (operator === '=' || operator === '<>')) {
    left.valueSchema.parse(right);
    return expression(
      {
        kind: 'unary',
        operator: operator === '=' ? 'IS NULL' : 'IS NOT NULL',
        operand: left.expression,
      },
      z.boolean(),
      metadata(values),
    );
  }
  return expression(
    {
      kind: 'binary',
      operator,
      left: left.expression,
      right: isExpression(right) ? right.expression : left.encode(right),
    },
    z.boolean().nullable(),
    metadata(values),
  );
}
export function eq<
  L extends AnyExpression,
  R extends
    | NoInfer<InferExpression<L>>
    | Expression<NonNullable<NoInfer<InferExpression<L>>> | null>,
>(left: L, right: R): Predicate<ExpressionScope<L> | ExpressionScope<R>> {
  return comparison('=', left, right);
}
export function ne<
  L extends AnyExpression,
  R extends
    | NoInfer<InferExpression<L>>
    | Expression<NonNullable<NoInfer<InferExpression<L>>> | null>,
>(left: L, right: R): Predicate<ExpressionScope<L> | ExpressionScope<R>> {
  return comparison('<>', left, right);
}
export function gt<
  L extends AnyExpression,
  R extends
    | NoInfer<InferExpression<L>>
    | Expression<NonNullable<NoInfer<InferExpression<L>>> | null>,
>(left: L, right: R): Predicate<ExpressionScope<L> | ExpressionScope<R>> {
  return comparison('>', left, right);
}
export function gte<
  L extends AnyExpression,
  R extends
    | NoInfer<InferExpression<L>>
    | Expression<NonNullable<NoInfer<InferExpression<L>>> | null>,
>(left: L, right: R): Predicate<ExpressionScope<L> | ExpressionScope<R>> {
  return comparison('>=', left, right);
}
export function lt<
  L extends AnyExpression,
  R extends
    | NoInfer<InferExpression<L>>
    | Expression<NonNullable<NoInfer<InferExpression<L>>> | null>,
>(left: L, right: R): Predicate<ExpressionScope<L> | ExpressionScope<R>> {
  return comparison('<', left, right);
}
export function lte<
  L extends AnyExpression,
  R extends
    | NoInfer<InferExpression<L>>
    | Expression<NonNullable<NoInfer<InferExpression<L>>> | null>,
>(left: L, right: R): Predicate<ExpressionScope<L> | ExpressionScope<R>> {
  return comparison('<=', left, right);
}
export function like<S extends string>(
  left: Expression<string | null, S>,
  pattern: string,
): Predicate<S> {
  return expression(
    { kind: 'binary', operator: 'LIKE', left: left.expression, right: left.encode(pattern) },
    z.boolean().nullable(),
    metadata([left]),
  );
}
export function ilike<S extends string>(
  left: Expression<string | null, S>,
  pattern: string,
): Predicate<S> {
  return expression(
    { kind: 'binary', operator: 'ILIKE', left: left.expression, right: left.encode(pattern) },
    z.boolean().nullable(),
    metadata([left]),
  );
}
function logical<S extends string>(
  operator: 'AND' | 'OR',
  values: readonly Predicate<S>[],
): Predicate<S> {
  if (!values.length) throw new TypeError(`${operator} requires at least one predicate.`);
  return expression(
    { kind: 'logical', operator, operands: Object.freeze(values.map((value) => value.expression)) },
    z.boolean().nullable(),
    metadata(values),
  );
}
export function and<S extends string>(...values: readonly Predicate<S>[]): Predicate<S> {
  return logical('AND', values);
}
export function or<S extends string>(...values: readonly Predicate<S>[]): Predicate<S> {
  return logical('OR', values);
}
export function not<S extends string>(value: Predicate<S>): Predicate<S> {
  return expression(
    { kind: 'unary', operator: 'NOT', operand: value.expression },
    z.boolean().nullable(),
    metadata([value]),
  );
}
export function isNull<E extends AnyExpression>(
  value: E,
): Expression<boolean, ExpressionScope<E>, never> {
  return expression(
    { kind: 'unary', operator: 'IS NULL', operand: value.expression },
    z.boolean(),
    { ...metadata([value]), nullRefs: [] },
  );
}
export function isNotNull<E extends AnyExpression>(
  value: E,
): Expression<boolean, ExpressionScope<E>, never> {
  return expression(
    { kind: 'unary', operator: 'IS NOT NULL', operand: value.expression },
    z.boolean(),
    { ...metadata([value]), nullRefs: [] },
  );
}
export function inArray<E extends AnyExpression>(
  value: E,
  values: readonly NoInfer<InferExpression<E>>[],
  negate = false,
): Predicate<ExpressionScope<E>> {
  return expression(
    {
      kind: 'in',
      operand: value.expression,
      values: Object.freeze(values.map((item) => value.encode(item))),
      negate,
    },
    z.boolean().nullable(),
    metadata([value]),
  );
}
export interface Ordering<S extends string = string> {
  readonly ast: OrderNode;
  readonly value: Expression<unknown, S, string>;
}
export function asc<T, S extends string, N extends string>(
  value: Expression<T, S, N>,
  nulls?: 'FIRST' | 'LAST',
): Ordering<S> {
  return Object.freeze({
    ast: Object.freeze({
      expression: value.expression,
      direction: 'ASC',
      ...(nulls ? { nulls } : {}),
    }),
    value,
  });
}
export function desc<T, S extends string, N extends string>(
  value: Expression<T, S, N>,
  nulls?: 'FIRST' | 'LAST',
): Ordering<S> {
  return Object.freeze({
    ast: Object.freeze({
      expression: value.expression,
      direction: 'DESC',
      ...(nulls ? { nulls } : {}),
    }),
    value,
  });
}
export function count<E extends AnyExpression = Expression<never, never>>(
  value?: E,
  distinct = false,
): Expression<bigint, ExpressionScope<E>, never> {
  return expression(
    {
      kind: 'function',
      name: 'COUNT',
      args: Object.freeze(value ? [value.expression] : []),
      ...(distinct ? { distinct: true } : {}),
    },
    z.string().regex(/^\d+$/).transform(BigInt),
    {
      ...metadata(value ? [value] : []),
      valueSchema: z.bigint(),
      phase: 'aggregate',
      nullRefs: [],
      wireType: 'integer',
    },
  );
}
export function sum<E extends Expression<bigint | number | string | null>>(
  value: E,
): Expression<string | null, ExpressionScope<E>> {
  return expression(
    { kind: 'function', name: 'SUM', args: Object.freeze([value.expression]) },
    z.string().nullable(),
    { ...metadata([value]), phase: 'aggregate', wireType: 'decimal' },
  );
}
export function min<E extends AnyExpression>(
  value: E,
): Expression<InferExpression<E> | null, ExpressionScope<E>> {
  return expression(
    { kind: 'function', name: 'MIN', args: Object.freeze([value.expression]) },
    value.readSchema.nullable(),
    {
      ...metadata([value]),
      valueSchema: value.valueSchema.nullable(),
      phase: 'aggregate',
      ...(value.wireType ? { wireType: value.wireType } : {}),
    },
  ) as Expression<InferExpression<E> | null, ExpressionScope<E>>;
}
export function max<E extends AnyExpression>(
  value: E,
): Expression<InferExpression<E> | null, ExpressionScope<E>> {
  return expression(
    { kind: 'function', name: 'MAX', args: Object.freeze([value.expression]) },
    value.readSchema.nullable(),
    {
      ...metadata([value]),
      valueSchema: value.valueSchema.nullable(),
      phase: 'aggregate',
      ...(value.wireType ? { wireType: value.wireType } : {}),
    },
  ) as Expression<InferExpression<E> | null, ExpressionScope<E>>;
}
export function lower<S extends string>(
  value: Expression<string | null, S>,
): Expression<string | null, S> {
  return expression(
    { kind: 'function', name: 'LOWER', args: Object.freeze([value.expression]) },
    z.string().nullable(),
    metadata([value]),
  );
}
export function upper<S extends string>(
  value: Expression<string | null, S>,
): Expression<string | null, S> {
  return expression(
    { kind: 'function', name: 'UPPER', args: Object.freeze([value.expression]) },
    z.string().nullable(),
    metadata([value]),
  );
}
export interface WindowOptions<S extends string = string> {
  readonly partitionBy?: readonly Expression<unknown, S>[];
  readonly orderBy?: readonly Ordering<S>[];
}
export type FrameBoundary<Offset = { readonly unit?: never }> =
  | 'UNBOUNDED PRECEDING'
  | 'CURRENT ROW'
  | 'UNBOUNDED FOLLOWING'
  | ({ readonly preceding: number } & Offset)
  | ({ readonly following: number } & Offset);
export type RangeBoundary = FrameBoundary<{ readonly unit?: IntervalUnit }>;
type FrameEnd<B, Start> = Exclude<
  B,
  | 'UNBOUNDED PRECEDING'
  | (Start extends 'CURRENT ROW' | { readonly following: number }
      ? { readonly preceding: number }
      : never)
  | (Start extends { readonly following: number } ? 'CURRENT ROW' : never)
>;
export interface WindowFrame<Offset extends boolean = boolean> {
  readonly ast: WindowFrameNode;
  readonly offsetType?: Offset;
}
export type FramedWindowOptions<S extends string = string> =
  | (WindowOptions<S> & { readonly frame?: undefined })
  | {
      readonly partitionBy?: readonly Expression<unknown, S>[];
      readonly orderBy: readonly [Ordering<S>, ...Ordering<S>[]];
      readonly frame: WindowFrame<false>;
    }
  | {
      readonly partitionBy?: readonly Expression<unknown, S>[];
      readonly orderBy: readonly [Ordering<S>];
      readonly frame: WindowFrame;
    };
const bounds = [
  'UNBOUNDED PRECEDING',
  'PRECEDING',
  'CURRENT ROW',
  'FOLLOWING',
  'UNBOUNDED FOLLOWING',
] as const;
const intervalUnits: readonly string[] = [
  'YEAR',
  'QUARTER',
  'MONTH',
  'WEEK',
  'DAY',
  'HOUR',
  'MINUTE',
  'SECOND',
  'MILLISECOND',
  'MICROSECOND',
  'NANOSECOND',
];
function frameBoundary(units: WindowFrameNode['units'], value: RangeBoundary): FrameBoundaryNode {
  if (typeof value === 'string') {
    if (
      value !== 'UNBOUNDED PRECEDING' &&
      value !== 'CURRENT ROW' &&
      value !== 'UNBOUNDED FOLLOWING'
    )
      throw new TypeError('Unsupported window frame boundary.');
    return Object.freeze({ bound: value });
  }
  const bound = 'preceding' in value ? 'PRECEDING' : 'FOLLOWING';
  const offset = 'preceding' in value ? value.preceding : value.following;
  if (value.unit !== undefined) {
    if (units === 'ROWS' || !intervalUnits.includes(value.unit))
      throw new TypeError('Interval offsets need a supported unit and a RANGE frame.');
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new TypeError('Interval offsets must be nonnegative safe integers.');
    return Object.freeze({ bound, offset, unit: value.unit });
  }
  if ((units === 'ROWS' ? !Number.isSafeInteger(offset) : !Number.isFinite(offset)) || offset < 0)
    throw new TypeError(
      `${units} offsets must be nonnegative ${units === 'ROWS' ? 'safe integers' : 'finite numbers'}.`,
    );
  return Object.freeze({ bound, offset });
}
function windowFrame(
  units: WindowFrameNode['units'],
  startValue: RangeBoundary,
  endValue: RangeBoundary,
): WindowFrame {
  const start = frameBoundary(units, startValue);
  const end = frameBoundary(units, endValue);
  const first = bounds.indexOf(start.bound);
  const last = bounds.indexOf(end.bound);
  const from = start.offset ?? 0;
  const to = end.offset ?? 0;
  if (
    start.bound === 'UNBOUNDED FOLLOWING' ||
    end.bound === 'UNBOUNDED PRECEDING' ||
    first > last ||
    (first === last &&
      start.unit === end.unit &&
      (start.bound === 'PRECEDING' ? from < to : from > to))
  )
    throw new TypeError('A window frame cannot start after it ends.');
  if (
    start.offset !== undefined &&
    end.offset !== undefined &&
    (start.unit === undefined) !== (end.unit === undefined)
  )
    throw new TypeError('A RANGE frame cannot mix numeric and interval offsets.');
  return Object.freeze({ ast: Object.freeze({ units, start, end }) });
}
export function rowsBetween<
  const Start extends Exclude<FrameBoundary, 'UNBOUNDED FOLLOWING'>,
  const End extends FrameEnd<FrameBoundary, Start>,
>(start: Start, end: End): WindowFrame<false> {
  return windowFrame('ROWS', start, end) as WindowFrame<false>;
}
export function rangeBetween<
  const Start extends Exclude<RangeBoundary, 'UNBOUNDED FOLLOWING'>,
  const End extends FrameEnd<RangeBoundary, Start>,
>(start: Start, end: End): WindowFrame<[Start | End] extends [string] ? false : true> {
  return windowFrame('RANGE', start, end) as WindowFrame<
    [Start | End] extends [string] ? false : true
  >;
}
const numericOrder: readonly (WireType | undefined)[] = ['integer', 'decimal', 'float', 'date'];
const temporalOrder: readonly (WireType | undefined)[] = [
  'date',
  'timestamp_ntz',
  'timestamp_ltz',
  'timestamp_tz',
];
export function over<E extends AnyExpression, S extends string>(
  value: E,
  options: FramedWindowOptions<S> = {},
): Expression<InferExpression<E>, ExpressionScope<E> | S, never> {
  const partition = options.partitionBy ?? [];
  const orders: readonly Ordering<S>[] = options.orderBy ?? [];
  const frame = options.frame?.ast;
  if (frame) {
    if (value.phase !== 'aggregate')
      throw new TypeError(
        'Window frames require an aggregate function; ranking functions do not accept frames.',
      );
    if (!orders.length) throw new TypeError('Window frames require ORDER BY.');
    const offsets = [frame.start, frame.end].filter((item) => item.offset !== undefined);
    const interval = offsets.some((item) => item.unit !== undefined);
    if (
      frame.units === 'RANGE' &&
      offsets.length &&
      (orders.length > 1 ||
        !(interval ? temporalOrder : numericOrder).includes(orders[0]?.value.wireType))
    )
      throw new TypeError(
        interval
          ? 'Interval RANGE offsets require one date or timestamp ORDER BY expression.'
          : 'Numeric RANGE offsets require one numeric or date ORDER BY expression.',
      );
  }
  return expression(
    {
      kind: 'window',
      value: value.expression,
      partitionBy: Object.freeze(partition.map((item) => item.expression)),
      orderBy: Object.freeze(orders.map((item) => item.ast)),
      ...(frame ? { frame } : {}),
    },
    value.readSchema,
    {
      ...metadata([value, ...partition, ...orders.map((item) => item.value)]),
      valueSchema: value.valueSchema,
      phase: 'window',
      nullRefs: [],
      ...(value.wireType ? { wireType: value.wireType } : {}),
    },
  ) as Expression<InferExpression<E>, ExpressionScope<E> | S, never>;
}
export function rowNumber<S extends string = never>(
  options: WindowOptions<S> = {},
): Expression<bigint, S, never> {
  return over(
    expression(
      { kind: 'function', name: 'ROW_NUMBER', args: [] },
      z.string().regex(/^\d+$/).transform(BigInt),
      { valueSchema: z.bigint(), wireType: 'integer' },
    ),
    options,
  );
}
export function jsonPath<E extends AnyExpression>(
  value: E,
  ...path: [string | number, ...(string | number)[]]
): Expression<unknown, ExpressionScope<E>> {
  if (path.some((part) => typeof part === 'number' && (!Number.isSafeInteger(part) || part < 0)))
    throw new TypeError('JSON indexes must be nonnegative safe integers.');
  return expression(
    { kind: 'json-path', value: value.expression, path: Object.freeze([...path]) },
    z
      .string()
      .transform((input) => JSON.parse(input) as unknown)
      .nullable(),
    { ...metadata([value]), wireType: 'variant' },
  );
}
