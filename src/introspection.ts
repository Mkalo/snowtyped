import * as z from 'zod';
import type { ServerValue } from './schema.js';
import type { SnowflakeClient } from './snowflake/client.js';
import { sql } from './sql.js';

export interface IntrospectedColumn {
  readonly name: string;
  readonly dataType: string;
  readonly nullable: boolean;
  readonly precision: number | null;
  readonly scale: number | null;
  readonly length: number | null;
  readonly serverValue?: ServerValue | null;
}
export interface IntrospectedTable {
  readonly database: string;
  readonly schema: string;
  readonly name: string;
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
        dataType: /^(?:ARRAY|OBJECT|VECTOR)\(/i.test(row.DATA_TYPE_ALIAS ?? '')
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
  return Object.freeze(
    [...tables.values()].map((table) =>
      Object.freeze({ ...table, columns: Object.freeze(table.columns) }),
    ),
  );
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

export function generateSchema(tables: readonly IntrospectedTable[]): string {
  const imports = new Set(['snowflakeTable']);
  const declarations = tables.map((table, index) => {
    const columns = table.columns.map((column) => {
      let factoryName: string;
      const args = [JSON.stringify(column.name)];
      switch (column.dataType.toUpperCase()) {
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
