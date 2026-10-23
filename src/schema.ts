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
export interface ServerValues {
  readonly none: null;
  readonly default: { readonly kind: 'default'; readonly expression?: string };
  readonly identity: {
    readonly kind: 'identity';
    readonly start?: number;
    readonly increment?: number;
    readonly order?: boolean;
  };
  readonly virtual: { readonly kind: 'virtual'; readonly expression?: string };
}
export type ServerValueKind = keyof ServerValues;
export type ServerValue = NonNullable<ServerValues[ServerValueKind]>;
export type IdentityOptions = Omit<ServerValues['identity'], 'kind'>;
export interface Column<
  T,
  Required extends boolean = false,
  Scope extends string = string,
  Server extends ServerValueKind = 'none',
> extends Expression<ColumnValue<T, Required>, Scope> {
  readonly node: IdentifierNode;
  readonly dataType: DataType;
  readonly required: Required;
  readonly serverValue: ServerValues[Server];
  notNull(): Column<T, true, Scope, Server>;
  serverDefault(expression?: string): Column<T, Required, Scope, 'default'>;
  identity(options?: IdentityOptions): Column<T, Required, Scope, 'identity'>;
  virtual(expression?: string): Column<T, Required, Scope, 'virtual'>;
}
export type AnyColumn = Column<unknown, boolean, string, ServerValueKind>;
export type InferColumn<C> =
  C extends Column<infer T, infer R, string, ServerValueKind> ? ColumnValue<T, R> : never;
export type ColumnMap = Readonly<Record<string, AnyColumn>>;
export type Selection = Readonly<Record<string, AnyExpression>>;
export type InferSelection<S extends Selection, Nullable extends string = never> = {
  [K in keyof S]:
    | InferExpression<S[K]>
    | (Extract<ExpressionNullScope<S[K]>, Nullable> extends never ? never : null);
};
export type BoundColumns<C extends ColumnMap, Name extends string> = {
  [K in keyof C]: C[K] extends Column<infer T, infer R, string, infer S>
    ? Column<T, R, Name, S>
    : never;
};

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
function column<T, R extends boolean, S extends ServerValueKind = 'none'>(
  name: string,
  dataType: DataType,
  read: z.ZodType<T>,
  value: z.ZodType<T>,
  required: R,
  serverValue: ServerValue | null = null,
): Column<T, R, string, S> {
  const readSchema = (required ? read : read.nullable()) as z.ZodType<ColumnValue<T, R>>;
  const valueSchema = (required ? value : value.nullable()) as z.ZodType<ColumnValue<T, R>>;
  const node = identifier(name);
  return Object.freeze({
    ...expression(node, readSchema, {
      valueSchema,
      ...(!['text', 'boolean', 'binary'].includes(dataType)
        ? { wireType: dataType as WireType }
        : {}),
      encode(parsed) {
        if (dataType === 'variant' && parsed !== null) {
          const encoded = JSON.stringify(parsed);
          if (encoded === undefined)
            throw new TypeError('VARIANT values must be JSON serializable.');
          return Object.freeze({
            kind: 'function',
            name: 'PARSE_JSON',
            args: Object.freeze([scalarParameter(encoded)]),
          });
        }
        if (dataType === 'binary' && parsed !== null) {
          const bytes = parsed as Uint8Array;
          return Object.freeze({
            kind: 'function',
            name: 'TO_BINARY',
            args: Object.freeze([
              scalarParameter(Buffer.from(bytes).toString('hex')),
              scalarParameter('HEX'),
            ]),
          });
        }
        return scalarParameter(parsed);
      },
    }),
    node,
    dataType,
    required,
    serverValue: serverValue as ServerValues[S],
    notNull: () => column<T, true, S>(name, dataType, read, value, true, serverValue),
    serverDefault: (expression?: string) =>
      column<T, R, 'default'>(
        name,
        dataType,
        read,
        value,
        required,
        serverExpression('default', expression),
      ),
    identity: (options: IdentityOptions = {}) =>
      column<T, R, 'identity'>(name, dataType, read, value, required, identityValue(options)),
    virtual: (expression?: string) =>
      column<T, R, 'virtual'>(
        name,
        dataType,
        read,
        value,
        required,
        serverExpression('virtual', expression),
      ),
  }) as Column<T, R, string, S>;
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
export function float(name: string): Column<number> {
  return column(
    name,
    'float',
    z.string().transform(Number).pipe(z.number().finite()),
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

export function bindColumn<T, R extends boolean, N extends string, S extends ServerValueKind>(
  value: Column<T, R, string, S>,
  ref: SourceReference,
): Column<T, R, N, S> {
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
  }) as Column<T, R, N, S>;
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
