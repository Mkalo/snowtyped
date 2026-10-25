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

/**
 * A typed SQL expression, such as a column, a function call, a predicate, or an aggregate.
 *
 * `T` is the decoded TypeScript value, `D` the SQL type that comparisons and functions check, and
 * `Scope` the names of the sources the expression references. Queries reject expressions whose
 * sources are not in scope.
 *
 * @typeParam T - The value the expression decodes to, including `null` when it is nullable.
 * @typeParam Scope - Names of the sources the expression reads.
 * @typeParam NullScope - Sources whose absence in an outer join makes the expression NULL.
 * @typeParam D - The expression's SQL type.
 */
export interface Expression<
  T = unknown,
  Scope extends string = string,
  NullScope extends string = Scope,
  D extends DataType = DataType,
> {
  /** The expression's syntax tree. */
  readonly expression: ExpressionNode;
  /** The expression's SQL type. */
  readonly dataType: D;
  /** Decodes the value as read from a result row. */
  readonly readSchema: z.ZodType<T>;
  /** Validates JavaScript values written to or compared with the expression. */
  readonly valueSchema: z.ZodType<T>;
  /** The sources the expression reads. */
  readonly refs: readonly SourceReference[];
  /** The sources whose absence in an outer join makes the expression NULL. */
  readonly nullRefs: readonly SourceReference[];
  /**
   * Whether the expression is a plain value, contains an aggregate, or contains a window function.
   */
  readonly phase: 'scalar' | 'aggregate' | 'window';
  /** How the compiler serializes the expression when it is projected. */
  readonly wireType?: WireType;
  /** @internal */
  readonly scopeType?: Scope;
  /** @internal */
  readonly nullScopeType?: NullScope;
  /**
   * Validates a JavaScript value with {@link Expression.valueSchema} and encodes it as a bind
   * parameter of this expression's type.
   */
  encode(value: T): ExpressionNode;
}
/** An expression of any value type, SQL type, and scope. */
export type AnyExpression = Expression<unknown, string, string>;
/**
 * The decoded TypeScript value of an expression.
 *
 * @example
 * ```ts
 * const total = sum(orders.columns.amount);
 * type Total = InferExpression<typeof total>; // string | null
 * ```
 */
export type InferExpression<E> = E extends Expression<infer T, string, string> ? T : never;
// Non-distributive: a literal argument would otherwise widen the scope of comparisons to string.
export type ExpressionScope<E> = [E] extends [never]
  ? never
  : [E] extends [Expression<unknown, infer S, string>]
    ? S
    : never;
export type ExpressionNullScope<E> = E extends Expression<unknown, string, infer S> ? S : never;
export type ExpressionDataType<E> = E extends {
  readonly dataType: infer D extends DataType;
}
  ? D
  : never;
/**
 * A BOOLEAN expression, accepted by `.where()`, `.having()`, `.qualify()`, joins, and {@link and},
 * {@link or}, and {@link not}.
 */
export type Predicate<S extends string = string> = Expression<boolean | null, S, S, 'boolean'>;

export type NumericType = 'integer' | 'decimal' | 'float';
export type DateTimeType = 'date' | 'timestamp_ntz' | 'timestamp_ltz' | 'timestamp_tz';
export type TextType = 'text' | 'variant';
export type SpatialType = 'geography' | 'geometry';
export type SemiStructuredType = 'variant' | 'array' | 'object' | 'structured';
/** SQL types that MIN and MAX reject. */
export type UnorderedType = SpatialType | 'array' | 'object' | 'vector' | 'structured';
/** SQL types usable as GROUP BY, ORDER BY, and PARTITION BY keys. */
export type KeyType = Exclude<DataType, SpatialType>;
/** SQL types Snowflake compares (or assigns) without a data-dependent string conversion. */
export type ComparableType<D extends DataType> = D extends SpatialType
  ? never
  : D extends 'structured'
    ? 'structured'
    : D extends 'variant'
      ? Exclude<DataType, SpatialType | 'structured'>
      :
          | (D extends NumericType ? NumericType : D extends DateTimeType ? DateTimeType : D)
          | 'variant';

const numericTypes: readonly DataType[] = ['integer', 'decimal', 'float'];
const dateTimeTypes: readonly DataType[] = [
  'date',
  'timestamp_ntz',
  'timestamp_ltz',
  'timestamp_tz',
];
export const spatialTypes: readonly DataType[] = ['geography', 'geometry'];
const unorderedTypes: readonly DataType[] = [
  ...spatialTypes,
  'array',
  'object',
  'vector',
  'structured',
];
function comparisonClass(type: DataType): string {
  if (numericTypes.includes(type)) return 'number';
  return dateTimeTypes.includes(type) ? 'datetime' : type;
}
export function comparable(left: DataType, right: DataType): boolean {
  if (spatialTypes.includes(left) || spatialTypes.includes(right)) return false;
  // Structured types convert to and from no other type, VARIANT included.
  if (left === 'structured' || right === 'structured') return left === right;
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
 * text's own precision, which covers both shortest spellings and Snowflake's 16-digit DOUBLE
 * output.
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
export function metadata(values: readonly AnyExpression[]) {
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
/**
 * Compares two values with `=`.
 *
 * `right` is a literal of `left`'s TypeScript type, which is bound as a parameter, or an expression
 * of a comparable SQL type. `eq(value, null)` compiles to `value IS NULL`.
 *
 * @example
 * ```ts
 * select(customers).where(eq(customers.columns.name, 'Ada'));
 * ```
 */
export function eq<L extends AnyExpression, R extends Comparand<L>>(
  left: L,
  right: R,
): Predicate<ExpressionScope<L> | ExpressionScope<R>> {
  return comparison('=', left, right);
}
/**
 * Compares two values with `<>`. `ne(value, null)` compiles to `value IS NOT NULL`.
 *
 * Accepts the same operands as {@link eq}.
 */
export function ne<L extends AnyExpression, R extends Comparand<L>>(
  left: L,
  right: R,
): Predicate<ExpressionScope<L> | ExpressionScope<R>> {
  return comparison('<>', left, right);
}
/** Compares two values with `>`. Accepts the same operands as {@link eq}. */
export function gt<L extends AnyExpression, R extends Comparand<L>>(
  left: L,
  right: R,
): Predicate<ExpressionScope<L> | ExpressionScope<R>> {
  return comparison('>', left, right);
}
/** Compares two values with `>=`. Accepts the same operands as {@link eq}. */
export function gte<L extends AnyExpression, R extends Comparand<L>>(
  left: L,
  right: R,
): Predicate<ExpressionScope<L> | ExpressionScope<R>> {
  return comparison('>=', left, right);
}
/** Compares two values with `<`. Accepts the same operands as {@link eq}. */
export function lt<L extends AnyExpression, R extends Comparand<L>>(
  left: L,
  right: R,
): Predicate<ExpressionScope<L> | ExpressionScope<R>> {
  return comparison('<', left, right);
}
/** Compares two values with `<=`. Accepts the same operands as {@link eq}. */
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
/**
 * Matches TEXT or VARIANT values against a case-sensitive LIKE pattern, where `%` matches any
 * sequence and `_` any single character. The pattern is bound as a parameter.
 */
export function like<S extends string>(
  left: Expression<string | null, S, string, TextType>,
  pattern: string,
): Predicate<S> {
  return match('LIKE', left, pattern);
}
/**
 * Matches TEXT or VARIANT values against a case-insensitive ILIKE pattern. The pattern is bound as
 * a parameter.
 */
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
/**
 * Combines predicates with AND.
 *
 * @throws `TypeError` when called without predicates.
 *
 * @example
 * ```ts
 * select(orders).where(and(gt(orders.columns.amount, '100'), eq(orders.columns.customerId, 7n)));
 * ```
 */
export function and<S extends string>(...values: readonly Predicate<S>[]): Predicate<S> {
  return logical('AND', values);
}
/**
 * Combines predicates with OR.
 *
 * @throws `TypeError` when called without predicates.
 */
export function or<S extends string>(...values: readonly Predicate<S>[]): Predicate<S> {
  return logical('OR', values);
}
/** Negates a predicate with NOT. */
export function not<S extends string>(value: Predicate<S>): Predicate<S> {
  assertPredicate(value, 'NOT');
  return expression(
    { kind: 'unary', operator: 'NOT', operand: value.expression },
    z.boolean().nullable(),
    predicate([value]),
  );
}
/** Tests whether a value is NULL. The result is never NULL itself. */
export function isNull<E extends AnyExpression>(
  value: E,
): Expression<boolean, ExpressionScope<E>, never, 'boolean'> {
  return expression(
    { kind: 'unary', operator: 'IS NULL', operand: value.expression },
    z.boolean(),
    { ...predicate([value]), nullRefs: [] },
  );
}
/** Tests whether a value is not NULL. The result is never NULL itself. */
export function isNotNull<E extends AnyExpression>(
  value: E,
): Expression<boolean, ExpressionScope<E>, never, 'boolean'> {
  return expression(
    { kind: 'unary', operator: 'IS NOT NULL', operand: value.expression },
    z.boolean(),
    { ...predicate([value]), nullRefs: [] },
  );
}
/**
 * Tests whether a value is one of a list of literals, with `IN (...)`, or `NOT IN` when `negate` is
 * true. Each literal is validated and bound as a parameter.
 *
 * An empty list compiles to FALSE, or TRUE when negated. For a subquery, use {@link inSubquery}.
 *
 * @example
 * ```ts
 * select(orders).where(inArray(orders.columns.customerId, [1n, 2n, 3n]));
 * ```
 */
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
/** An ORDER BY item created by {@link asc} or {@link desc}. */
export interface Ordering<S extends string = string> {
  /** The ORDER BY item's syntax tree. */
  readonly ast: OrderNode;
  /** The ordered expression. */
  readonly value: Expression<unknown, S, string, KeyType>;
}
/**
 * Orders by a value ascending, optionally with `NULLS FIRST` or `NULLS LAST`.
 *
 * GEOGRAPHY and GEOMETRY values cannot be ordered.
 */
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
/**
 * Orders by a value descending, optionally with `NULLS FIRST` or `NULLS LAST`.
 *
 * GEOGRAPHY and GEOMETRY values cannot be ordered.
 */
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
export function aggregate(
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
/**
 * Counts rows with `COUNT(*)`, or the non-NULL values of an expression, optionally `DISTINCT`.
 *
 * The count decodes as a non-null `bigint`.
 *
 * @category Aggregates
 * @example
 * ```ts
 * select(orders, { customerId: orders.columns.customerId, orders: count() }).groupBy(
 *   orders.columns.customerId,
 * );
 * ```
 */
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
/**
 * Sums a numeric expression with `SUM`.
 *
 * The result decodes as exact decimal text, and is NULL for an empty group. Its SQL type is FLOAT
 * for a FLOAT input and DECIMAL otherwise.
 *
 * @category Aggregates
 */
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
/**
 * Returns the smallest value with `MIN`, keeping the input's type. NULL for an empty group.
 *
 * ARRAY, OBJECT, VECTOR, structured, and spatial values are rejected.
 *
 * @category Aggregates
 */
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
/**
 * Returns the largest value with `MAX`, keeping the input's type. NULL for an empty group.
 *
 * ARRAY, OBJECT, VECTOR, structured, and spatial values are rejected.
 *
 * @category Aggregates
 */
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
/** Converts TEXT to lowercase with `LOWER`. */
export function lower<S extends string>(
  value: Expression<string | null, S, string, TextType>,
): Expression<string | null, S, S, 'text'> {
  return textFunction('LOWER', value);
}
/** Converts TEXT to uppercase with `UPPER`. */
export function upper<S extends string>(
  value: Expression<string | null, S, string, TextType>,
): Expression<string | null, S, S, 'text'> {
  return textFunction('UPPER', value);
}
/**
 * The PARTITION BY and ORDER BY of a window.
 *
 * @category Windows
 */
export interface WindowOptions<S extends string = string> {
  /** Splits rows into partitions. GEOGRAPHY and GEOMETRY values cannot be partition keys. */
  readonly partitionBy?: readonly Expression<unknown, S, string, KeyType>[];
  /** Orders rows within each partition. */
  readonly orderBy?: readonly Ordering<S>[];
}
/**
 * A ROWS frame boundary: `'UNBOUNDED PRECEDING'`, `'CURRENT ROW'`, `'UNBOUNDED FOLLOWING'`,
 * `{ preceding: n }`, or `{ following: n }`.
 *
 * @category Windows
 */
export type FrameBoundary<Offset = { readonly unit?: never }> =
  | 'UNBOUNDED PRECEDING'
  | 'CURRENT ROW'
  | 'UNBOUNDED FOLLOWING'
  | ({ readonly preceding: number } & Offset)
  | ({ readonly following: number } & Offset);
/**
 * A RANGE frame boundary. Offsets may also carry an interval `unit`, such as
 * `{ preceding: 1, unit: 'DAY' }`, for a date or timestamp ORDER BY key.
 *
 * @category Windows
 */
export type RangeBoundary = FrameBoundary<{ readonly unit?: IntervalUnit }>;
type FrameEnd<B, Start> = Exclude<
  B,
  | 'UNBOUNDED PRECEDING'
  | (Start extends 'CURRENT ROW' | { readonly following: number }
      ? { readonly preceding: number }
      : never)
  | (Start extends { readonly following: number } ? 'CURRENT ROW' : never)
>;
/**
 * A window frame created by {@link rowsBetween} or {@link rangeBetween}.
 *
 * @category Windows
 */
export interface WindowFrame<Offset extends boolean = boolean> {
  /** The frame's syntax tree. */
  readonly ast: WindowFrameNode;
  /** @internal */
  readonly offsetType?: Offset;
}
/**
 * The options of {@link over}: a window's PARTITION BY and ORDER BY, and an optional frame.
 *
 * A frame requires ORDER BY. A RANGE frame with offsets requires exactly one ORDER BY expression.
 *
 * @category Windows
 */
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
/**
 * Creates a `ROWS BETWEEN start AND end` frame for {@link over}. Offsets count rows and must be
 * nonnegative integers.
 *
 * @throws `TypeError` when the start follows the end or an offset is invalid.
 * @category Windows
 * @example
 * ```ts
 * over(sum(orders.columns.amount), {
 *   partitionBy: [orders.columns.customerId],
 *   orderBy: [asc(orders.columns.id)],
 *   frame: rowsBetween('UNBOUNDED PRECEDING', 'CURRENT ROW'),
 * });
 * ```
 */
export function rowsBetween<
  const Start extends Exclude<FrameBoundary, 'UNBOUNDED FOLLOWING'>,
  const End extends FrameEnd<FrameBoundary, Start>,
>(start: Start, end: End): WindowFrame<false> {
  return windowFrame('ROWS', start, end) as WindowFrame<false>;
}
/**
 * Creates a `RANGE BETWEEN start AND end` frame for {@link over}.
 *
 * Numeric offsets need a numeric or date ORDER BY key, and interval offsets such as
 * `{ preceding: 1, unit: 'DAY' }` need a date or timestamp key. A frame cannot mix numeric and
 * interval offsets.
 *
 * @throws `TypeError` when the start follows the end or an offset is invalid.
 * @category Windows
 * @example
 * ```ts
 * over(count(), {
 *   orderBy: [asc(trades.columns.at)],
 *   frame: rangeBetween({ preceding: 1, unit: 'DAY' }, 'CURRENT ROW'),
 * });
 * ```
 */
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
/**
 * Turns an aggregate or a ranking function into a window function with `OVER (...)`.
 *
 * The result keeps the input's type and SQL type. Window functions cannot be nested, and they can
 * be filtered with `.qualify()`.
 *
 * @throws `TypeError` when the value is not an aggregate or window function, when a frame is given
 * without ORDER BY or for a ranking function, or when RANGE offsets do not fit the ORDER BY key.
 * @category Windows
 * @example
 * ```ts
 * const share = over(sum(orders.columns.amount), { partitionBy: [orders.columns.customerId] });
 * select(orders, { id: orders.columns.id, share });
 * ```
 */
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
/**
 * Numbers rows within each partition with `ROW_NUMBER() OVER (...)`, starting at 1.
 *
 * @category Windows
 * @example
 * ```ts
 * const rank = rowNumber({
 *   partitionBy: [orders.columns.customerId],
 *   orderBy: [desc(orders.columns.amount)],
 * });
 * select(orders, { id: orders.columns.id, rank }).qualify(eq(rank, 1n));
 * ```
 */
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
/**
 * Reads a field or element of a VARIANT, ARRAY, OBJECT, or structured value with `GET`.
 *
 * Strings select object fields and numbers select array elements. The result is VARIANT and decodes
 * as `unknown`; literals compared with it are bound as JSON.
 *
 * @throws `TypeError` when an index is not a nonnegative integer.
 * @example
 * ```ts
 * select(events, { kind: jsonPath(events.columns.payload, 'kind') });
 * ```
 */
export function jsonPath<E extends Expression<unknown, string, string, SemiStructuredType>>(
  value: E,
  ...path: [string | number, ...(string | number)[]]
): Expression<unknown, ExpressionScope<E>, ExpressionScope<E>, 'variant'> {
  if (path.some((part) => typeof part === 'number' && (!Number.isSafeInteger(part) || part < 0)))
    throw new TypeError('JSON indexes must be nonnegative safe integers.');
  assertType(value, ['variant', 'array', 'object', 'structured'], 'JSON path access');
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
