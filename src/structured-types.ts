import * as z from 'zod';
import {
  boolean as booleanColumn,
  type ColumnValue,
  decimal as decimalColumn,
  integer as integerColumn,
  text as textColumn,
  writeSchema,
} from './schema.js';
import {
  type AnyStructuredType,
  type InferStructured,
  JsonNumber,
  type StructuredType,
} from './structured.js';

type MapKey = StructuredType<bigint, boolean> | StructuredType<string, boolean>;
type Fields = Readonly<Record<string, AnyStructuredType>>;

function structuredType<T, R extends boolean>(
  sql: string,
  decode: z.ZodType<T>,
  value: z.ZodType<T>,
  toJson: (value: T) => string,
  required: R,
): StructuredType<T, R> {
  const nullable = (schema: z.ZodType<T>) =>
    (required ? schema : schema.nullable()) as z.ZodType<ColumnValue<T, R>>;
  return Object.freeze({
    sql,
    required,
    decode: nullable(decode),
    value: nullable(value),
    toJson: (input: ColumnValue<T, R>) => (input === null ? 'null' : toJson(input as T)),
    notNull: () => structuredType(sql, decode, value, toJson, true),
  });
}
const number = () => z.instanceof(JsonNumber).transform((value) => value.source);

export function integer(options: { readonly precision?: number } = {}): StructuredType<bigint> {
  const column = integerColumn('VALUE', options).notNull();
  return structuredType(
    `NUMBER(${column.constraints.precision ?? 38},0)`,
    number().pipe(column.readSchema as z.ZodType<bigint, string>),
    writeSchema(column),
    String,
    false,
  );
}
/** Defaults follow Snowflake NUMBER: precision 38, scale 0. */
export function decimal(
  options: { readonly precision?: number; readonly scale?: number } = {},
): StructuredType<string> {
  const column = decimalColumn('VALUE', {
    precision: options.precision ?? 38,
    scale: options.scale ?? 0,
  }).notNull();
  const scale = column.constraints.scale as number;
  return structuredType(
    `NUMBER(${column.constraints.precision},${scale})`,
    // TO_JSON drops trailing zeros; pad to the declared scale like top-level decimal() reads.
    number()
      .pipe(column.readSchema as z.ZodType<string, string>)
      .transform((value) => {
        const [whole, fraction = ''] = value.split('.');
        return scale ? `${whole}.${fraction.padEnd(scale, '0')}` : value;
      }),
    writeSchema(column),
    (value) => value.replace(/^(-?)0+(?=\d)/, '$1'),
    false,
  );
}
export function text(options: { readonly length?: number } = {}): StructuredType<string> {
  const column = textColumn('VALUE', options).notNull();
  const { length } = column.constraints;
  return structuredType(
    length === undefined ? 'VARCHAR' : `VARCHAR(${length})`,
    column.readSchema,
    writeSchema(column),
    JSON.stringify,
    false,
  );
}
export function boolean(): StructuredType<boolean> {
  const column = booleanColumn('VALUE').notNull();
  return structuredType('BOOLEAN', column.readSchema, writeSchema(column), String, false);
}
export function array<E extends AnyStructuredType>(
  element: E,
): StructuredType<InferStructured<E>[]> {
  return structuredType(
    `ARRAY(${element.sql})`,
    z.array(element.decode) as z.ZodType<InferStructured<E>[]>,
    z.array(element.value) as z.ZodType<InferStructured<E>[]>,
    (values) => `[${values.map((value) => element.toJson(value)).join(',')}]`,
    false,
  );
}
export function object<const F extends Fields>(
  fields: F,
): StructuredType<{ -readonly [K in keyof F]: InferStructured<F[K]> }> {
  type T = { -readonly [K in keyof F]: InferStructured<F[K]> };
  const entries = Object.entries(fields);
  const shape = (schema: (type: AnyStructuredType) => z.ZodType) =>
    z.strictObject(Object.fromEntries(entries.map(([key, type]) => [key, schema(type)])));
  return structuredType(
    `OBJECT(${entries.map(([key, type]) => `"${key.replaceAll('"', '""')}" ${type.sql}`).join(', ')})`,
    shape((type) => type.decode) as unknown as z.ZodType<T>,
    shape((type) => type.value) as unknown as z.ZodType<T>,
    (value) =>
      `{${entries.map(([key, type]) => `${JSON.stringify(key)}:${type.toJson((value as Record<string, unknown>)[key])}`).join(',')}}`,
    false,
  );
}
export function map<K extends MapKey, V extends AnyStructuredType>(
  key: K,
  value: V,
): StructuredType<Map<NonNullable<InferStructured<K>>, InferStructured<V>>> {
  type T = Map<NonNullable<InferStructured<K>>, InferStructured<V>>;
  const keys = key.notNull() as StructuredType<unknown, true>;
  if (/^NUMBER\(\d+,(?!0\))/.test(keys.sql))
    throw new TypeError('MAP keys must be VARCHAR or NUMBER with scale 0.');
  const decodeKey = keys.sql.startsWith('NUMBER')
    ? z
        .string()
        .transform((source) => new JsonNumber(source))
        .pipe(keys.decode as z.ZodType<unknown, JsonNumber>)
    : keys.decode;
  const entries = z.array(z.tuple([decodeKey, value.decode])) as z.ZodType<
    [unknown, unknown][],
    [string, unknown][]
  >;
  return structuredType(
    `MAP(${keys.sql}, ${value.sql})`,
    z
      .record(z.string(), z.unknown())
      .transform((record) => Object.entries(record))
      .pipe(entries)
      .transform((pairs) => new Map(pairs)) as unknown as z.ZodType<T>,
    z.map(keys.value, value.value) as unknown as z.ZodType<T>,
    (entries) =>
      `{${[...entries].map(([entry, item]) => `${JSON.stringify(String(entry))}:${value.toJson(item)}`).join(',')}}`,
    false,
  );
}
