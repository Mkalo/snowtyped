import * as z from 'zod';
import type {
  BinaryNode,
  ExpressionNode,
  FrameBoundaryNode,
  FunctionNode,
  IntervalUnit,
  OrderNode,
  SourceReference,
  WindowFrameNode,
  WireType,
} from './ast.js';
import type { DataType } from './schema.js';

export interface Expression<
  T = unknown,
  Scope extends string = string,
  NullScope extends string = Scope,
  D extends DataType = DataType,
> {
  readonly expression: ExpressionNode;
  readonly dataType: D;
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
export type ExpressionDataType<E> = E extends {
  readonly dataType: infer D extends DataType;
}
  ? D
  : never;
export type Predicate<S extends string = string> = Expression<boolean | null, S, S, 'boolean'>;

export type NumericType = 'integer' | 'decimal' | 'float';
export type DateTimeType = 'date' | 'timestamp_ntz' | 'timestamp_ltz' | 'timestamp_tz';
export type TextType = 'text' | 'variant';
export type SpatialType = 'geography' | 'geometry';
export type SemiStructuredType = 'variant' | 'array' | 'object';
/** SQL types that MIN and MAX reject. */
export type UnorderedType = SpatialType | 'array' | 'object' | 'vector';
/** SQL types usable as GROUP BY, ORDER BY, and PARTITION BY keys. */
export type KeyType = Exclude<DataType, SpatialType>;
/** SQL types Snowflake compares (or assigns) without a data-dependent string conversion. */
export type ComparableType<D extends DataType> = D extends SpatialType
  ? never
  : D extends 'variant'
    ? Exclude<DataType, SpatialType>
    : (D extends NumericType ? NumericType : D extends DateTimeType ? DateTimeType : D) | 'variant';

const numericTypes: readonly DataType[] = ['integer', 'decimal', 'float'];
const dateTimeTypes: readonly DataType[] = [
  'date',
  'timestamp_ntz',
  'timestamp_ltz',
  'timestamp_tz',
];
export const spatialTypes: readonly DataType[] = ['geography', 'geometry'];
const unorderedTypes: readonly DataType[] = [...spatialTypes, 'array', 'object', 'vector'];
function comparisonClass(type: DataType): string {
  if (numericTypes.includes(type)) return 'number';
  return dateTimeTypes.includes(type) ? 'datetime' : type;
}
export function comparable(left: DataType, right: DataType): boolean {
  if (spatialTypes.includes(left) || spatialTypes.includes(right)) return false;
  return (
    left === 'variant' || right === 'variant' || comparisonClass(left) === comparisonClass(right)
  );
}
function sqlName(type: DataType): string {
  return type.toUpperCase();
}
export function assertNotType(
  value: AnyExpression,
  types: readonly DataType[],
  operation: string,
): void {
  if (types.includes(value.dataType))
    throw new TypeError(`${operation} does not accept ${sqlName(value.dataType)} expressions.`);
}
export function assertComparable(left: AnyExpression, right: AnyExpression): void {
  if (!comparable(left.dataType, right.dataType))
    throw new TypeError(
      `Cannot compare ${sqlName(left.dataType)} with ${sqlName(right.dataType)} expressions.`,
    );
}
export function assertType(
  value: AnyExpression,
  types: readonly DataType[],
  operation: string,
): void {
  if (!types.includes(value.dataType))
    throw new TypeError(`${operation} does not accept ${sqlName(value.dataType)} expressions.`);
}
export function assertPredicate(value: AnyExpression, clause: string): void {
  if (value.dataType !== 'boolean')
    throw new TypeError(`${clause} requires a BOOLEAN predicate, not ${sqlName(value.dataType)}.`);
}

export function scalarParameter(value: unknown): ExpressionNode {
  if (typeof value === 'bigint')
    return Object.freeze({ kind: 'parameter', value: value.toString() });
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return Object.freeze({ kind: 'parameter', value });
  if (typeof value === 'number' && Number.isFinite(value))
    return Object.freeze({ kind: 'parameter', value });
  throw new TypeError('Unsupported expression parameter.');
}
export function jsonParameter(value: unknown): ExpressionNode {
  const encoded = value === null ? null : JSON.stringify(value);
  if (encoded === undefined) throw new TypeError('VARIANT values must be JSON serializable.');
  return Object.freeze({
    kind: 'function',
    name: 'PARSE_JSON',
    args: Object.freeze([scalarParameter(encoded)]),
  });
}
export function expression<
  T,
  S extends string = never,
  N extends string = S,
  D extends DataType = DataType,
>(
  node: ExpressionNode,
  readSchema: z.ZodType<T>,
  options: {
    readonly dataType: D;
    readonly valueSchema?: z.ZodType<T>;
    readonly refs?: readonly SourceReference[];
    readonly nullRefs?: readonly SourceReference[];
    readonly phase?: AnyExpression['phase'];
    readonly wireType?: WireType;
    readonly encode?: (value: T) => ExpressionNode;
  },
): Expression<T, S, N, D> {
  const valueSchema = options.valueSchema ?? readSchema;
  return Object.freeze({
    expression: Object.freeze(node),
    dataType: options.dataType,
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
/** Normalized significant digits and exponent of a JSON number, with the digit count. */
function decimal(text: string): readonly [key: string, digits: number] {
  const [, sign, whole, fraction = '', exponent = '0'] =
    /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(text) as RegExpExecArray;
  const digits = `${whole}${fraction}`.replace(/^0+/, '');
  const significant = digits.replace(/0+$/, '');
  if (!significant) return ['0', 1];
  const scale = Number(exponent) - fraction.length + digits.length - significant.length;
  return [`${sign}${significant}e${scale}`, significant.length];
}
function exactNumber(value: number, source: string): number {
  const [key, digits] = decimal(source);
  if (!Number.isFinite(value) || key !== decimal(value.toPrecision(Math.min(digits, 100)))[0])
    throw new RangeError(`JSON number ${source} does not fit a JavaScript number exactly.`);
  return value;
}
/**
 * By default, rejects JSON numbers whose text carries digits a JavaScript number cannot hold,
 * instead of rounding them. Text is accepted when it is the decoded double correctly rounded to the
 * text's own precision, which covers both shortest spellings and Snowflake's 16-digit DOUBLE output.
 */
export const jsonText = (number: (value: number, source: string) => unknown = exactNumber) =>
  z.string().transform((input, context) => {
    try {
      // TO_JSON prints SQL NULL array elements as a bare `undefined`, which JSON.parse rejects.
      const text = input.replace(/"(?:[^"\\]|\\.)*"|undefined/g, (token) =>
        token === 'undefined' ? 'null' : token,
      );
      return JSON.parse(text, (_key, value: unknown, parsed?: { readonly source: string }) =>
        typeof value === 'number'
          ? number(value, (parsed as { readonly source: string }).source)
          : value,
      ) as unknown;
    } catch (error) {
      context.addIssue({
        code: 'custom',
        message: (error as Error).message,
        input,
      });
      return z.NEVER;
    }
  });
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
function predicate(values: readonly AnyExpression[]) {
  return { ...metadata(values), dataType: 'boolean' as const };
}
function comparison<L extends AnyExpression, R>(
  operator: BinaryNode['operator'],
  left: L,
  right: R,
): Predicate<ExpressionScope<L> | ExpressionScope<R>> {
  const values = isExpression(right) ? [left, right] : [left];
  if (isExpression(right)) assertComparable(left, right);
  if (right === null && (operator === '=' || operator === '<>')) {
    left.valueSchema.parse(right);
    return expression(
      {
        kind: 'unary',
        operator: operator === '=' ? 'IS NULL' : 'IS NOT NULL',
        operand: left.expression,
      },
      z.boolean(),
      predicate(values),
    );
  }
  assertNotType(left, spatialTypes, operator);
  return expression(
    {
      kind: 'binary',
      operator,
      left: left.expression,
      right: isExpression(right) ? right.expression : left.encode(right),
    },
    z.boolean().nullable(),
    predicate(values),
  );
}
type Comparand<L extends AnyExpression> = [ExpressionDataType<L>] extends [SpatialType]
  ? null
  :
      | NoInfer<InferExpression<L>>
      | Expression<unknown, string, string, ComparableType<ExpressionDataType<L>>>;
export function eq<L extends AnyExpression, R extends Comparand<L>>(
  left: L,
  right: R,
): Predicate<ExpressionScope<L> | ExpressionScope<R>> {
  return comparison('=', left, right);
}
export function ne<L extends AnyExpression, R extends Comparand<L>>(
  left: L,
  right: R,
): Predicate<ExpressionScope<L> | ExpressionScope<R>> {
  return comparison('<>', left, right);
}
export function gt<L extends AnyExpression, R extends Comparand<L>>(
  left: L,
  right: R,
): Predicate<ExpressionScope<L> | ExpressionScope<R>> {
  return comparison('>', left, right);
}
export function gte<L extends AnyExpression, R extends Comparand<L>>(
  left: L,
  right: R,
): Predicate<ExpressionScope<L> | ExpressionScope<R>> {
  return comparison('>=', left, right);
}
export function lt<L extends AnyExpression, R extends Comparand<L>>(
  left: L,
  right: R,
): Predicate<ExpressionScope<L> | ExpressionScope<R>> {
  return comparison('<', left, right);
}
export function lte<L extends AnyExpression, R extends Comparand<L>>(
  left: L,
  right: R,
): Predicate<ExpressionScope<L> | ExpressionScope<R>> {
  return comparison('<=', left, right);
}
const textTypes: readonly DataType[] = ['text', 'variant'];
function match<S extends string>(
  operator: 'LIKE' | 'ILIKE',
  left: Expression<string | null, S, string, TextType>,
  pattern: string,
): Predicate<S> {
  assertType(left, textTypes, operator);
  return expression(
    {
      kind: 'binary',
      operator,
      left: left.expression,
      right: scalarParameter(z.string().parse(pattern)),
    },
    z.boolean().nullable(),
    predicate([left]),
  );
}
export function like<S extends string>(
  left: Expression<string | null, S, string, TextType>,
  pattern: string,
): Predicate<S> {
  return match('LIKE', left, pattern);
}
export function ilike<S extends string>(
  left: Expression<string | null, S, string, TextType>,
  pattern: string,
): Predicate<S> {
  return match('ILIKE', left, pattern);
}
function logical<S extends string>(
  operator: 'AND' | 'OR',
  values: readonly Predicate<S>[],
): Predicate<S> {
  if (!values.length) throw new TypeError(`${operator} requires at least one predicate.`);
  for (const value of values) assertPredicate(value, operator);
  return expression(
    {
      kind: 'logical',
      operator,
      operands: Object.freeze(values.map((value) => value.expression)),
    },
    z.boolean().nullable(),
    predicate(values),
  );
}
export function and<S extends string>(...values: readonly Predicate<S>[]): Predicate<S> {
  return logical('AND', values);
}
export function or<S extends string>(...values: readonly Predicate<S>[]): Predicate<S> {
  return logical('OR', values);
}
export function not<S extends string>(value: Predicate<S>): Predicate<S> {
  assertPredicate(value, 'NOT');
  return expression(
    { kind: 'unary', operator: 'NOT', operand: value.expression },
    z.boolean().nullable(),
    predicate([value]),
  );
}
export function isNull<E extends AnyExpression>(
  value: E,
): Expression<boolean, ExpressionScope<E>, never, 'boolean'> {
  return expression(
    { kind: 'unary', operator: 'IS NULL', operand: value.expression },
    z.boolean(),
    { ...predicate([value]), nullRefs: [] },
  );
}
export function isNotNull<E extends AnyExpression>(
  value: E,
): Expression<boolean, ExpressionScope<E>, never, 'boolean'> {
  return expression(
    { kind: 'unary', operator: 'IS NOT NULL', operand: value.expression },
    z.boolean(),
    { ...predicate([value]), nullRefs: [] },
  );
}
export function inArray<
  E extends Expression<unknown, string, string, Exclude<DataType, SpatialType>>,
>(
  value: E,
  values: readonly NoInfer<InferExpression<E>>[],
  negate = false,
): Predicate<ExpressionScope<E>> {
  assertNotType(value, spatialTypes, 'IN');
  return expression(
    {
      kind: 'in',
      operand: value.expression,
      values: Object.freeze(values.map((item) => value.encode(item))),
      negate,
    },
    z.boolean().nullable(),
    predicate([value]),
  );
}
export interface Ordering<S extends string = string> {
  readonly ast: OrderNode;
  readonly value: Expression<unknown, S, string, KeyType>;
}
export function asc<T, S extends string, N extends string>(
  value: Expression<T, S, N, KeyType>,
  nulls?: 'FIRST' | 'LAST',
): Ordering<S> {
  assertNotType(value, spatialTypes, 'ORDER BY');
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
  value: Expression<T, S, N, KeyType>,
  nulls?: 'FIRST' | 'LAST',
): Ordering<S> {
  assertNotType(value, spatialTypes, 'ORDER BY');
  return Object.freeze({
    ast: Object.freeze({
      expression: value.expression,
      direction: 'DESC',
      ...(nulls ? { nulls } : {}),
    }),
    value,
  });
}
function aggregate(
  name: string,
  args: readonly AnyExpression[],
  distinct = false,
): FunctionNode & { readonly role: 'aggregate' } {
  if (args.some((arg) => arg.phase === 'window'))
    throw new TypeError(`Window functions cannot be nested inside ${name}.`);
  return Object.freeze({
    kind: 'function',
    name,
    args: Object.freeze(args.map((arg) => arg.expression)),
    role: 'aggregate',
    ...(distinct ? { distinct: true } : {}),
  });
}
export function count<E extends AnyExpression = Expression<never, never>>(
  value?: E,
  distinct = false,
): Expression<bigint, ExpressionScope<E>, never, 'integer'> {
  const args = value ? [value] : [];
  return expression(
    aggregate('COUNT', args, distinct),
    z.string().regex(/^\d+$/).transform(BigInt),
    {
      ...metadata(args),
      dataType: 'integer',
      valueSchema: z.bigint(),
      phase: 'aggregate',
      nullRefs: [],
      wireType: 'integer',
    },
  );
}
export function sum<
  E extends Expression<bigint | number | string | null, string, string, NumericType>,
>(
  value: E,
): Expression<
  string | null,
  ExpressionScope<E>,
  ExpressionScope<E>,
  ExpressionDataType<E> extends 'float' ? 'float' : 'decimal'
> {
  assertType(value, numericTypes, 'SUM');
  return expression(aggregate('SUM', [value]), z.string().nullable(), {
    ...metadata([value]),
    dataType: (value.dataType === 'float'
      ? 'float'
      : 'decimal') as ExpressionDataType<E> extends 'float' ? 'float' : 'decimal',
    phase: 'aggregate',
    wireType: 'decimal',
  });
}
function extremum<E extends Expression<unknown, string, string, Exclude<DataType, UnorderedType>>>(
  name: 'MIN' | 'MAX',
  value: E,
): Expression<
  InferExpression<E> | null,
  ExpressionScope<E>,
  ExpressionScope<E>,
  ExpressionDataType<E>
> {
  assertNotType(value, unorderedTypes, name);
  return expression(aggregate(name, [value]), value.readSchema.nullable(), {
    ...metadata([value]),
    dataType: value.dataType,
    valueSchema: value.valueSchema.nullable(),
    phase: 'aggregate',
    encode: (item) => (item === null ? scalarParameter(null) : value.encode(item)),
    ...(value.wireType ? { wireType: value.wireType } : {}),
  }) as Expression<
    InferExpression<E> | null,
    ExpressionScope<E>,
    ExpressionScope<E>,
    ExpressionDataType<E>
  >;
}
export function min<
  E extends Expression<unknown, string, string, Exclude<DataType, UnorderedType>>,
>(
  value: E,
): Expression<
  InferExpression<E> | null,
  ExpressionScope<E>,
  ExpressionScope<E>,
  ExpressionDataType<E>
> {
  return extremum('MIN', value);
}
export function max<
  E extends Expression<unknown, string, string, Exclude<DataType, UnorderedType>>,
>(
  value: E,
): Expression<
  InferExpression<E> | null,
  ExpressionScope<E>,
  ExpressionScope<E>,
  ExpressionDataType<E>
> {
  return extremum('MAX', value);
}
function textFunction<S extends string>(
  name: 'LOWER' | 'UPPER',
  value: Expression<string | null, S, string, TextType>,
): Expression<string | null, S, S, 'text'> {
  assertType(value, textTypes, name);
  return expression(
    { kind: 'function', name, args: Object.freeze([value.expression]) },
    z.string().nullable(),
    { ...metadata([value]), dataType: 'text' },
  );
}
export function lower<S extends string>(
  value: Expression<string | null, S, string, TextType>,
): Expression<string | null, S, S, 'text'> {
  return textFunction('LOWER', value);
}
export function upper<S extends string>(
  value: Expression<string | null, S, string, TextType>,
): Expression<string | null, S, S, 'text'> {
  return textFunction('UPPER', value);
}
export interface WindowOptions<S extends string = string> {
  readonly partitionBy?: readonly Expression<unknown, S, string, KeyType>[];
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
      readonly partitionBy?: readonly Expression<unknown, S, string, KeyType>[];
      readonly orderBy: readonly [Ordering<S>, ...Ordering<S>[]];
      readonly frame: WindowFrame<false>;
    }
  | {
      readonly partitionBy?: readonly Expression<unknown, S, string, KeyType>[];
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
): Expression<InferExpression<E>, ExpressionScope<E> | S, never, ExpressionDataType<E>> {
  const node = value.expression;
  if (node.kind !== 'function' || !node.role)
    throw new TypeError('OVER requires an aggregate or window function.');
  const partition = options.partitionBy ?? [];
  const orders: readonly Ordering<S>[] = options.orderBy ?? [];
  if ([...partition, ...orders.map((item) => item.value)].some((item) => item.phase === 'window'))
    throw new TypeError('Window functions cannot be nested inside another window.');
  for (const item of partition) assertNotType(item, spatialTypes, 'PARTITION BY');
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
      value: node,
      partitionBy: Object.freeze(partition.map((item) => item.expression)),
      orderBy: Object.freeze(orders.map((item) => item.ast)),
      ...(frame ? { frame } : {}),
    },
    value.readSchema,
    {
      ...metadata([value, ...partition, ...orders.map((item) => item.value)]),
      dataType: value.dataType,
      valueSchema: value.valueSchema,
      phase: 'window',
      nullRefs: [],
      encode: (item) => value.encode(item),
      ...(value.wireType ? { wireType: value.wireType } : {}),
    },
  ) as Expression<InferExpression<E>, ExpressionScope<E> | S, never, ExpressionDataType<E>>;
}
export function rowNumber<S extends string = never>(
  options: WindowOptions<S> = {},
): Expression<bigint, S, never, 'integer'> {
  return over(
    expression(
      { kind: 'function', name: 'ROW_NUMBER', args: [], role: 'window' },
      z.string().regex(/^\d+$/).transform(BigInt),
      { dataType: 'integer', valueSchema: z.bigint(), wireType: 'integer' },
    ),
    options,
  );
}
export function jsonPath<E extends Expression<unknown, string, string, SemiStructuredType>>(
  value: E,
  ...path: [string | number, ...(string | number)[]]
): Expression<unknown, ExpressionScope<E>, ExpressionScope<E>, 'variant'> {
  if (path.some((part) => typeof part === 'number' && (!Number.isSafeInteger(part) || part < 0)))
    throw new TypeError('JSON indexes must be nonnegative safe integers.');
  assertType(value, ['variant', 'array', 'object'], 'JSON path access');
  return expression(
    {
      kind: 'json-path',
      value: value.expression,
      path: Object.freeze([...path]),
    },
    jsonText().nullable(),
    {
      ...metadata([value]),
      dataType: 'variant',
      valueSchema: z.unknown(),
      encode: jsonParameter,
      wireType: 'variant',
    },
  );
}
