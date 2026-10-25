import type * as z from 'zod';
import { jsonText, scalarParameter } from './expressions.js';
import { type Column, type ColumnValue, column } from './schema.js';

/**
 * A Snowflake structured type, created with the {@link structuredType} factories and declared as a
 * column with {@link structured}.
 *
 * Elements, fields, and MAP values are nullable until `.notNull()`.
 */
export interface StructuredType<T, Required extends boolean = false> {
  /** The type's SQL spelling, such as `ARRAY(NUMBER(38,0))`. */
  readonly sql: string;
  /** Whether values of this type are NOT NULL. */
  readonly required: Required;
  /** Decodes a parsed JSON value whose numbers are kept as exact text. */
  readonly decode: z.ZodType<ColumnValue<T, Required>>;
  /** Validates JavaScript values written to the type. */
  readonly value: z.ZodType<ColumnValue<T, Required>>;
  /** Encodes a value as JSON for `PARSE_JSON(...)::type`. */
  toJson(value: ColumnValue<T, Required>): string;
  /** Declares the elements, fields, or values of this type NOT NULL. */
  notNull(): StructuredType<T, true>;
}
/** A structured type of any value and nullability. */
export type AnyStructuredType = StructuredType<unknown, boolean>;
/** The TypeScript value of a structured type. */
export type InferStructured<S> =
  S extends StructuredType<infer T, infer R> ? ColumnValue<T, R> : never;

export class JsonNumber {
  constructor(readonly source: string) {}
}

/**
 * Declares a structured ARRAY, OBJECT, or MAP column.
 *
 * OBJECT values must have exactly the declared keys, and MAP values are JavaScript `Map`s. Writes
 * are cast to the declared type, and structured values are compared and assigned only with the same
 * structured type.
 *
 * @param name - The physical column name, quoted exactly as given.
 * @param type - The column's type, built with {@link structuredType}.
 * @example
 * ```ts
 * const profiles = snowflakeTable('PROFILES', {
 *   scores: structured('SCORES', structuredType.array(structuredType.integer().notNull())),
 *   address: structured(
 *     'ADDRESS',
 *     structuredType.object({ city: structuredType.text(), zip: structuredType.text() }),
 *   ),
 * });
 * ```
 */
export function structured<T>(
  name: string,
  type: StructuredType<T, boolean>,
): Column<T, false, string, 'none', 'structured'> {
  const required = type.notNull();
  return column(
    name,
    'structured',
    jsonText((_value, source) => new JsonNumber(source)).pipe(required.decode),
    required.value,
    false,
    { constraints: { structure: required.sql }, type: required.sql },
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
