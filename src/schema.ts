import * as z from 'zod';
import {
  type ExpressionNode,
  type IdentifierNode,
  identifier,
  type RelationNode,
  type SourceReference,
  type WireType,
} from './ast.js';
import {
  type AnyExpression,
  type Expression,
  type ExpressionNullScope,
  expression,
  type InferExpression,
  jsonText,
  scalarParameter,
} from './expressions.js';
import { decodeEwkb, type GeoJsonGeometry, geoJson } from './spatial.js';

/**
 * A column's TypeScript value: `T` when the column is required (NOT NULL), otherwise `T | null`.
 */
export type ColumnValue<T, Required extends boolean> = Required extends true ? T : T | null;
/**
 * The SQL type of a column or expression. Comparisons, functions, and assignments check it before a
 * query runs.
 */
export type DataType =
  | 'text'
  | 'integer'
  | 'decimal'
  | 'boolean'
  | 'float'
  | 'date'
  | 'time'
  | 'timestamp_ntz'
  | 'timestamp_ltz'
  | 'timestamp_tz'
  | 'variant'
  | 'array'
  | 'object'
  | 'binary'
  | 'geography'
  | 'geometry'
  | 'vector'
  | 'structured';
/** The kinds of server-populated values a column can declare, keyed by {@link ServerValueKind}. */
export interface ServerValues {
  /** No server value. */
  readonly none: null;
  /** A DEFAULT, declared with `.serverDefault()`. The expression is trusted SQL text. */
  readonly default: { readonly kind: 'default'; readonly expression?: string };
  /** An identity column, declared with `.identity()`. */
  readonly identity: {
    readonly kind: 'identity';
    readonly start?: number;
    readonly increment?: number;
    readonly order?: boolean;
  };
  /** A computed `AS (expression)` column, declared with `.virtual()`. It is read-only. */
  readonly virtual: { readonly kind: 'virtual'; readonly expression?: string };
}
/** The server value a column declares: `'none'`, `'default'`, `'identity'`, or `'virtual'`. */
export type ServerValueKind = keyof ServerValues;
/** A declared server value. */
export type ServerValue = NonNullable<ServerValues[ServerValueKind]>;
/**
 * The `start`, `increment`, and `order` of an identity column. Start and increment are safe
 * integers, and increment cannot be zero.
 */
export type IdentityOptions = Omit<ServerValues['identity'], 'kind'>;
export interface ColumnConstraints {
  readonly precision?: number;
  readonly scale?: number;
  readonly length?: number;
  readonly dimension?: number;
  readonly element?: 'int' | 'float';
  readonly srid?: number;
  /** The SQL spelling of a structured ARRAY, OBJECT, or MAP type. */
  readonly structure?: string;
}
/**
 * A declared table column, created by a column factory such as {@link text} or {@link integer}.
 *
 * A column is an {@link Expression} of its source, so it can be projected, compared, and passed to
 * functions. Columns are nullable until `.notNull()`. Modifiers return a new column.
 *
 * @typeParam T - The decoded value, without `null`.
 * @typeParam Required - `true` once the column is declared NOT NULL.
 * @typeParam Scope - The name of the table the column belongs to.
 * @typeParam Server - The server value the column declares.
 * @typeParam D - The column's SQL type.
 */
export interface Column<
  T,
  Required extends boolean = false,
  Scope extends string = string,
  Server extends ServerValueKind = 'none',
  D extends DataType = DataType,
> extends Expression<ColumnValue<T, Required>, Scope, Scope, D> {
  /** The physical column name. */
  readonly node: IdentifierNode;
  /** Whether the column is NOT NULL. */
  readonly required: Required;
  /** Declared precision, scale, length, and other type constraints. */
  readonly constraints: ColumnConstraints;
  /** The declared server value, or `null`. */
  readonly serverValue: ServerValues[Server];
  /**
   * Validates a value against the column's declared constraints and encodes it for INSERT, UPDATE,
   * or MERGE.
   */
  encodeWrite(value: ColumnValue<T, Required>): ExpressionNode;
  /**
   * Declares the column NOT NULL, which removes `null` from its type and makes it required on
   * insert unless it has a server value.
   */
  notNull(): Column<T, true, Scope, Server, D>;
  /**
   * Declares a server DEFAULT, which makes the column optional on insert. `snowtyped/ddl` renders
   * the expression, which is trusted SQL text, as `DEFAULT expression`.
   */
  serverDefault(expression?: string): Column<T, Required, Scope, 'default', D>;
  /**
   * Declares an identity column, which makes it optional on insert. `snowtyped/ddl` renders it as
   * `AUTOINCREMENT`.
   *
   * @throws `TypeError` when start or increment is not a safe integer or increment is zero.
   */
  identity(options?: IdentityOptions): Column<T, Required, Scope, 'identity', D>;
  /**
   * Declares a computed `AS (expression)` column. Virtual columns are read-only: insert, update,
   * and MERGE values exclude them.
   */
  virtual(expression?: string): Column<T, Required, Scope, 'virtual', D>;
}
/** A column of any type, scope, and server value. */
export type AnyColumn = Column<unknown, boolean, string, ServerValueKind>;
/** The TypeScript value of a column, including `null` unless it is NOT NULL. */
export type InferColumn<C> =
  C extends Column<infer T, infer R, string, ServerValueKind> ? ColumnValue<T, R> : never;
/** The columns of a table, keyed by the names used in TypeScript. */
export type ColumnMap = Readonly<Record<string, AnyColumn>>;
/** A flat projection: output aliases mapped to expressions. */
export type Selection = Readonly<Record<string, AnyExpression>>;
/** A selection whose entries may be nested objects of further entries. */
export type Projection = { readonly [key: string]: AnyExpression | Projection };
type Leaf = { readonly dataType: DataType };
/**
 * A nested object's keys are its direct NOT NULL entries: 'always' when no outer join can null
 * them, otherwise the outer-joined sources a non-NULL key proves present. Only a column proves its
 * source; an expression such as COALESCE can be non-NULL with some of its sources absent.
 */
type PresenceKeys<P, Nullable extends string> = {
  [K in keyof P]: P[K] extends Leaf
    ? null extends InferExpression<P[K]>
      ? never
      : [Extract<ExpressionNullScope<P[K]>, Nullable>] extends [never]
        ? 'always'
        : [
            P[K] extends { readonly required: boolean }
              ? Extract<ExpressionNullScope<P[K]>, Nullable>
              : never,
          ]
    : never;
}[keyof P];
type KeyScopes<K> = K extends readonly [infer N] ? N : never;
type MissingScopes<K, All> = K extends readonly [infer N] ? Exclude<All, N> : never;
/** A present object proves the sources shared by every key; one non-NULL key suffices. */
type ProvenScopes<K> = Exclude<KeyScopes<K>, MissingScopes<K, KeyScopes<K>>>;
type InferNested<P extends Projection, Nullable extends string> = [
  PresenceKeys<P, Nullable>,
] extends [never]
  ? InferSelection<P, Nullable>
  : 'always' extends PresenceKeys<P, Nullable>
    ? InferSelection<P, Nullable>
    : InferSelection<P, Exclude<Nullable, ProvenScopes<PresenceKeys<P, Nullable>>>> | null;
/**
 * The row type of a projection. Columns of the `Nullable` sources, which an outer join can leave
 * absent, become nullable.
 *
 * @example
 * ```ts
 * type Customer = InferSelection<typeof customers.columns>;
 * // { id: bigint; name: string; email: string | null }
 * ```
 */
export type InferSelection<S extends Projection, Nullable extends string = never> = {
  [K in keyof S]: S[K] extends Leaf
    ?
        | InferExpression<S[K]>
        | (Extract<ExpressionNullScope<S[K]>, Nullable> extends never ? never : null)
    : S[K] extends Projection
      ? InferNested<S[K], Nullable>
      : never;
};
/** The columns of a table bound to the source name `Name`. */
export type BoundColumns<C extends ColumnMap, Name extends string> = {
  [K in keyof C]: C[K] extends Column<infer T, infer R, string, infer S, infer D>
    ? Column<T, R, Name, S, D>
    : never;
};
interface Constraint<T> {
  readonly constraints: ColumnConstraints;
  readonly type: string;
  check?(value: T): boolean;
}

function serverExpression(kind: 'default' | 'virtual', expression: string | undefined) {
  if (expression !== undefined && !expression.trim())
    throw new TypeError('Server value expressions cannot be empty.');
  return Object.freeze({ kind, ...(expression === undefined ? {} : { expression }) });
}
function identityValue(options: IdentityOptions) {
  for (const key of ['start', 'increment'] as const) {
    const value = options[key];
    if (value !== undefined && (!Number.isSafeInteger(value) || (key === 'increment' && !value)))
      throw new TypeError(
        'Identity start and increment must be safe integers, and increment cannot be zero.',
      );
  }
  return Object.freeze({ kind: 'identity' as const, ...options });
}
const writeSchemas = new WeakMap<AnyColumn, z.ZodType>();
/** The constrained schema a required column validates INSERT, UPDATE, and MERGE values with. */
export function writeSchema<T>(value: Column<T, true>): z.ZodType<T> {
  return writeSchemas.get(value as AnyColumn) as z.ZodType<T>;
}
export function column<
  T,
  R extends boolean,
  S extends ServerValueKind = 'none',
  D extends DataType = DataType,
>(
  name: string,
  dataType: D,
  read: z.ZodType<T>,
  value: z.ZodType<T>,
  required: R,
  constraint?: Constraint<T>,
  write?: (value: T | null) => ExpressionNode,
  serverValue: ServerValue | null = null,
): Column<T, R, string, S, D> {
  const constrained = (schema: z.ZodType<T>) =>
    constraint?.check
      ? schema.refine(constraint.check, `Value does not fit ${constraint.type}.`)
      : schema;
  const nullable = (schema: z.ZodType<T>) =>
    (required ? schema : schema.nullable()) as z.ZodType<ColumnValue<T, R>>;
  const readSchema = nullable(constrained(read));
  const valueSchema = nullable(value);
  const writeSchema = nullable(constrained(value));
  const node = identifier(name);
  function encode(parsed: ColumnValue<T, R>): ExpressionNode {
    if (write) return write(parsed);
    // NULL goes through the same wrapper so it carries the column type; a bare NULL
    // bind is VARCHAR, which Snowflake rejects for VARIANT and BINARY in INSERT ... SELECT.
    if (dataType === 'variant') return parseJson(dataType, parsed);
    if (dataType === 'array' || dataType === 'object')
      return Object.freeze({
        kind: 'cast',
        value: parseJson(dataType, parsed),
        target: dataType === 'array' ? 'ARRAY' : 'OBJECT',
      });
    if (dataType === 'binary')
      return Object.freeze({
        kind: 'function',
        name: 'TO_BINARY',
        args: Object.freeze([
          scalarParameter(
            parsed === null ? null : Buffer.from(parsed as Uint8Array).toString('hex'),
          ),
          scalarParameter('HEX'),
        ]),
      });
    return scalarParameter(parsed);
  }
  const wireType: WireType | undefined = ['text', 'boolean', 'binary'].includes(dataType)
    ? undefined
    : ['array', 'object', 'vector'].includes(dataType)
      ? 'variant'
      : (dataType as WireType);
  const result = Object.freeze({
    ...expression(node, readSchema, {
      dataType,
      valueSchema,
      ...(wireType ? { wireType } : {}),
      encode,
    }),
    node,
    required,
    constraints: Object.freeze({ ...constraint?.constraints }),
    serverValue: serverValue as ServerValues[S],
    encodeWrite: (input: ColumnValue<T, R>) => encode(writeSchema.parse(input)),
    notNull: () =>
      column<T, true, S, D>(name, dataType, read, value, true, constraint, write, serverValue),
    serverDefault: (expression?: string) =>
      column<T, R, 'default', D>(
        name,
        dataType,
        read,
        value,
        required,
        constraint,
        write,
        serverExpression('default', expression),
      ),
    identity: (options: IdentityOptions = {}) =>
      column<T, R, 'identity', D>(
        name,
        dataType,
        read,
        value,
        required,
        constraint,
        write,
        identityValue(options),
      ),
    virtual: (expression?: string) =>
      column<T, R, 'virtual', D>(
        name,
        dataType,
        read,
        value,
        required,
        constraint,
        write,
        serverExpression('virtual', expression),
      ),
  }) as Column<T, R, string, S, D>;
  writeSchemas.set(result as AnyColumn, writeSchema);
  return result;
}
/** A NULL bind still parses to a typed NULL, so mixed rows keep one SQL type. */
function parseJson(dataType: DataType, value: unknown): ExpressionNode {
  const encoded = value === null ? null : JSON.stringify(value);
  if (encoded === undefined)
    throw new TypeError(`${dataType.toUpperCase()} values must be JSON serializable.`);
  return Object.freeze({
    kind: 'function',
    name: 'PARSE_JSON',
    args: Object.freeze([scalarParameter(encoded)]),
  });
}
const json = <T>(schema: z.ZodType<T>, number?: (value: number) => unknown) =>
  jsonText(number).pipe(schema);
function bounded(label: string, value: number, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new TypeError(`${label} must be an integer from ${min} to ${max}.`);
  return value;
}
function epochFraction(value: string): string {
  if (!/^[+-]?\d+$/.test(value)) return '';
  const epoch = BigInt(value);
  const scale =
    epoch < 31536000000n ? 0 : epoch < 31536000000000n ? 3 : epoch < 31536000000000000n ? 6 : 9;
  return value.slice(value.length - scale);
}
function fraction(value: string, precision: number): boolean {
  const match = /\d:\d{2}:\d{2}\.(\d+)|^[+-]?\d+\.(\d+)$/.exec(value);
  const digits = match?.[1] ?? match?.[2] ?? epochFraction(value);
  return digits.replace(/0+$/, '').length <= precision;
}
function fractional(type: string, options: { readonly precision?: number }) {
  if (options.precision === undefined) return undefined;
  const precision = bounded('Fractional seconds precision', options.precision, 0, 9);
  return {
    constraints: { precision },
    type: `${type}(${precision})`,
    check: (value: string) => fraction(value, precision),
  };
}
/**
 * Declares a TEXT (VARCHAR) column that decodes as `string`.
 *
 * @param name - The physical column name, quoted exactly as given.
 * @param options - `length` declares VARCHAR(length); longer values are rejected. Length counts
 * code points.
 * @example
 * ```ts
 * const users = snowflakeTable('USERS', {
 *   id: integer('ID').notNull(),
 *   name: text('NAME', { length: 100 }).notNull(),
 * });
 * ```
 */
export function text(
  name: string,
  options: { readonly length?: number } = {},
): Column<string, false, string, 'none', 'text'> {
  const length =
    options.length === undefined ? undefined : bounded('Length', options.length, 1, 134217728);
  return column(
    name,
    'text',
    z.string(),
    z.string(),
    false,
    length === undefined
      ? undefined
      : {
          constraints: { length },
          type: `VARCHAR(${length})`,
          check: (value) => value.length <= length || [...value].length <= length,
        },
  );
}
/**
 * Declares an integral NUMBER column that decodes as `bigint`, covering all 38 digits.
 *
 * @param name - The physical column name, quoted exactly as given.
 * @param options - `precision` declares NUMBER(precision, 0); values with more digits are rejected.
 */
export function integer(
  name: string,
  options: { readonly precision?: number } = {},
): Column<bigint, false, string, 'none', 'integer'> {
  const precision =
    options.precision === undefined ? undefined : bounded('Precision', options.precision, 1, 38);
  const limit = 10n ** BigInt(precision ?? 0);
  return column(
    name,
    'integer',
    z
      .string()
      .regex(/^-?\d+$/)
      .transform(BigInt),
    z.bigint(),
    false,
    precision === undefined
      ? undefined
      : {
          constraints: { precision, scale: 0 },
          type: `NUMBER(${precision},0)`,
          check: (value) => (value < 0n ? -value : value) < limit,
        },
  );
}
/**
 * Declares a fixed-point NUMBER column that decodes as exact decimal text, such as `"12.50"`.
 *
 * @param name - The physical column name, quoted exactly as given.
 * @param options - `precision` and `scale` declare NUMBER(precision, scale); values that would be
 * rounded or do not fit are rejected.
 */
export function decimal(
  name: string,
  options: { readonly precision?: number; readonly scale?: number } = {},
): Column<string, false, string, 'none', 'decimal'> {
  const schema = z.string().regex(/^-?\d+(?:\.\d+)?$/);
  if (options.precision === undefined && options.scale === undefined)
    return column(name, 'decimal', schema, schema, false);
  const precision = bounded('Precision', options.precision ?? 38, 1, 38);
  const scale = bounded('Scale', options.scale ?? 0, 0, Math.min(precision, 37));
  return column(name, 'decimal', schema, schema, false, {
    constraints: { precision, scale },
    type: `NUMBER(${precision},${scale})`,
    check(value) {
      const match = /^-?(\d+)(?:\.(\d+))?$/.exec(value);
      if (!match) return true;
      const [, whole, digits = ''] = match;
      return (
        (whole as string).replace(/^0+/, '').length <= precision - scale &&
        digits.replace(/0+$/, '').length <= scale
      );
    },
  });
}
/**
 * Declares a BOOLEAN column.
 *
 * @param name - The physical column name, quoted exactly as given.
 */
export function boolean(name: string): Column<boolean, false, string, 'none', 'boolean'> {
  return column(name, 'boolean', z.boolean(), z.boolean(), false);
}
/** Decodes `<significand>p<exponent>` wire text; plain numeric text is also accepted. */
function decodeFloat(value: string): number {
  const match = /^(-?\d+)p(-?\d+)$/.exec(value);
  if (!match) return Number(value);
  const exponent = Number(match[2]);
  const half = Math.trunc(exponent / 2);
  return Number(match[1]) * 2 ** half * 2 ** (exponent - half);
}
/**
 * Declares a FLOAT (DOUBLE) column that decodes as a finite `number`, exactly equal to the stored
 * value.
 *
 * @param name - The physical column name, quoted exactly as given.
 */
export function float(name: string): Column<number, false, string, 'none', 'float'> {
  return column(
    name,
    'float',
    z.string().transform(decodeFloat).pipe(z.number().finite()),
    z.number().finite(),
    false,
  );
}
/**
 * Declares a DATE column that decodes as text such as `"2026-10-22"`.
 *
 * @param name - The physical column name, quoted exactly as given.
 */
export function date(name: string): Column<string, false, string, 'none', 'date'> {
  return column(name, 'date', z.string(), z.iso.date(), false);
}
/**
 * Declares a TIME column that decodes as text with up to nine fractional digits.
 *
 * @param name - The physical column name, quoted exactly as given.
 * @param options - `precision` declares TIME(precision); values with more fractional digits are
 * rejected.
 */
export function time(
  name: string,
  options: { readonly precision?: number } = {},
): Column<string, false, string, 'none', 'time'> {
  return column(
    name,
    'time',
    z.string(),
    z.string().regex(/^\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?$/),
    false,
    fractional('TIME', options),
  );
}
/**
 * Declares a TIMESTAMP_NTZ column that decodes as text with nanoseconds retained.
 *
 * @param name - The physical column name, quoted exactly as given.
 */
export function timestamp(name: string): Column<string, false, string, 'none', 'timestamp_ntz'>;
/**
 * Declares a TIMESTAMP_NTZ, TIMESTAMP_LTZ, or TIMESTAMP_TZ column that decodes as text with
 * nanoseconds retained. LTZ and TZ values include their offset.
 *
 * @param name - The physical column name, quoted exactly as given.
 * @param mode - `'ntz'`, `'ltz'`, or `'tz'`.
 * @param options - `precision` declares the fractional seconds precision; values with more
 * fractional digits are rejected.
 */
export function timestamp<M extends 'ntz' | 'ltz' | 'tz'>(
  name: string,
  mode: M,
  options?: { readonly precision?: number },
): Column<string, false, string, 'none', `timestamp_${M}`>;
export function timestamp(
  name: string,
  mode: 'ntz' | 'ltz' | 'tz' = 'ntz',
  options: { readonly precision?: number } = {},
): Column<string, false, string, 'none', `timestamp_${typeof mode}`> {
  return column(
    name,
    `timestamp_${mode}`,
    z.string(),
    z.string().min(1),
    false,
    fractional(`TIMESTAMP_${mode.toUpperCase()}`, options),
  );
}
/**
 * Declares a VARIANT column that decodes as `unknown` JSON.
 *
 * An explicit `null` writes SQL NULL, not JSON `null`.
 *
 * @param name - The physical column name, quoted exactly as given.
 */
export function variant(name: string): Column<unknown, false, string, 'none', 'variant'>;
/**
 * Declares a VARIANT column with a JSON shape. Values are validated with `schema` when they are
 * read and written, and the column's type is inferred from it.
 *
 * @param name - The physical column name, quoted exactly as given.
 * @example
 * ```ts
 * const events = snowflakeTable('EVENTS', {
 *   payload: variant('PAYLOAD', z.object({ kind: z.string(), count: z.number() })),
 * });
 * ```
 */
export function variant<T>(
  name: string,
  schema: z.ZodType<T>,
): Column<T, false, string, 'none', 'variant'>;
export function variant(
  name: string,
  schema: z.ZodType<unknown> = z.unknown(),
): Column<unknown, false, string, 'none', 'variant'> {
  return column(name, 'variant', json(schema), schema, false);
}
/**
 * Declares a semi-structured ARRAY column that decodes as `unknown[]`.
 *
 * @param name - The physical column name, quoted exactly as given.
 */
export function array(name: string): Column<unknown[], false, string, 'none', 'array'>;
/**
 * Declares a semi-structured ARRAY column whose elements are validated with `element`.
 *
 * @param name - The physical column name, quoted exactly as given.
 */
export function array<T>(
  name: string,
  element: z.ZodType<T>,
): Column<T[], false, string, 'none', 'array'>;
export function array(
  name: string,
  element: z.ZodType<unknown> = z.unknown(),
): Column<unknown[], false, string, 'none', 'array'> {
  const schema = z.array(element);
  return column(name, 'array', json(schema), schema, false);
}
/**
 * Declares a semi-structured OBJECT column that decodes as `Record<string, unknown>`.
 *
 * @param name - The physical column name, quoted exactly as given.
 */
export function object(
  name: string,
): Column<Record<string, unknown>, false, string, 'none', 'object'>;
/**
 * Declares a semi-structured OBJECT column validated with `schema`.
 *
 * @param name - The physical column name, quoted exactly as given.
 */
export function object<T extends Record<string, unknown>>(
  name: string,
  schema: z.ZodType<T>,
): Column<T, false, string, 'none', 'object'>;
export function object(
  name: string,
  schema: z.ZodType<Record<string, unknown>> = z.record(z.string(), z.unknown()),
): Column<Record<string, unknown>, false, string, 'none', 'object'> {
  return column(name, 'object', json(schema), schema, false);
}
/**
 * Declares a BINARY column that decodes as `Uint8Array`.
 *
 * @param name - The physical column name, quoted exactly as given.
 * @param options - `length` declares BINARY(length) in bytes; longer values are rejected.
 */
export function binary(
  name: string,
  options: { readonly length?: number } = {},
): Column<Uint8Array, false, string, 'none', 'binary'> {
  const schema = z.instanceof(Uint8Array);
  const length =
    options.length === undefined ? undefined : bounded('Length', options.length, 1, 67108864);
  return column(
    name,
    'binary',
    schema,
    schema,
    false,
    length === undefined
      ? undefined
      : {
          constraints: { length },
          type: `BINARY(${length})`,
          check: (value) => value.length <= length,
        },
  );
}

/**
 * Declares a GEOGRAPHY column whose values are GeoJSON geometry objects.
 *
 * GEOGRAPHY values cannot be compared, ordered, or grouped.
 *
 * @param name - The physical column name, quoted exactly as given.
 */
export function geography(
  name: string,
): Column<GeoJsonGeometry, false, string, 'none', 'geography'> {
  const schema = geoJson(4);
  return column(name, 'geography', json(schema), schema, false, undefined, (value) =>
    call('TO_GEOGRAPHY', value === null ? null : JSON.stringify(value)),
  );
}
/**
 * Declares a GEOMETRY column whose values are GeoJSON geometry objects.
 *
 * @param name - The physical column name, quoted exactly as given.
 * @param options - `srid` is the spatial reference ID every value must carry, 0 by default.
 */
export function geometry(
  name: string,
  options: { readonly srid?: number } = {},
): Column<GeoJsonGeometry, false, string, 'none', 'geometry'> {
  const srid = bounded('SRID', options.srid ?? 0, 0, 2147483647);
  const schema = geoJson(3);
  const read = z
    .instanceof(Uint8Array)
    .transform((bytes, context) => {
      try {
        return decodeEwkb(bytes);
      } catch (error) {
        context.addIssue({ code: 'custom', message: (error as Error).message });
        return z.NEVER;
      }
    })
    .refine((value) => value.srid === srid, `Value does not fit GEOMETRY with SRID ${srid}.`)
    .transform((value) => value.geometry)
    .pipe(schema);
  return column(
    name,
    'geometry',
    read,
    schema,
    false,
    { constraints: { srid }, type: `GEOMETRY with SRID ${srid}` },
    (value) => call('TO_GEOMETRY', value === null ? null : JSON.stringify(value), srid),
  );
}
/**
 * Declares a VECTOR column of a fixed dimension that decodes as `number[]`.
 *
 * FLOAT elements are stored as FLOAT32, so results return the nearest FLOAT32 value.
 *
 * @param name - The physical column name, quoted exactly as given.
 * @param element - `'int'` for INT32 elements or `'float'` for FLOAT32 elements.
 * @param dimension - The number of elements, from 1 to 4096. Writes must match it.
 */
export function vector(
  name: string,
  element: 'int' | 'float',
  dimension: number,
): Column<number[], false, string, 'none', 'vector'> {
  if (element !== 'int' && element !== 'float')
    throw new TypeError("VECTOR elements must be 'int' or 'float'.");
  bounded('Dimension', dimension, 1, 4096);
  const type = `VECTOR(${element === 'int' ? 'INT' : 'FLOAT'}, ${dimension})` as const;
  const schema = z.array(
    element === 'int'
      ? z.number().int().min(-2147483648).max(2147483647)
      : z.number().refine((value) => Number.isFinite(Math.fround(value)), 'FLOAT32 overflow.'),
  );
  return column(
    name,
    'vector',
    json(schema, element === 'float' ? Math.fround : undefined),
    schema,
    false,
    { constraints: { dimension, element }, type, check: (value) => value.length === dimension },
    (value) => Object.freeze({ kind: 'cast', value: parseJson('vector', value), target: type }),
  );
}
function call(name: string, ...args: (string | number | null)[]): ExpressionNode {
  return Object.freeze({ kind: 'function', name, args: Object.freeze(args.map(scalarParameter)) });
}

/**
 * A table source: a declared table, an alias, a derived query, a CTE, or a Snowflake table
 * function.
 *
 * Select from it with {@link select}, and reference its columns through `columns`.
 */
export interface Table<C extends ColumnMap = ColumnMap, Name extends string = string> {
  /** The table's name. */
  readonly node: IdentifierNode;
  /** The table's columns, bound to its source name. */
  readonly columns: C;
  /** The FROM item the table compiles to. */
  readonly source: RelationNode;
  /** Identifies this source within a query. */
  readonly ref: SourceReference;
  /** @internal */
  readonly scopeType?: Name;
  /** The sources a lateral table function reads, which must precede it in a query. */
  readonly dependencies: readonly SourceReference[];
}
/** Qualifies a declared table name. */
export interface TableOptions {
  /** The schema that contains the table. */
  readonly schema?: string;
  /** The database that contains the schema. Requires `schema`. */
  readonly database?: string;
}

export function bindColumn<
  T,
  R extends boolean,
  N extends string,
  S extends ServerValueKind,
  D extends DataType,
>(value: Column<T, R, string, S, D>, ref: SourceReference): Column<T, R, N, S, D> {
  return Object.freeze({
    ...value,
    phase: 'scalar',
    expression: Object.freeze({ kind: 'reference', source: ref, column: value.node }),
    refs: Object.freeze([ref]),
    nullRefs: Object.freeze([ref]),
    notNull: () => bindColumn(value.notNull(), ref),
    serverDefault: (expression?: string) => bindColumn(value.serverDefault(expression), ref),
    identity: (options?: IdentityOptions) => bindColumn(value.identity(options), ref),
    virtual: (expression?: string) => bindColumn(value.virtual(expression), ref),
  }) as Column<T, R, N, S, D>;
}
export function bindTable<C extends ColumnMap, N extends string>(
  node: IdentifierNode,
  columns: C,
  source: RelationNode,
  name: N,
  dependencies: readonly SourceReference[] = [],
): Table<BoundColumns<C, N>, N> {
  const ref = Object.freeze({ id: Symbol(name), name, qualifier: identifier(name) });
  const bound = Object.fromEntries(
    Object.entries(columns).map(([key, value]) => [key, bindColumn(value, ref)]),
  ) as BoundColumns<C, N>;
  return Object.freeze({
    node,
    columns: Object.freeze(bound),
    source,
    ref,
    dependencies: Object.freeze([...dependencies]),
  });
}
/**
 * Declares a Snowflake table, the source of truth for query result types and runtime validation.
 *
 * @param name - The physical table name, quoted exactly as given.
 * @param columns - The table's columns, keyed by the names used in TypeScript.
 * @param options - Qualifies the table with a `database` and `schema`.
 * @throws `TypeError` when the table has no columns, repeats a physical column name, or names a
 * database without a schema.
 * @example
 * ```ts
 * const customers = snowflakeTable(
 *   'CUSTOMERS',
 *   {
 *     id: integer('ID').notNull(),
 *     name: text('NAME').notNull(),
 *     email: text('EMAIL'),
 *   },
 *   { database: 'APP_DB', schema: 'PUBLIC' },
 * );
 * ```
 */
export function snowflakeTable<const C extends ColumnMap, const N extends string>(
  name: N,
  columns: C,
  options: TableOptions = {},
): Table<BoundColumns<C, N>, N> {
  if (options.database && !options.schema)
    throw new TypeError('A database-qualified table also requires a schema.');
  if (!Object.keys(columns).length) throw new TypeError('A table needs at least one column.');
  const names = Object.values(columns).map((entry) => entry.node.parts[0]);
  if (new Set(names).size !== names.length) throw new TypeError('Duplicate physical column names.');
  const parts: [string, ...string[]] = options.database
    ? [options.database, options.schema as string, name]
    : options.schema === undefined
      ? [name]
      : [options.schema, name];
  const node = identifier(...parts);
  return bindTable(node, columns, Object.freeze({ kind: 'table', name: node }), name);
}
/**
 * Gives a base table another name, so it can appear more than once in a query.
 *
 * @throws `TypeError` when `table` is a derived query; use `.as()` for those.
 * @example
 * ```ts
 * const manager = alias(employees, 'MANAGER');
 * select(employees)
 *   .leftJoin(manager, eq(employees.columns.managerId, manager.columns.id))
 *   .select({ name: employees.columns.name, manager: manager.columns.name });
 * ```
 */
export function alias<C extends ColumnMap, const N extends string>(
  table: Table<C>,
  name: N,
): Table<BoundColumns<C, N>, N> {
  if (table.source.kind !== 'table')
    throw new TypeError('Alias a base table; use .as() for derived queries.');
  const source = Object.freeze({ ...table.source, alias: identifier(name) });
  return bindTable(table.node, table.columns, source, name, table.dependencies);
}
/**
 * Reads a base table at a point in time with Snowflake time travel: `AT` (the default) or `BEFORE`
 * a timestamp, an `offset` in seconds (zero or negative), or a `statement` query ID.
 *
 * Timestamps are cast to TIMESTAMP_TZ, so a timestamp without an offset is read in the session time
 * zone.
 *
 * @throws `TypeError` when `table` is not a base table or the selector is invalid.
 * @example
 * ```ts
 * select(timeTravel(customers, { offset: -3600 }));
 * ```
 */
export function timeTravel<C extends ColumnMap, N extends string>(
  table: Table<C, N>,
  selector:
    | { readonly timestamp: string }
    | { readonly offset: number }
    | { readonly statement: string },
  mode: 'AT' | 'BEFORE' = 'AT',
): Table<BoundColumns<C, N>, N> {
  if (table.source.kind !== 'table') throw new TypeError('Time travel requires a base table.');
  const keys = Object.keys(selector);
  if (keys.length !== 1) throw new TypeError('Choose exactly one time-travel selector.');
  const key = keys[0];
  if (
    key === 'offset' &&
    (!Number.isSafeInteger((selector as { offset: number }).offset) ||
      (selector as { offset: number }).offset > 0)
  )
    throw new TypeError('Time-travel offset must be a nonpositive safe integer.');
  if (key !== 'timestamp' && key !== 'offset' && key !== 'statement')
    throw new TypeError('Unknown time-travel selector.');
  const value = Object.values(selector)[0] as string | number;
  if (typeof value === 'string' && !value)
    throw new TypeError('Time-travel selector cannot be empty.');
  const source = Object.freeze({
    ...table.source,
    temporal: Object.freeze({
      mode,
      selector: key.toUpperCase() as 'TIMESTAMP' | 'OFFSET' | 'STATEMENT',
      value,
    }),
  });
  return bindTable(table.node, table.columns, source, table.ref.name as N);
}
export function isLeaf(value: AnyExpression | Projection): value is AnyExpression {
  return typeof value.dataType === 'string' && 'expression' in value;
}
/** Leaves in projection order, depth first, with their paths. */
export function projectionLeaves(
  projection: Projection,
  path: readonly string[] = [],
): [path: readonly string[], value: AnyExpression][] {
  return Object.entries(projection).flatMap(([key, value]) =>
    isLeaf(value) ? [[[...path, key], value]] : projectionLeaves(value, [...path, key]),
  );
}
/** Rebuilds the projection's shape from a row of leaf values in projection order. */
export function projectionRow(projection: Projection): (values: readonly unknown[]) => unknown {
  let index = 0;
  const shape = (value: Projection): (readonly [string, number | object])[] =>
    Object.entries(value).map(([key, item]) => [key, isLeaf(item) ? index++ : shape(item)]);
  const tree = shape(projection);
  // Runs once per result row, so it assigns in a loop instead of allocating entry pairs.
  // Projections reject the reserved __proto__ alias, so plain assignment is safe.
  const build = (nodes: typeof tree, values: readonly unknown[]): Record<string, unknown> => {
    const row: Record<string, unknown> = {};
    for (const [key, node] of nodes)
      row[key] = typeof node === 'number' ? values[node] : build(node as typeof tree, values);
    return row;
  };
  return (values) => build(tree, values);
}
/**
 * A nested object is NULL when every NOT NULL entry it holds directly reads NULL, and each of
 * those keys can only be NULL through an outer join. A present object proves the sources proven
 * by every key, and only a column key proves its source.
 */
function presence(projection: Projection, nullable: ReadonlySet<symbol>) {
  const keys = Object.entries(projection).filter(
    (entry): entry is [string, AnyExpression] =>
      isLeaf(entry[1]) && !entry[1].valueSchema.safeParse(null).success,
  );
  const scopes = keys.map(([, value]) =>
    value.nullRefs.map((ref) => ref.id).filter((id) => nullable.has(id)),
  );
  if (!keys.length || scopes.some((scope) => !scope.length)) return undefined;
  const proofs = keys.map(([, value], index) =>
    'required' in value ? (scopes[index] as symbol[]) : [],
  );
  const proven = new Set(proofs.reduce((all, scope) => all.filter((id) => scope.includes(id))));
  return {
    keys: keys.map(([key]) => key),
    nullable: new Set([...nullable].filter((id) => !proven.has(id))),
  };
}
function projectionSchema(projection: Projection, nullable: ReadonlySet<symbol>): z.ZodType {
  return z.strictObject(
    Object.fromEntries(
      Object.entries(projection).map(([key, value]) => {
        if (isLeaf(value))
          return [
            key,
            value.nullRefs.some((ref) => nullable.has(ref.id))
              ? value.readSchema.nullable()
              : value.readSchema,
          ];
        const object = presence(value, nullable);
        if (!object) return [key, projectionSchema(value, nullable)];
        return [
          key,
          z.preprocess(
            (raw) =>
              object.keys.every((name) => (raw as Record<string, unknown>)[name] === null)
                ? null
                : raw,
            projectionSchema(value, object.nullable).nullable(),
          ),
        ];
      }),
    ),
  );
}
/** Derives a compiled parser from the projection, including nullable join sources. */
export function resultSchema<S extends Projection>(
  selection: S,
  nullable: ReadonlySet<symbol> = new Set(),
): z.ZodType<InferSelection<S>> {
  return z.compile(projectionSchema(selection, nullable)) as z.ZodType<InferSelection<S>>;
}
