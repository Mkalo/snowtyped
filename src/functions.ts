import type { CastNode, ExpressionNode } from './ast.js';
import {
  type AnyExpression,
  type Expression,
  type ExpressionNullScope,
  type ExpressionScope,
  expression,
  type InferExpression,
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
): AnyExpression {
  const read = output.readSchema;
  const value = output.valueSchema;
  return expression(node, isNullable ? read.nullable() : read, {
    ...metadata(values),
    nullRefs: [...new Set(values.flatMap((item) => item.nullRefs))],
    valueSchema: isNullable ? value.nullable() : value,
    ...(output.wireType ? { wireType: output.wireType } : {}),
    encode: (input) => (input === null ? scalarParameter(null) : output.encode(input)),
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
