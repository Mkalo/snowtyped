import type { ArithmeticNode, CastNode, ExpressionNode } from './ast.js';
import {
  type AnyExpression,
  type Expression,
  type ExpressionNullScope,
  type ExpressionScope,
  expression,
  type InferExpression,
  isExpression,
  metadata,
  scalarParameter,
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
function nullable(value: AnyExpression): boolean {
  return value.wireType === 'variant' || value.readSchema.safeParse(null).success;
}
function derive(
  node: ExpressionNode,
  output: AnyExpression,
  isNullable: boolean,
  values: readonly AnyExpression[],
  options: { readonly phase?: 'aggregate' } = {},
): AnyExpression {
  const read = output.readSchema;
  const value = output.valueSchema;
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
  if (node.kind !== 'parameter' || node.value === null) return node;
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
  return derive(
    { kind: 'function', name: 'AVG', args: Object.freeze([value.expression]) },
    domain(numeric([value], true)),
    true,
    [value],
    { phase: 'aggregate' },
  ) as Expression<
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
