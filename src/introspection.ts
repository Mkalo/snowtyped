import * as z from 'zod';
import type { SnowflakeClient } from './snowflake/client.js';
import { sql } from './sql.js';

export interface IntrospectedColumn {
  readonly name: string;
  readonly dataType: string;
  readonly nullable: boolean;
  readonly precision: number | null;
  readonly scale: number | null;
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
        IS_NULLABLE: z.enum(['YES', 'NO']),
        NUMERIC_PRECISION: z.string().nullable(),
        NUMERIC_SCALE: z.string().nullable(),
      }),
    ),
  );

export async function introspect(
  client: Pick<SnowflakeClient, 'queryRaw'>,
  options: { readonly database: string; readonly schema?: string },
): Promise<readonly IntrospectedTable[]> {
  const rows = metadata().parse(
    await client.queryRaw(sql`SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, DATA_TYPE, IS_NULLABLE, NUMERIC_PRECISION, NUMERIC_SCALE
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
        dataType: row.DATA_TYPE,
        nullable: row.IS_NULLABLE === 'YES',
        precision: row.NUMERIC_PRECISION === null ? null : Number(row.NUMERIC_PRECISION),
        scale: row.NUMERIC_SCALE === null ? null : Number(row.NUMERIC_SCALE),
      }),
    );
  }
  return Object.freeze(
    [...tables.values()].map((table) =>
      Object.freeze({ ...table, columns: Object.freeze(table.columns) }),
    ),
  );
}

export function generateSchema(tables: readonly IntrospectedTable[]): string {
  const imports = new Set(['snowflakeTable']);
  const declarations = tables.map((table, index) => {
    const columns = table.columns.map((column) => {
      let factoryName: string;
      let mode = '';
      switch (column.dataType.toUpperCase()) {
        case 'NUMBER':
        case 'FIXED':
        case 'DECIMAL':
          factoryName = column.scale === 0 ? 'integer' : 'decimal';
          break;
        case 'TEXT':
        case 'VARCHAR':
        case 'CHAR':
          factoryName = 'text';
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
          break;
        case 'TIMESTAMP_NTZ':
        case 'TIMESTAMP_LTZ':
        case 'TIMESTAMP_TZ':
          factoryName = 'timestamp';
          mode = `, ${JSON.stringify(column.dataType.slice(10).toLowerCase())}`;
          break;
        case 'VARIANT':
        case 'ARRAY':
        case 'OBJECT':
          factoryName = 'variant';
          break;
        case 'BINARY':
          factoryName = 'binary';
          break;
        default:
          throw new TypeError(`Unsupported Snowflake type for code generation: ${column.dataType}`);
      }
      imports.add(factoryName);
      return `  ${JSON.stringify(column.name)}: ${factoryName}(${JSON.stringify(column.name)}${mode})${column.nullable ? '' : '.notNull()'},`;
    });
    return `export const table${index} = snowflakeTable(${JSON.stringify(table.name)}, {\n${columns.join('\n')}\n}, { database: ${JSON.stringify(table.database)}, schema: ${JSON.stringify(table.schema)} });`;
  });
  return `import { ${[...imports].sort().join(', ')} } from 'snowtyped';\n\n${declarations.join('\n\n')}\n`;
}
