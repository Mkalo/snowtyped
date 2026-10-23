import * as z from 'zod';
import type {
  ArithmeticNode,
  CastNode,
  DatePartNode,
  ExpressionNode,
  SourceReference,
  WireType,
} from './ast.js';
import {
  type AnyExpression,
  type Expression,
  type ExpressionNullScope,
  type ExpressionScope,
  expression,
  type InferExpression,
  isExpression,
  metadata,
  type Ordering,
  over,
  scalarParameter,
  type WindowOptions,
} from './expressions.js';
import {
  type AnyColumn,
  boolean,
  date,
  decimal,
  float,
  integer,
  text,
  time,
  timestamp,
} from './schema.js';

export type CastType =
  | 'text'
  | 'integer'
  | 'decimal'
  | 'float'
  | 'boolean'
  | 'date'
  | 'time'
  | 'timestamp_ntz'
  | 'timestamp_ltz'
  | 'timestamp_tz';
export interface CastValue {
  text: string;
  integer: bigint;
  decimal: string;
  float: number;
  boolean: boolean;
  date: string;
  time: string;
  timestamp_ntz: string;
  timestamp_ltz: string;
  timestamp_tz: string;
}
type NullOf<T> = null extends T ? null : never;
type ValueOf<V> = V extends AnyExpression ? InferExpression<V> : V;
type Same<E> = NoInfer<NonNullable<InferExpression<E>>>;
type SameValue<E> = Same<E> | Expression<Same<E> | null, string, string>;
type AllNullable<Vs extends readonly unknown[]> = Vs extends readonly [infer H, ...infer Rest]
  ? H extends AnyExpression
    ? null extends InferExpression<H>
      ? AllNullable<Rest>
      : never
    : never
  : null;
type Certain<V> = V extends AnyExpression
  ? null extends InferExpression<V>
    ? false
    : [ExpressionNullScope<V>] extends [never]
      ? true
      : false
  : true;
type GuardScope<V> = V extends AnyExpression
  ? null extends InferExpression<V>
    ? never
    : ExpressionNullScope<V>
  : never;
type CoalesceScope<Vs extends readonly unknown[]> = true extends {
  [K in keyof Vs]: Certain<Vs[K]>;
}[number]
  ? never
  : { [K in keyof Vs]: GuardScope<Vs[K]> }[number];
type Literal = string | bigint | number | boolean;
type Widen<V> = V extends AnyExpression
  ? InferExpression<V>
  : V extends string
    ? string
    : V extends bigint
      ? bigint
      : V extends number
        ? number
        : V extends boolean
          ? boolean
          : never;
type PredicateExpression = Expression<boolean | null, string, string>;
export interface CaseExpression<T, S extends string, N extends string>
  extends Expression<T | null, S, N> {
  when<P extends PredicateExpression, V extends SameValue<Expression<T>>>(
    predicate: P,
    value: V,
  ): CaseExpression<
    T | Widen<V>,
    S | ExpressionScope<P> | ExpressionScope<V>,
    N | ExpressionNullScope<V>
  >;
  else<V extends SameValue<Expression<T>>>(
    value: V,
  ): Expression<T | Widen<V>, S | ExpressionScope<V>, N | ExpressionNullScope<V>>;
}
type AnyNull<Vs extends readonly unknown[]> = {
  [K in keyof Vs]: Vs[K] extends AnyExpression ? NullOf<InferExpression<Vs[K]>> : never;
}[number];
type TextExpression = Expression<string | null, string, string>;
export type DatePart =
  | 'year'
  | 'quarter'
  | 'month'
  | 'week'
  | 'day'
  | 'hour'
  | 'minute'
  | 'second'
  | 'millisecond'
  | 'microsecond'
  | 'nanosecond';
export type OrderedWindowOptions<S extends string = string> = Pick<
  WindowOptions<S>,
  'partitionBy'
> & { readonly orderBy: readonly [Ordering<S>, ...Ordering<S>[]] };
export type OffsetWindowOptions<S extends string = string> = OrderedWindowOptions<S> & {
  readonly offset?: number;
};
type DefaultResult<E extends AnyExpression, S extends string, D> = Expression<
  NonNullable<InferExpression<E>> | NullOf<InferExpression<E>> | NullOf<ValueOf<D>>,
  ExpressionScope<E> | S | ExpressionScope<D>,
  ExpressionNullScope<E> | ExpressionNullScope<D>
>;
type Numeric = bigint | number | string;
type NumericExpression = Expression<Numeric | null, string, string>;
type Operand<L> = NoInfer<NonNullable<InferExpression<L>>> | NumericExpression;
type ArithmeticValue<A, B, Divide extends boolean> =
  | ([Extract<A | B, number>] extends [never]
      ? [Extract<A | B, string>] extends [never]
        ? Divide extends true
          ? string
          : bigint
        : string
      : number)
  | NullOf<A | B>;
type ArithmeticResult<L extends AnyExpression, R, Divide extends boolean> = Expression<
  ArithmeticValue<InferExpression<L>, ValueOf<R>, Divide>,
  ExpressionScope<L> | ExpressionScope<R>,
  ExpressionNullScope<L> | ExpressionNullScope<R>
>;

const domains: Record<CastType, readonly [CastNode['target'], () => AnyColumn]> = {
  text: ['VARCHAR', () => text('VALUE') as AnyColumn],
  integer: ['NUMBER(38,0)', () => integer('VALUE') as AnyColumn],
  decimal: ['NUMBER(38,0)', () => decimal('VALUE') as AnyColumn],
  float: ['DOUBLE', () => float('VALUE') as AnyColumn],
  boolean: ['BOOLEAN', () => boolean('VALUE') as AnyColumn],
  date: ['DATE', () => date('VALUE') as AnyColumn],
  time: ['TIME', () => time('VALUE') as AnyColumn],
  timestamp_ntz: ['TIMESTAMP_NTZ', () => timestamp('VALUE') as AnyColumn],
  timestamp_ltz: ['TIMESTAMP_LTZ', () => timestamp('VALUE', 'ltz') as AnyColumn],
  timestamp_tz: ['TIMESTAMP_TZ', () => timestamp('VALUE', 'tz') as AnyColumn],
};
function domain(type: CastType): AnyExpression {
  return domains[type][1]().notNull();
}
const literalTypes: Readonly<Record<string, CastType>> = {
  string: 'text',
  bigint: 'integer',
  number: 'float',
  boolean: 'boolean',
};
const dateParts: readonly string[] = ['year', 'quarter', 'month', 'week', 'day'];
const timeParts: readonly string[] = [
  'hour',
  'minute',
  'second',
  'millisecond',
  'microsecond',
  'nanosecond',
];
const temporalTypes: readonly (WireType | undefined)[] = [
  'date',
  'time',
  'timestamp_ntz',
  'timestamp_ltz',
  'timestamp_tz',
];
function nullable(value: AnyExpression): boolean {
  return value.wireType === 'variant' || value.readSchema.safeParse(null).success;
}
function strip(schema: z.ZodType): z.ZodType {
  return schema instanceof z.ZodNullable ? strip(schema.unwrap() as z.ZodType) : schema;
}
function codec(output: AnyExpression): z.ZodType {
  if (!output.wireType) return output.valueSchema;
  return output.wireType in domains
    ? domain(output.wireType as CastType).readSchema
    : output.readSchema;
}
function same(type: AnyExpression, values: readonly AnyExpression[], name: string): void {
  if (values.some((value) => value.wireType !== type.wireType))
    throw new TypeError(`${name} values must share one SQL domain.`);
}
function derive(
  node: ExpressionNode,
  output: AnyExpression,
  isNullable: boolean,
  values: readonly AnyExpression[],
  options: { readonly nullRefs?: readonly SourceReference[]; readonly phase?: 'aggregate' } = {},
): AnyExpression {
  const read = strip(codec(output));
  const value = strip(output.valueSchema);
  return expression(node, isNullable ? read.nullable() : read, {
    ...metadata(values),
    nullRefs: [...new Set(values.flatMap((item) => item.nullRefs))],
    ...options,
    valueSchema: isNullable ? value.nullable() : value,
    ...(output.wireType ? { wireType: output.wireType } : {}),
    encode: (input) => (input === null ? scalarParameter(null) : output.encode(input)),
  });
}
function literal(type: AnyExpression, value: unknown): ExpressionNode {
  const node = type.encode(value);
  if (
    node.kind !== 'parameter' ||
    node.value === null ||
    !type.wireType ||
    type.wireType === 'variant'
  )
    return node;
  let target = domains[type.wireType as CastType][0];
  if (type.wireType === 'decimal') {
    const scale = String(node.value).split('.')[1]?.length ?? 0;
    if (scale > 37) throw new TypeError('Decimal literals support at most 37 fractional digits.');
    target = `NUMBER(38,${scale})`;
  }
  return Object.freeze({ kind: 'cast', value: node, target });
}
function numeric(values: readonly AnyExpression[], divide: boolean): CastType {
  const types = values.map((value) => value.wireType);
  if (types.some((type) => type !== 'integer' && type !== 'decimal' && type !== 'float'))
    throw new TypeError('Numeric helpers require integer, decimal, or float expressions.');
  if (types.includes('float')) return 'float';
  return !divide && types.every((type) => type === 'integer') ? 'integer' : 'decimal';
}
function arithmetic(
  operator: ArithmeticNode['operator'],
  left: AnyExpression,
  right: unknown,
): AnyExpression {
  const values = isExpression(right) ? [left, right] : [left];
  const output = domain(numeric(values, operator === '/'));
  return derive(
    {
      kind: 'arithmetic',
      operator,
      left: left.expression,
      right: isExpression(right) ? right.expression : literal(left, right),
    },
    output,
    values.some(nullable),
    values,
  );
}
function textual(values: readonly AnyExpression[]): void {
  if (values.some((value) => value.wireType))
    throw new TypeError('String helpers require text expressions.');
}
function temporal(value: AnyExpression): WireType | undefined {
  if (!temporalTypes.includes(value.wireType))
    throw new TypeError('Date helpers require date, time, or timestamp expressions.');
  return value.wireType;
}
function partNode(
  part: string,
  types: readonly (WireType | undefined)[],
  timeOfDate = false,
): ExpressionNode {
  if (!dateParts.includes(part) && !timeParts.includes(part))
    throw new TypeError(`Unsupported date part: ${part}.`);
  for (const type of types)
    if (
      (type === 'date' && !timeOfDate && !dateParts.includes(part)) ||
      (type === 'time' && !timeParts.includes(part))
    )
      throw new TypeError(`The ${part} part does not apply to ${type} values.`);
  return Object.freeze({ kind: 'date-part', part: part.toUpperCase() as DatePartNode['part'] });
}
function call(name: string, args: readonly ExpressionNode[]): ExpressionNode {
  return { kind: 'function', name, args: Object.freeze([...args]) };
}
function ordered(name: string, options: OrderedWindowOptions): void {
  if (!options.orderBy?.length) throw new TypeError(`${name} requires ORDER BY.`);
}
function ranking(name: string, options: OrderedWindowOptions): AnyExpression {
  ordered(name, options);
  return over(derive(call(name, []), domain('integer'), false, []), options);
}
function offset(
  name: 'LAG' | 'LEAD',
  value: AnyExpression,
  options: OffsetWindowOptions & { readonly default?: unknown },
): AnyExpression {
  const { offset: rows = 1, default: fallback, ...window } = options;
  ordered(name, window);
  if (!Number.isSafeInteger(rows) || rows < 0)
    throw new TypeError(`${name} offset must be a nonnegative safe integer.`);
  const defaults = isExpression(fallback) ? [fallback] : [];
  same(value, defaults, name);
  const inner = derive(
    call(name, [
      value.expression,
      scalarParameter(rows),
      ...(fallback === undefined
        ? []
        : [isExpression(fallback) ? fallback.expression : literal(value, fallback)]),
    ]),
    value,
    fallback === undefined || nullable(value) || defaults.some(nullable),
    [value, ...defaults],
  );
  return Object.freeze({ ...over(inner, window), nullRefs: inner.nullRefs });
}
function caseExpression(
  branches: readonly (readonly [AnyExpression, unknown])[],
  otherwise?: { readonly value: unknown },
): AnyExpression {
  const values = [...branches.map((branch) => branch[1]), ...(otherwise ? [otherwise.value] : [])];
  const results = values.filter(isExpression);
  const type = results[0] ?? domain(literalTypes[typeof values[0]] as CastType);
  same(type, results, 'CASE');
  const encode = (value: unknown) =>
    isExpression(value) ? value.expression : literal(type, value);
  return derive(
    {
      kind: 'case',
      branches: Object.freeze(
        branches.map(([when, result]) =>
          Object.freeze({ when: when.expression, result: encode(result) }),
        ),
      ),
      ...(otherwise ? { otherwise: encode(otherwise.value) } : {}),
    },
    type,
    !otherwise || results.some(nullable),
    [...branches.map((branch) => branch[0]), ...results],
    { nullRefs: [...new Set(results.flatMap((value) => value.nullRefs))] },
  );
}
function caseBuilder(branches: readonly (readonly [AnyExpression, unknown])[]) {
  return Object.freeze({
    ...caseExpression(branches),
    when: (predicate: AnyExpression, value: unknown) =>
      caseBuilder([...branches, [predicate, value]]),
    else: (value: unknown) => caseExpression(branches, { value }),
  });
}

export function cast<E extends AnyExpression, T extends Exclude<CastType, 'decimal'>>(
  value: E,
  type: T,
): Expression<
  CastValue[T] | NullOf<InferExpression<E>>,
  ExpressionScope<E>,
  ExpressionNullScope<E>
>;
export function cast<E extends AnyExpression>(
  value: E,
  type: 'decimal',
  precision: number,
  scale: number,
): Expression<string | NullOf<InferExpression<E>>, ExpressionScope<E>, ExpressionNullScope<E>>;
export function cast(
  value: AnyExpression,
  type: CastType,
  precision = 38,
  scale = 0,
): AnyExpression {
  if (
    type === 'decimal' &&
    !(
      Number.isSafeInteger(precision) &&
      Number.isSafeInteger(scale) &&
      precision >= 1 &&
      precision <= 38 &&
      scale >= 0 &&
      scale <= Math.min(precision, 37)
    )
  )
    throw new TypeError('DECIMAL casts need precision 1-38 and scale 0-37 within the precision.');
  return derive(
    {
      kind: 'cast',
      value: value.expression,
      target: type === 'decimal' ? `NUMBER(${precision},${scale})` : domains[type][0],
    },
    domain(type),
    nullable(value),
    [value],
  );
}
export function avg<E extends NumericExpression>(
  value: E,
): Expression<
  (NonNullable<InferExpression<E>> extends number ? number : string) | null,
  ExpressionScope<E>
> {
  return derive(call('AVG', [value.expression]), domain(numeric([value], true)), true, [value], {
    phase: 'aggregate',
  }) as Expression<
    (NonNullable<InferExpression<E>> extends number ? number : string) | null,
    ExpressionScope<E>
  >;
}
export function add<L extends NumericExpression, R extends Operand<L>>(
  left: L,
  right: R,
): ArithmeticResult<L, R, false> {
  return arithmetic('+', left, right) as ArithmeticResult<L, R, false>;
}
export function sub<L extends NumericExpression, R extends Operand<L>>(
  left: L,
  right: R,
): ArithmeticResult<L, R, false> {
  return arithmetic('-', left, right) as ArithmeticResult<L, R, false>;
}
export function mul<L extends NumericExpression, R extends Operand<L>>(
  left: L,
  right: R,
): ArithmeticResult<L, R, false> {
  return arithmetic('*', left, right) as ArithmeticResult<L, R, false>;
}
export function div<L extends NumericExpression, R extends Operand<L>>(
  left: L,
  right: R,
): ArithmeticResult<L, R, true> {
  return arithmetic('/', left, right) as ArithmeticResult<L, R, true>;
}
export function coalesce<
  E extends AnyExpression,
  R extends readonly [SameValue<E>, ...SameValue<E>[]],
>(
  first: E,
  ...rest: R
): Expression<
  NonNullable<InferExpression<E>> | AllNullable<[E, ...R]>,
  ExpressionScope<E> | ExpressionScope<R[number]>,
  CoalesceScope<[E, ...R]>
>;
export function coalesce(first: AnyExpression, ...rest: unknown[]): AnyExpression {
  if (!rest.length) throw new TypeError('COALESCE requires at least two values.');
  const values = [first, ...rest.filter(isExpression)];
  same(first, values, 'COALESCE');
  const guards = values.filter((value) => !nullable(value));
  const certain =
    rest.some((value) => !isExpression(value)) ||
    guards.some((value) => value.nullRefs.length === 0);
  return derive(
    call('COALESCE', [
      first.expression,
      ...rest.map((value) => (isExpression(value) ? value.expression : literal(first, value))),
    ]),
    first,
    !guards.length && !certain,
    values,
    { nullRefs: certain ? [] : [...new Set(guards.flatMap((value) => value.nullRefs))] },
  );
}
export function caseWhen<P extends PredicateExpression, V extends Literal | AnyExpression>(
  predicate: P,
  value: V,
): CaseExpression<Widen<V>, ExpressionScope<P> | ExpressionScope<V>, ExpressionNullScope<V>> {
  return caseBuilder([[predicate, value]]) as unknown as CaseExpression<
    Widen<V>,
    ExpressionScope<P> | ExpressionScope<V>,
    ExpressionNullScope<V>
  >;
}
export function concat<E extends TextExpression, R extends readonly (string | TextExpression)[]>(
  first: E,
  ...rest: R
): Expression<
  string | AnyNull<[E, ...R]>,
  ExpressionScope<E> | ExpressionScope<R[number]>,
  ExpressionNullScope<E> | ExpressionNullScope<R[number]>
>;
export function concat(first: AnyExpression, ...rest: unknown[]): AnyExpression {
  const values = [first, ...rest.filter(isExpression)];
  textual(values);
  return derive(
    call('CONCAT', [
      first.expression,
      ...rest.map((value) => (isExpression(value) ? value.expression : literal(first, value))),
    ]),
    domain('text'),
    values.some(nullable),
    values,
  );
}
export function trim<E extends TextExpression>(
  value: E,
): Expression<string | NullOf<InferExpression<E>>, ExpressionScope<E>, ExpressionNullScope<E>> {
  textual([value]);
  return derive(call('TRIM', [value.expression]), domain('text'), nullable(value), [
    value,
  ]) as Expression<string | NullOf<InferExpression<E>>, ExpressionScope<E>, ExpressionNullScope<E>>;
}
export function length<E extends TextExpression>(
  value: E,
): Expression<bigint | NullOf<InferExpression<E>>, ExpressionScope<E>, ExpressionNullScope<E>> {
  textual([value]);
  return derive(call('LENGTH', [value.expression]), domain('integer'), nullable(value), [
    value,
  ]) as Expression<bigint | NullOf<InferExpression<E>>, ExpressionScope<E>, ExpressionNullScope<E>>;
}
export function substring<E extends TextExpression>(
  value: E,
  start: number,
  count?: number,
): Expression<string | NullOf<InferExpression<E>>, ExpressionScope<E>, ExpressionNullScope<E>> {
  textual([value]);
  if (
    !Number.isSafeInteger(start) ||
    (count !== undefined && !(Number.isSafeInteger(count) && count >= 0))
  )
    throw new TypeError('SUBSTR needs an integer start and a nonnegative integer length.');
  return derive(
    call('SUBSTR', [
      value.expression,
      scalarParameter(start),
      ...(count === undefined ? [] : [scalarParameter(count)]),
    ]),
    domain('text'),
    nullable(value),
    [value],
  ) as Expression<string | NullOf<InferExpression<E>>, ExpressionScope<E>, ExpressionNullScope<E>>;
}
export function dateTrunc<E extends TextExpression>(
  part: DatePart,
  value: E,
): Expression<InferExpression<E>, ExpressionScope<E>, ExpressionNullScope<E>> {
  const node = partNode(part, [temporal(value)]);
  return derive(call('DATE_TRUNC', [node, value.expression]), value, nullable(value), [
    value,
  ]) as Expression<InferExpression<E>, ExpressionScope<E>, ExpressionNullScope<E>>;
}
export function dateAdd<E extends TextExpression, A extends bigint | Expression<bigint | null>>(
  part: DatePart,
  amount: A,
  value: E,
): Expression<
  NonNullable<InferExpression<E>> | NullOf<InferExpression<E> | ValueOf<A>>,
  ExpressionScope<E> | ExpressionScope<A>,
  ExpressionNullScope<E> | ExpressionNullScope<A>
> {
  const type = temporal(value);
  const node = partNode(part, [type], true);
  const values = isExpression(amount) ? [value, amount] : [value];
  return derive(
    call('DATEADD', [
      node,
      isExpression(amount) ? amount.expression : literal(domain('integer'), amount),
      value.expression,
    ]),
    type === 'date' && timeParts.includes(part) ? domain('timestamp_ntz') : value,
    values.some(nullable),
    values,
  ) as Expression<
    NonNullable<InferExpression<E>> | NullOf<InferExpression<E> | ValueOf<A>>,
    ExpressionScope<E> | ExpressionScope<A>,
    ExpressionNullScope<E> | ExpressionNullScope<A>
  >;
}
export function dateDiff<S extends TextExpression, E extends string | TextExpression>(
  part: DatePart,
  start: S,
  end: E,
): Expression<
  bigint | NullOf<InferExpression<S> | ValueOf<E>>,
  ExpressionScope<S> | ExpressionScope<E>,
  ExpressionNullScope<S> | ExpressionNullScope<E>
> {
  const values = isExpression(end) ? [start, end] : [start];
  const types = values.map(temporal);
  if (types.includes('time') && types.some((type) => type !== 'time'))
    throw new TypeError('dateDiff cannot mix time values with date or timestamp values.');
  const node = partNode(part, types, true);
  return derive(
    call('DATEDIFF', [
      node,
      start.expression,
      isExpression(end) ? end.expression : literal(start, end),
    ]),
    domain('integer'),
    values.some(nullable),
    values,
  ) as Expression<
    bigint | NullOf<InferExpression<S> | ValueOf<E>>,
    ExpressionScope<S> | ExpressionScope<E>,
    ExpressionNullScope<S> | ExpressionNullScope<E>
  >;
}
export function datePart<E extends TextExpression>(
  part: Exclude<DatePart, 'millisecond' | 'microsecond'>,
  value: E,
): Expression<bigint | NullOf<InferExpression<E>>, ExpressionScope<E>, ExpressionNullScope<E>> {
  if ((['millisecond', 'microsecond'] as readonly string[]).includes(part))
    throw new TypeError('DATE_PART does not support millisecond or microsecond parts.');
  const node = partNode(part, [temporal(value)]);
  return derive(call('DATE_PART', [node, value.expression]), domain('integer'), nullable(value), [
    value,
  ]) as Expression<bigint | NullOf<InferExpression<E>>, ExpressionScope<E>, ExpressionNullScope<E>>;
}
export function rank<S extends string = never>(
  options: OrderedWindowOptions<S>,
): Expression<bigint, S, never> {
  return ranking('RANK', options) as Expression<bigint, S, never>;
}
export function denseRank<S extends string = never>(
  options: OrderedWindowOptions<S>,
): Expression<bigint, S, never> {
  return ranking('DENSE_RANK', options) as Expression<bigint, S, never>;
}
export function lag<E extends AnyExpression, D extends SameValue<E>, S extends string = never>(
  value: E,
  options: OffsetWindowOptions<S> & { readonly default: D },
): DefaultResult<E, S, D>;
export function lag<E extends AnyExpression, S extends string = never>(
  value: E,
  options: OffsetWindowOptions<S>,
): Expression<InferExpression<E> | null, ExpressionScope<E> | S, ExpressionNullScope<E>>;
export function lag(
  value: AnyExpression,
  options: OffsetWindowOptions & { readonly default?: unknown },
): AnyExpression {
  return offset('LAG', value, options);
}
export function lead<E extends AnyExpression, D extends SameValue<E>, S extends string = never>(
  value: E,
  options: OffsetWindowOptions<S> & { readonly default: D },
): DefaultResult<E, S, D>;
export function lead<E extends AnyExpression, S extends string = never>(
  value: E,
  options: OffsetWindowOptions<S>,
): Expression<InferExpression<E> | null, ExpressionScope<E> | S, ExpressionNullScope<E>>;
export function lead(
  value: AnyExpression,
  options: OffsetWindowOptions & { readonly default?: unknown },
): AnyExpression {
  return offset('LEAD', value, options);
}
