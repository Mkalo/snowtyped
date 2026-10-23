import * as z from 'zod';
import {
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
export interface Column<T, Required extends boolean = false, Scope extends string = string>
  extends Expression<ColumnValue<T, Required>, Scope> {
  readonly node: IdentifierNode;
  readonly dataType: DataType;
  readonly required: Required;
  notNull(): Column<T, true, Scope>;
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
  [K in keyof C]: C[K] extends Column<infer T, infer R, string> ? Column<T, R, Name> : never;
};

function column<T, R extends boolean>(
  name: string,
  dataType: DataType,
  read: z.ZodType<T>,
  value: z.ZodType<T>,
  required: R,
): Column<T, R> {
  const readSchema = (required ? read : read.nullable()) as z.ZodType<ColumnValue<T, R>>;
  const valueSchema = (required ? value : value.nullable()) as z.ZodType<ColumnValue<T, R>>;
  const node = identifier(name);
  return Object.freeze({
    ...expression(node, readSchema, {
      valueSchema,
      ...(!['text', 'boolean', 'binary'].includes(dataType)
        ? { wireType: dataType as WireType }
        : {}),
      // NULL goes through the same wrapper so it carries the column type; a bare NULL
      // bind is VARCHAR, which Snowflake rejects for VARIANT and BINARY in INSERT ... SELECT.
      encode(parsed) {
        if (dataType === 'variant') {
          const encoded = parsed === null ? null : JSON.stringify(parsed);
          if (encoded === undefined)
            throw new TypeError('VARIANT values must be JSON serializable.');
          return Object.freeze({
            kind: 'function',
            name: 'PARSE_JSON',
            args: Object.freeze([scalarParameter(encoded)]),
          });
        }
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
      },
    }),
    node,
    dataType,
    required,
    notNull: () => column(name, dataType, read, value, true),
  });
}
export function text(name: string): Column<string> {
  return column(name, 'text', z.string(), z.string(), false);
}
export function integer(name: string): Column<bigint> {
  return column(
    name,
    'integer',
    z
      .string()
      .regex(/^-?\d+$/)
      .transform(BigInt),
    z.bigint(),
    false,
  );
}
export function decimal(name: string): Column<string> {
  const schema = z.string().regex(/^-?\d+(?:\.\d+)?$/);
  return column(name, 'decimal', schema, schema, false);
}
export function boolean(name: string): Column<boolean> {
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
export function float(name: string): Column<number> {
  return column(
    name,
    'float',
    z.string().transform(decodeFloat).pipe(z.number().finite()),
    z.number().finite(),
    false,
  );
}
export function date(name: string): Column<string> {
  return column(name, 'date', z.string(), z.iso.date(), false);
}
export function time(name: string): Column<string> {
  return column(
    name,
    'time',
    z.string(),
    z.string().regex(/^\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?$/),
    false,
  );
}
export function timestamp(name: string, mode: 'ntz' | 'ltz' | 'tz' = 'ntz'): Column<string> {
  return column(name, `timestamp_${mode}`, z.string(), z.string().min(1), false);
}
export function variant(name: string): Column<unknown>;
export function variant<T>(name: string, schema: z.ZodType<T>): Column<T>;
export function variant(name: string, schema: z.ZodType<unknown> = z.unknown()): Column<unknown> {
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
export function binary(name: string): Column<Uint8Array> {
  const schema = z.instanceof(Uint8Array);
  return column(name, 'binary', schema, schema, false);
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

export function bindColumn<T, R extends boolean, N extends string>(
  value: Column<T, R>,
  ref: SourceReference,
): Column<T, R, N> {
  return Object.freeze({
    ...value,
    phase: 'scalar',
    expression: Object.freeze({ kind: 'reference', source: ref, column: value.node }),
    refs: Object.freeze([ref]),
    nullRefs: Object.freeze([ref]),
    notNull: () => bindColumn<T, true, N>(value.notNull(), ref),
  }) as Column<T, R, N>;
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
