import * as z from 'zod';
import { jsonText, scalarParameter } from './expressions.js';
import { type Column, type ColumnValue, column } from './schema.js';

/** A Snowflake structured type: its SQL spelling, JSON decoding, validation, and JSON encoding. */
export interface StructuredType<T, Required extends boolean = false> {
  readonly sql: string;
  readonly required: Required;
  /** Decodes a parsed JSON value whose numbers are kept as {@link JsonNumber}. */
  readonly decode: z.ZodType<ColumnValue<T, Required>>;
  readonly value: z.ZodType<ColumnValue<T, Required>>;
  toJson(value: ColumnValue<T, Required>): string;
  notNull(): StructuredType<T, true>;
}
export type AnyStructuredType = StructuredType<unknown, boolean>;
export type InferStructured<S> =
  S extends StructuredType<infer T, infer R> ? ColumnValue<T, R> : never;

export class JsonNumber {
  constructor(readonly source: string) {}
}

/** Snowflake prints SQL NULL elements as `undefined`, which is not JSON. */
const structuredJson = () =>
  z
    .string()
    .transform((input) =>
      input.replace(/"(?:[^"\\]|\\.)*"|undefined/g, (token) =>
        token === 'undefined' ? 'null' : token,
      ),
    )
    .pipe(jsonText((_value, source) => new JsonNumber(source)));

export function structured<T>(name: string, type: StructuredType<T, boolean>): Column<T> {
  const required = type.notNull();
  return column(
    name,
    'structured',
    structuredJson().pipe(required.decode),
    required.value,
    false,
    undefined,
    (value) =>
      Object.freeze({
        kind: 'cast',
        value: Object.freeze({
          kind: 'function',
          name: 'PARSE_JSON',
          args: Object.freeze([scalarParameter(value === null ? null : required.toJson(value))]),
        }),
        target: required.sql as `ARRAY(${string})` | `OBJECT(${string})` | `MAP(${string})`,
      }),
  );
}
