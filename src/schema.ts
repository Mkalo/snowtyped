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
  jsonParameter,
  scalarParameter,
} from './expressions.js';

export type ColumnValue<T, Required extends boolean> = Required extends true ? T : T | null;
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
  | 'binary';
export interface ColumnConstraints {
  readonly precision?: number;
  readonly scale?: number;
  readonly length?: number;
}
export interface Column<
  T,
  Required extends boolean = false,
  Scope extends string = string,
  D extends DataType = DataType,
> extends Expression<ColumnValue<T, Required>, Scope, Scope, D> {
  readonly node: IdentifierNode;
  readonly required: Required;
  readonly constraints: ColumnConstraints;
  encodeWrite(value: ColumnValue<T, Required>): ExpressionNode;
  notNull(): Column<T, true, Scope, D>;
}
export type AnyColumn = Column<unknown, boolean, string>;
export type InferColumn<C> = C extends Column<infer T, infer R, string> ? ColumnValue<T, R> : never;
export type ColumnMap = Readonly<Record<string, AnyColumn>>;
export type Selection = Readonly<Record<string, AnyExpression>>;
export type InferSelection<S extends Selection, Nullable extends string = never> = {
  [K in keyof S]:
    | InferExpression<S[K]>
    | (Extract<ExpressionNullScope<S[K]>, Nullable> extends never ? never : null);
};
export type BoundColumns<C extends ColumnMap, Name extends string> = {
  [K in keyof C]: C[K] extends Column<infer T, infer R, string, infer D>
    ? Column<T, R, Name, D>
    : never;
};
interface Constraint<T> {
  readonly constraints: ColumnConstraints;
  readonly type: string;
  check(value: T): boolean;
}

function column<T, R extends boolean, D extends DataType>(
  name: string,
  dataType: D,
  read: z.ZodType<T>,
  value: z.ZodType<T>,
  required: R,
  constraint?: Constraint<T>,
): Column<T, R, string, D> {
  const constrained = (schema: z.ZodType<T>) =>
    constraint ? schema.refine(constraint.check, `Value does not fit ${constraint.type}.`) : schema;
  const nullable = (schema: z.ZodType<T>) =>
    (required ? schema : schema.nullable()) as z.ZodType<ColumnValue<T, R>>;
  const readSchema = nullable(constrained(read));
  const valueSchema = nullable(value);
  const writeSchema = nullable(constrained(value));
  const node = identifier(name);
  function encode(parsed: ColumnValue<T, R>): ExpressionNode {
    // NULL goes through the same wrapper so it carries the column type; a bare NULL
    // bind is VARCHAR, which Snowflake rejects for VARIANT and BINARY in INSERT ... SELECT.
    if (dataType === 'variant') return jsonParameter(parsed);
    if (dataType === 'binary') {
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
    }
    return scalarParameter(parsed);
  }
  return Object.freeze({
    ...expression(node, readSchema, {
      dataType,
      valueSchema,
      ...(!['text', 'boolean', 'binary'].includes(dataType)
        ? { wireType: dataType as WireType }
        : {}),
      encode,
    }),
    node,
    required,
    constraints: Object.freeze({ ...constraint?.constraints }),
    encodeWrite: (input: ColumnValue<T, R>) => encode(writeSchema.parse(input)),
    notNull: () => column(name, dataType, read, value, true, constraint),
  });
}
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
export function text(
  name: string,
  options: { readonly length?: number } = {},
): Column<string, false, string, 'text'> {
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
export function integer(
  name: string,
  options: { readonly precision?: number } = {},
): Column<bigint, false, string, 'integer'> {
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
export function decimal(
  name: string,
  options: { readonly precision?: number; readonly scale?: number } = {},
): Column<string, false, string, 'decimal'> {
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
export function boolean(name: string): Column<boolean, false, string, 'boolean'> {
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
export function float(name: string): Column<number, false, string, 'float'> {
  return column(
    name,
    'float',
    z.string().transform(decodeFloat).pipe(z.number().finite()),
    z.number().finite(),
    false,
  );
}
export function date(name: string): Column<string, false, string, 'date'> {
  return column(name, 'date', z.string(), z.iso.date(), false);
}
export function time(
  name: string,
  options: { readonly precision?: number } = {},
): Column<string, false, string, 'time'> {
  return column(
    name,
    'time',
    z.string(),
    z.string().regex(/^\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?$/),
    false,
    fractional('TIME', options),
  );
}
export function timestamp(name: string): Column<string, false, string, 'timestamp_ntz'>;
export function timestamp<M extends 'ntz' | 'ltz' | 'tz'>(
  name: string,
  mode: M,
  options?: { readonly precision?: number },
): Column<string, false, string, `timestamp_${M}`>;
export function timestamp(
  name: string,
  mode: 'ntz' | 'ltz' | 'tz' = 'ntz',
  options: { readonly precision?: number } = {},
): Column<string, false, string, `timestamp_${typeof mode}`> {
  return column(
    name,
    `timestamp_${mode}`,
    z.string(),
    z.string().min(1),
    false,
    fractional(`TIMESTAMP_${mode.toUpperCase()}`, options),
  );
}
export function variant(name: string): Column<unknown, false, string, 'variant'>;
export function variant<T>(name: string, schema: z.ZodType<T>): Column<T, false, string, 'variant'>;
export function variant(
  name: string,
  schema: z.ZodType<unknown> = z.unknown(),
): Column<unknown, false, string, 'variant'> {
  return column(
    name,
    'variant',
    z
      .string()
      .transform((value) => JSON.parse(value) as unknown)
      .pipe(schema),
    schema,
    false,
  );
}
export function binary(
  name: string,
  options: { readonly length?: number } = {},
): Column<Uint8Array, false, string, 'binary'> {
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

export interface Table<C extends ColumnMap = ColumnMap, Name extends string = string> {
  readonly node: IdentifierNode;
  readonly columns: C;
  readonly source: RelationNode;
  readonly ref: SourceReference;
  readonly scopeType?: Name;
  readonly dependencies: readonly SourceReference[];
}
export interface TableOptions {
  readonly schema?: string;
  readonly database?: string;
}

export function bindColumn<T, R extends boolean, N extends string, D extends DataType>(
  value: Column<T, R, string, D>,
  ref: SourceReference,
): Column<T, R, N, D> {
  return Object.freeze({
    ...value,
    phase: 'scalar',
    expression: Object.freeze({ kind: 'reference', source: ref, column: value.node }),
    refs: Object.freeze([ref]),
    nullRefs: Object.freeze([ref]),
    notNull: () => bindColumn<T, true, N, D>(value.notNull(), ref),
  }) as Column<T, R, N, D>;
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
export function alias<C extends ColumnMap, const N extends string>(
  table: Table<C>,
  name: N,
): Table<BoundColumns<C, N>, N> {
  if (table.source.kind !== 'table')
    throw new TypeError('Alias a base table; use .as() for derived queries.');
  const source = Object.freeze({ ...table.source, alias: identifier(name) });
  return bindTable(table.node, table.columns, source, name, table.dependencies);
}
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
/** Derives a compiled parser from the projection, including nullable join sources. */
export function resultSchema<S extends Selection>(
  selection: S,
  nullable: ReadonlySet<symbol> = new Set(),
): z.ZodType<InferSelection<S>> {
  const shape = Object.fromEntries(
    Object.entries(selection).map(([key, value]) => [
      key,
      value.nullRefs.some((ref) => nullable.has(ref.id))
        ? value.readSchema.nullable()
        : value.readSchema,
    ]),
  );
  return z.compile(z.strictObject(shape)) as z.ZodType<InferSelection<S>>;
}
