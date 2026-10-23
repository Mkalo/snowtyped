import * as z from 'zod';
import type { SnowflakeClient } from '../snowflake/client.js';
import { sql } from '../sql.js';
import type { ObservedType } from './types.js';

export interface ObservedColumn {
  readonly name: string;
  readonly type: ObservedType;
  readonly notNull: boolean;
  readonly comment: string | null;
  readonly default: string | null;
  readonly identity: boolean;
}
export interface ObservedTable {
  readonly name: string;
  readonly comment: string | null;
  readonly columns: readonly ObservedColumn[];
}
export interface ObservedSchema {
  readonly database: string;
  readonly schema: string;
  readonly exists: boolean;
  readonly comment: string | null;
  readonly tables: readonly ObservedTable[];
}

const count = z.string().regex(/^\d+$/).transform(Number).nullable();
const metadata = () => ({
  schemata: z.compile(z.array(z.object({ COMMENT: z.string().nullable() }))),
  tables: z.compile(z.array(z.object({ TABLE_NAME: z.string(), COMMENT: z.string().nullable() }))),
  columns: z.compile(
    z.array(
      z.object({
        TABLE_NAME: z.string(),
        COLUMN_NAME: z.string(),
        DATA_TYPE: z.string(),
        IS_NULLABLE: z.enum(['YES', 'NO']),
        CHARACTER_MAXIMUM_LENGTH: count,
        NUMERIC_PRECISION: count,
        NUMERIC_SCALE: count,
        DATETIME_PRECISION: count,
        COLUMN_DEFAULT: z.string().nullable(),
        IS_IDENTITY: z.enum(['YES', 'NO']),
        COMMENT: z.string().nullable(),
      }),
    ),
  ),
});
type ColumnRow = z.infer<ReturnType<typeof metadata>['columns']>[number];

function observedType(row: ColumnRow): ObservedType {
  const precision = row.DATETIME_PRECISION ?? 9;
  switch (row.DATA_TYPE) {
    case 'NUMBER':
      return {
        kind: 'NUMBER',
        precision: row.NUMERIC_PRECISION ?? 38,
        scale: row.NUMERIC_SCALE ?? 0,
      };
    case 'TEXT':
      return row.CHARACTER_MAXIMUM_LENGTH === null
        ? { kind: 'VARCHAR' }
        : { kind: 'VARCHAR', length: row.CHARACTER_MAXIMUM_LENGTH };
    case 'TIME':
    case 'TIMESTAMP_NTZ':
    case 'TIMESTAMP_LTZ':
    case 'TIMESTAMP_TZ':
      return { kind: row.DATA_TYPE, precision };
    case 'BINARY':
    case 'FLOAT':
    case 'BOOLEAN':
    case 'DATE':
    case 'VARIANT':
    case 'ARRAY':
    case 'OBJECT':
      return { kind: row.DATA_TYPE };
    default:
      return { kind: 'OTHER', name: row.DATA_TYPE };
  }
}

/** Reads base tables and columns of one schema through INFORMATION_SCHEMA, limited by the role. */
export async function inspectSchema(
  client: Pick<SnowflakeClient, 'queryRaw'>,
  target: { readonly database: string; readonly schema: string },
): Promise<ObservedSchema> {
  const parse = metadata();
  const view = (name: string) => sql.identifier(target.database, 'INFORMATION_SCHEMA', name);
  const schemata = parse.schemata.parse(
    await client.queryRaw(
      sql`SELECT COMMENT FROM ${view('SCHEMATA')} WHERE SCHEMA_NAME = ${target.schema}`,
    ),
  );
  const tables = parse.tables.parse(
    await client.queryRaw(
      sql`SELECT TABLE_NAME, COMMENT FROM ${view('TABLES')} WHERE TABLE_SCHEMA = ${target.schema} AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME`,
    ),
  );
  const columns = parse.columns.parse(
    await client.queryRaw(
      sql`SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, IS_NULLABLE, CHARACTER_MAXIMUM_LENGTH, NUMERIC_PRECISION, NUMERIC_SCALE, DATETIME_PRECISION, COLUMN_DEFAULT, IS_IDENTITY, COMMENT
      FROM ${view('COLUMNS')} WHERE TABLE_SCHEMA = ${target.schema} ORDER BY TABLE_NAME, ORDINAL_POSITION`,
    ),
  );
  return Object.freeze({
    database: target.database,
    schema: target.schema,
    exists: schemata.length > 0,
    comment: schemata[0]?.COMMENT ?? null,
    tables: Object.freeze(
      tables.map((table) =>
        Object.freeze({
          name: table.TABLE_NAME,
          comment: table.COMMENT,
          columns: Object.freeze(
            columns
              .filter((row) => row.TABLE_NAME === table.TABLE_NAME)
              .map((row) =>
                Object.freeze({
                  name: row.COLUMN_NAME,
                  type: Object.freeze(observedType(row)),
                  notNull: row.IS_NULLABLE === 'NO',
                  comment: row.COMMENT,
                  default: row.COLUMN_DEFAULT,
                  identity: row.IS_IDENTITY === 'YES',
                }),
              ),
          ),
        }),
      ),
    ),
  });
}
