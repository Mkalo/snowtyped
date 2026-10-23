import * as z from 'zod';
import type {
  BinaryNode,
  ExpressionNode,
  FunctionNode,
  OrderNode,
  SourceReference,
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
export type ExpressionDataType<E> = E extends { readonly dataType: infer D extends DataType }
  ? D
  : never;
export type Predicate<S extends string = string> = Expression<boolean | null, S, S, 'boolean'>;

export type NumericType = 'integer' | 'decimal' | 'float';
export type DateTimeType = 'date' | 'timestamp_ntz' | 'timestamp_ltz' | 'timestamp_tz';
export type TextType = 'text' | 'variant';
/** SQL types Snowflake compares (or assigns) without a data-dependent string conversion. */
export type ComparableType<D extends DataType> = D extends 'variant'
  ? DataType
  : (D extends NumericType ? NumericType : D extends DateTimeType ? DateTimeType : D) | 'variant';

const numericTypes: readonly DataType[] = ['integer', 'decimal', 'float'];
const dateTimeTypes: readonly DataType[] = [
  'date',
  'timestamp_ntz',
  'timestamp_ltz',
  'timestamp_tz',
];
function comparisonClass(type: DataType): string {
  if (numericTypes.includes(type)) return 'number';
  return dateTimeTypes.includes(type) ? 'datetime' : type;
}
export function comparable(left: DataType, right: DataType): boolean {
  return (
    left === 'variant' || right === 'variant' || comparisonClass(left) === comparisonClass(right)
  );
}
function sqlName(type: DataType): string {
  return type.toUpperCase();
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
  const encoded = JSON.stringify(value);
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
type Comparand<L extends AnyExpression> =
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
    { kind: 'logical', operator, operands: Object.freeze(values.map((value) => value.expression)) },
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
    predicate([value]),
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
function extremum<E extends AnyExpression>(
  name: 'MIN' | 'MAX',
  value: E,
): Expression<
  InferExpression<E> | null,
  ExpressionScope<E>,
  ExpressionScope<E>,
  ExpressionDataType<E>
> {
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
export function min<E extends AnyExpression>(
  value: E,
): Expression<
  InferExpression<E> | null,
  ExpressionScope<E>,
  ExpressionScope<E>,
  ExpressionDataType<E>
> {
  return extremum('MIN', value);
}
export function max<E extends AnyExpression>(
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
  readonly partitionBy?: readonly Expression<unknown, S>[];
  readonly orderBy?: readonly Ordering<S>[];
}
export function over<E extends AnyExpression, S extends string>(
  value: E,
  options: WindowOptions<S> = {},
): Expression<InferExpression<E>, ExpressionScope<E> | S, never, ExpressionDataType<E>> {
  const node = value.expression;
  if (node.kind !== 'function' || !node.role)
    throw new TypeError('OVER requires an aggregate or window function.');
  const partition = options.partitionBy ?? [];
  const orders = options.orderBy ?? [];
  if ([...partition, ...orders.map((item) => item.value)].some((item) => item.phase === 'window'))
    throw new TypeError('Window functions cannot be nested inside another window.');
  return expression(
    {
      kind: 'window',
      value: node,
      partitionBy: Object.freeze(partition.map((item) => item.expression)),
      orderBy: Object.freeze(orders.map((item) => item.ast)),
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
export function jsonPath<E extends Expression<unknown, string, string, 'variant'>>(
  value: E,
  ...path: [string | number, ...(string | number)[]]
): Expression<unknown, ExpressionScope<E>, ExpressionScope<E>, 'variant'> {
  if (path.some((part) => typeof part === 'number' && (!Number.isSafeInteger(part) || part < 0)))
    throw new TypeError('JSON indexes must be nonnegative safe integers.');
  assertType(value, ['variant'], 'JSON path access');
  return expression(
    { kind: 'json-path', value: value.expression, path: Object.freeze([...path]) },
    z
      .string()
      .transform((input) => JSON.parse(input) as unknown)
      .nullable(),
    {
      ...metadata([value]),
      dataType: 'variant',
      valueSchema: z.unknown(),
      encode: (item) => (item === null ? scalarParameter(null) : jsonParameter(item)),
      wireType: 'variant',
    },
  );
}
