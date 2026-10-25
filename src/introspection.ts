import * as z from 'zod';
import type { ServerValue } from './schema.js';
import type { SnowflakeClient } from './snowflake/client.js';
import { sql } from './sql.js';

/** A column read by {@link introspect}. */
export interface IntrospectedColumn {
  /** The physical column name. */
  readonly name: string;
  /** The `INFORMATION_SCHEMA` data type, such as `NUMBER` or `TEXT`. */
  readonly dataType: string;
  /** Whether the column accepts NULL. */
  readonly nullable: boolean;
  /** NUMBER precision, or TIME and TIMESTAMP fractional seconds precision. */
  readonly precision: number | null;
  /** NUMBER scale. */
  readonly scale: number | null;
  /** VARCHAR length. */
  readonly length: number | null;
  /** The column's default, identity, or virtual expression. */
  readonly serverValue?: ServerValue | null;
  /** The `SHOW COLUMNS` type of a structured ARRAY, OBJECT, or MAP column. */
  readonly structure?: StructureMetadata;
}
export interface StructureMetadata {
  readonly type: string;
  readonly nullable: boolean;
  readonly [property: string]: unknown;
}
/** A table read by {@link introspect}. */
export interface IntrospectedTable {
  /** The table's database. */
  readonly database: string;
  /** The table's schema. */
  readonly schema: string;
  /** The physical table name. */
  readonly name: string;
  /** The table's columns, in ordinal order. */
  readonly columns: readonly IntrospectedColumn[];
}
const metadata = () =>
  z.compile(
    z.array(
      z.object({
        TABLE_SCHEMA: z.string(),
        TABLE_NAME: z.string(),
        COLUMN_NAME: z.string(),
        DATA_TYPE: z.string(),
        DATA_TYPE_ALIAS: z.string().nullable(),
        IS_NULLABLE: z.enum(['YES', 'NO']),
        NUMERIC_PRECISION: z.string().nullable(),
        NUMERIC_SCALE: z.string().nullable(),
        CHARACTER_MAXIMUM_LENGTH: z.string().nullable(),
        DATETIME_PRECISION: z.string().nullable(),
        COLUMN_DEFAULT: z.string().nullable(),
        IS_IDENTITY: z.enum(['YES', 'NO']),
        IDENTITY_START: z.string().nullable(),
        IDENTITY_INCREMENT: z.string().nullable(),
        IDENTITY_ORDERED: z.enum(['YES', 'NO']).nullable(),
        KIND: z.string(),
        EXPRESSION: z.string().nullable(),
      }),
    ),
  );
const numeric = (value: string | null) => (value === null ? null : Number(value));
const shownColumns = () =>
  z.compile(z.array(z.object({ column_name: z.string(), data_type: z.string() })));
const structureMetadata = () =>
  z.compile(z.looseObject({ type: z.string(), nullable: z.boolean() }));
const containerType = /^(?:ARRAY|OBJECT|MAP)\b/i;

function serverValue(row: z.infer<ReturnType<typeof metadata>>[number]): ServerValue | null {
  if (row.KIND !== 'COLUMN')
    return Object.freeze({
      kind: 'virtual',
      ...(row.EXPRESSION === null ? {} : { expression: row.EXPRESSION }),
    });
  if (row.IS_IDENTITY === 'YES')
    return Object.freeze({
      kind: 'identity',
      ...(row.IDENTITY_START === null ? {} : { start: Number(row.IDENTITY_START) }),
      ...(row.IDENTITY_INCREMENT === null ? {} : { increment: Number(row.IDENTITY_INCREMENT) }),
      ...(row.IDENTITY_ORDERED === null ? {} : { order: row.IDENTITY_ORDERED === 'YES' }),
    });
  return row.COLUMN_DEFAULT === null
    ? null
    : Object.freeze({ kind: 'default', expression: row.COLUMN_DEFAULT });
}

/**
 * Reads the tables and columns of a database, or one of its schemas, through `INFORMATION_SCHEMA`.
 *
 * Results are limited to what the connection's role can access. Structured types are read with
 * `SHOW COLUMNS`, which keeps their exact field names.
 *
 * @param client - A client from `snowtyped/snowflake`.
 * @example
 * ```ts
 * const tables = await introspect(db, { database: 'APP_DB', schema: 'PUBLIC' });
 * ```
 */
export async function introspect(
  client: Pick<SnowflakeClient, 'queryRaw'>,
  options: { readonly database: string; readonly schema?: string },
): Promise<readonly IntrospectedTable[]> {
  const rows = metadata().parse(
    await client.queryRaw(sql`SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, DATA_TYPE, DATA_TYPE_ALIAS, IS_NULLABLE, NUMERIC_PRECISION, NUMERIC_SCALE, CHARACTER_MAXIMUM_LENGTH, DATETIME_PRECISION,
      COLUMN_DEFAULT, IS_IDENTITY, IDENTITY_START, IDENTITY_INCREMENT, IDENTITY_ORDERED, KIND, EXPRESSION
    FROM ${sql.identifier(options.database, 'INFORMATION_SCHEMA', 'COLUMNS')}
    WHERE TABLE_SCHEMA <> ${'INFORMATION_SCHEMA'} ${options.schema === undefined ? sql.unsafe('') : sql`AND TABLE_SCHEMA = ${options.schema}`}
    ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION`),
  );
  const tables = new Map<
    string,
    { database: string; schema: string; name: string; columns: IntrospectedColumn[] }
  >();
  for (const row of rows) {
    const key = JSON.stringify([row.TABLE_SCHEMA, row.TABLE_NAME]);
    let table = tables.get(key);
    if (!table) {
      table = {
        database: options.database,
        schema: row.TABLE_SCHEMA,
        name: row.TABLE_NAME,
        columns: [],
      };
      tables.set(key, table);
    }
    table.columns.push(
      Object.freeze({
        name: row.COLUMN_NAME,
        dataType: /^(?:ARRAY|OBJECT|MAP|VECTOR)\(/i.test(row.DATA_TYPE_ALIAS ?? '')
          ? (row.DATA_TYPE_ALIAS as string)
          : row.DATA_TYPE,
        nullable: row.IS_NULLABLE === 'YES',
        precision: numeric(row.NUMERIC_PRECISION ?? row.DATETIME_PRECISION),
        scale: numeric(row.NUMERIC_SCALE),
        length: numeric(row.CHARACTER_MAXIMUM_LENGTH),
        serverValue: serverValue(row),
      }),
    );
  }
  for (const table of tables.values()) {
    // Views report no DATA_TYPE_ALIAS, so structured-ness comes from the SHOW COLUMNS type.
    if (!table.columns.some((column) => containerType.test(column.dataType))) continue;
    const shown = shownColumns().parse(
      await client.queryRaw(
        sql`SHOW COLUMNS IN TABLE ${sql.identifier(table.database, table.schema, table.name)}`,
      ),
    );
    table.columns = table.columns.map((column) => {
      const match = shown.find((entry) => entry.column_name === column.name);
      if (!containerType.test(column.dataType) || !match) return column;
      const structure = structureMetadata().parse(JSON.parse(match.data_type)) as StructureMetadata;
      return 'elementType' in structure || 'fields' in structure || 'keyType' in structure
        ? Object.freeze({ ...column, structure })
        : column;
    });
  }
  return Object.freeze(
    [...tables.values()].map((table) =>
      Object.freeze({ ...table, columns: Object.freeze(table.columns) }),
    ),
  );
}

function structureDeclaration(type: StructureMetadata, key = false): string {
  const nested = (value: unknown) => structureDeclaration(structureMetadata().parse(value));
  const number = (value: unknown) => z.number().parse(value);
  let declaration: string;
  switch (type.type) {
    case 'FIXED': {
      const precision = number(type.precision);
      const scale = number(type.scale);
      declaration =
        scale !== 0
          ? `structuredType.decimal({ precision: ${precision}, scale: ${scale} })`
          : `structuredType.integer(${precision === 38 ? '' : `{ precision: ${precision} }`})`;
      break;
    }
    case 'TEXT': {
      const length = number(type.length);
      declaration = `structuredType.text(${length === 16777216 ? '' : `{ length: ${length} }`})`;
      break;
    }
    case 'BOOLEAN':
      declaration = 'structuredType.boolean()';
      break;
    case 'ARRAY':
      declaration = `structuredType.array(${nested(type.elementType)})`;
      break;
    case 'OBJECT': {
      const fields = z
        .array(z.object({ fieldName: z.string(), fieldType: z.unknown() }))
        .parse(type.fields);
      const entries = fields.map(
        (field) => `${JSON.stringify(field.fieldName)}: ${nested(field.fieldType)}`,
      );
      declaration = `structuredType.object(${entries.length ? `{ ${entries.join(', ')} }` : '{}'})`;
      break;
    }
    case 'MAP':
      declaration = `structuredType.map(${structureDeclaration(structureMetadata().parse(type.keyType), true)}, ${nested(type.valueType)})`;
      break;
    default:
      throw new TypeError(`Unsupported structured element type for code generation: ${type.type}`);
  }
  return type.nullable || key ? declaration : `${declaration}.notNull()`;
}

function serverModifier(value: ServerValue | null | undefined): string {
  if (!value) return '';
  if (value.kind === 'identity') {
    const { kind: _, ...options } = value;
    const entries = Object.entries(options).map(([key, option]) => `${key}: ${option}`);
    return `.identity(${entries.length ? `{ ${entries.join(', ')} }` : ''})`;
  }
  const method = value.kind === 'default' ? 'serverDefault' : 'virtual';
  return `.${method}(${value.expression === undefined ? '' : JSON.stringify(value.expression)})`;
}

/**
 * Generates TypeScript source declaring each introspected table with {@link snowflakeTable}.
 *
 * Tables are exported as `table0`, `table1`, and so on, in a stable order. Declarations carry the
 * exact physical names, NUMBER precision and scale, VARCHAR length, TIME and TIMESTAMP precision,
 * and server values. Review the output, rename the exports, and commit it.
 *
 * @throws `TypeError` for data types Snowtyped cannot declare.
 * @example
 * ```ts
 * const source = generateSchema(await introspect(db, { database: 'APP_DB', schema: 'PUBLIC' }));
 * ```
 */
export function generateSchema(tables: readonly IntrospectedTable[]): string {
  const imports = new Set(['snowflakeTable']);
  const declarations = tables.map((table, index) => {
    const columns = table.columns.map((column) => {
      let factoryName: string;
      const args = [JSON.stringify(column.name)];
      switch (column.structure ? 'STRUCTURED' : column.dataType.toUpperCase()) {
        case 'STRUCTURED':
          factoryName = 'structured';
          imports.add('structuredType');
          args.push(structureDeclaration(column.structure as StructureMetadata, true));
          break;
        case 'NUMBER':
        case 'FIXED':
        case 'DECIMAL':
          factoryName = column.scale === 0 ? 'integer' : 'decimal';
          if (column.scale === 0 && column.precision !== null && column.precision !== 38)
            args.push(`{ precision: ${column.precision} }`);
          if (column.scale !== 0 && column.precision !== null && column.scale !== null)
            args.push(`{ precision: ${column.precision}, scale: ${column.scale} }`);
          break;
        case 'TEXT':
        case 'VARCHAR':
        case 'CHAR':
          factoryName = 'text';
          if (column.length !== null && column.length !== 16777216)
            args.push(`{ length: ${column.length} }`);
          break;
        case 'BOOLEAN':
          factoryName = 'boolean';
          break;
        case 'FLOAT':
        case 'REAL':
        case 'DOUBLE':
          factoryName = 'float';
          break;
        case 'DATE':
          factoryName = 'date';
          break;
        case 'TIME':
          factoryName = 'time';
          if (column.precision !== null && column.precision !== 9)
            args.push(`{ precision: ${column.precision} }`);
          break;
        case 'TIMESTAMP_NTZ':
        case 'TIMESTAMP_LTZ':
        case 'TIMESTAMP_TZ':
          factoryName = 'timestamp';
          args.push(JSON.stringify(column.dataType.slice(10).toLowerCase()));
          if (column.precision !== null && column.precision !== 9)
            args.push(`{ precision: ${column.precision} }`);
          break;
        case 'VARIANT':
          factoryName = 'variant';
          break;
        case 'ARRAY':
          factoryName = 'array';
          break;
        case 'OBJECT':
          factoryName = 'object';
          break;
        case 'BINARY':
          factoryName = 'binary';
          if (column.length !== null && column.length !== 8388608)
            args.push(`{ length: ${column.length} }`);
          break;
        case 'GEOGRAPHY':
          factoryName = 'geography';
          break;
        case 'GEOMETRY':
          factoryName = 'geometry';
          break;
        default: {
          const vector = /^VECTOR\((INT|FLOAT), (\d+)\)$/i.exec(column.dataType);
          if (!vector)
            throw new TypeError(
              `Unsupported Snowflake type for code generation: ${column.dataType}`,
            );
          factoryName = 'vector';
          args.push(JSON.stringify(vector[1]?.toLowerCase()), vector[2] as string);
        }
      }
      imports.add(factoryName);
      return `  ${JSON.stringify(column.name)}: ${factoryName}(${args.join(', ')})${column.nullable ? '' : '.notNull()'}${serverModifier(column.serverValue)},`;
    });
    return `export const table${index} = snowflakeTable(${JSON.stringify(table.name)}, {\n${columns.join('\n')}\n}, { database: ${JSON.stringify(table.database)}, schema: ${JSON.stringify(table.schema)} });`;
  });
  return `import { ${[...imports].sort().join(', ')} } from 'snowtyped';\n\n${declarations.join('\n\n')}\n`;
}
