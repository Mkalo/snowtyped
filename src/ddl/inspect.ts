import * as z from 'zod';
import type { ServerValue } from '../schema.js';
import type { SnowflakeClient } from '../snowflake/client.js';
import { sql } from '../sql.js';
import { defaultVarcharLengths, type ObservedType } from './types.js';

/** A column as {@link inspectSchema} read it from Snowflake. */
export interface ObservedColumn {
  /** The physical column name. */
  readonly name: string;
  /** The column's physical type. */
  readonly type: ObservedType;
  /** Whether the column is NOT NULL. */
  readonly notNull: boolean;
  /** The column comment. */
  readonly comment: string | null;
  /** The column's default, identity, or virtual expression. */
  readonly serverValue: ServerValue | null;
}
/** A base table as {@link inspectSchema} read it from Snowflake. */
export interface ObservedTable {
  /** The physical table name. */
  readonly name: string;
  /** The table comment. */
  readonly comment: string | null;
  /** The table's columns, in ordinal order. */
  readonly columns: readonly ObservedColumn[];
}
/** A schema as {@link inspectSchema} read it from Snowflake. */
export interface ObservedSchema {
  /** The schema's database. */
  readonly database: string;
  /** The schema's name. */
  readonly schema: string;
  /** Whether the schema exists. */
  readonly exists: boolean;
  /** The schema comment. */
  readonly comment: string | null;
  /** The schema's base tables. */
  readonly tables: readonly ObservedTable[];
}

const count = z.string().regex(/^\d+$/).transform(Number).nullable();
const signed = z
  .string()
  .regex(/^-?\d+$/)
  .transform(Number)
  .nullable();
const metadata = () => ({
  schemata: z.compile(z.array(z.object({ COMMENT: z.string().nullable() }))),
  tables: z.compile(z.array(z.object({ TABLE_NAME: z.string(), COMMENT: z.string().nullable() }))),
  columns: z.compile(
    z.array(
      z.object({
        TABLE_NAME: z.string(),
        COLUMN_NAME: z.string(),
        DATA_TYPE: z.string(),
        DATA_TYPE_ALIAS: z.string().nullable(),
        IS_NULLABLE: z.enum(['YES', 'NO']),
        CHARACTER_MAXIMUM_LENGTH: count,
        NUMERIC_PRECISION: count,
        NUMERIC_SCALE: count,
        DATETIME_PRECISION: count,
        COLUMN_DEFAULT: z.string().nullable(),
        IS_IDENTITY: z.enum(['YES', 'NO']),
        IDENTITY_START: signed,
        IDENTITY_INCREMENT: signed,
        IDENTITY_ORDERED: z.enum(['YES', 'NO']).nullable(),
        KIND: z.string(),
        EXPRESSION: z.string().nullable(),
        COMMENT: z.string().nullable(),
      }),
    ),
  ),
});
type ColumnRow = z.infer<ReturnType<typeof metadata>['columns']>[number];

/** A structured type as `SHOW COLUMNS` reports it. */
interface ShownType {
  readonly type: string;
  readonly precision?: number | undefined;
  readonly scale?: number | undefined;
  readonly length?: number | undefined;
  readonly elementType?: ShownType | undefined;
  readonly keyType?: ShownType | undefined;
  readonly valueType?: ShownType | undefined;
  readonly fields?:
    | readonly { readonly fieldName: string; readonly fieldType: ShownType }[]
    | undefined;
}
const shownType: z.ZodType<ShownType> = z.lazy(() =>
  z.object({
    type: z.string(),
    precision: z.number().optional(),
    scale: z.number().optional(),
    length: z.number().optional(),
    elementType: shownType.optional(),
    keyType: shownType.optional(),
    valueType: shownType.optional(),
    fields: z.array(z.object({ fieldName: z.string(), fieldType: shownType })).optional(),
  }),
);
const shownColumns = z.array(z.object({ column_name: z.string(), data_type: z.string() }));
const structuredAlias = /^(?:ARRAY|OBJECT|MAP)\(/;

/** Renders the spelling `structuredType` builders produce; other element types are unmodeled. */
function structureSql(type: ShownType): string | undefined {
  switch (type.type) {
    case 'FIXED':
      return `NUMBER(${type.precision},${type.scale})`;
    case 'TEXT':
      return defaultVarcharLengths.includes(type.length as number)
        ? 'VARCHAR'
        : `VARCHAR(${type.length})`;
    case 'BOOLEAN':
      return 'BOOLEAN';
    case 'ARRAY': {
      const element = type.elementType && structureSql(type.elementType);
      return element && `ARRAY(${element})`;
    }
    case 'OBJECT': {
      const fields = type.fields?.map((field) => {
        const value = structureSql(field.fieldType);
        return value && `"${field.fieldName.replaceAll('"', '""')}" ${value}`;
      });
      return fields?.every(Boolean) ? `OBJECT(${fields.join(', ')})` : undefined;
    }
    case 'MAP': {
      const key = type.keyType && structureSql(type.keyType);
      const value = type.valueType && structureSql(type.valueType);
      return key && value && `MAP(${key}, ${value})`;
    }
    default:
      return undefined;
  }
}

function observedType(row: ColumnRow, shown: string | undefined): ObservedType {
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
    case 'VECTOR': {
      const match = /^VECTOR\((INT|FLOAT), (\d+)\)$/.exec(row.DATA_TYPE_ALIAS ?? '');
      return match
        ? {
            kind: 'VECTOR',
            element: match[1] as 'INT' | 'FLOAT',
            dimension: Number(match[2]),
          }
        : { kind: 'OTHER', name: row.DATA_TYPE_ALIAS ?? row.DATA_TYPE };
    }
    case 'ARRAY':
    case 'OBJECT':
    case 'MAP': {
      if (!structuredAlias.test(row.DATA_TYPE_ALIAS ?? ''))
        return row.DATA_TYPE === 'MAP'
          ? { kind: 'OTHER', name: row.DATA_TYPE }
          : { kind: row.DATA_TYPE };
      // INFORMATION_SCHEMA aliases upper-case field names and can lag behind ALTER, so SHOW COLUMNS is used.
      const structure =
        shown === undefined ? undefined : structureSql(shownType.parse(JSON.parse(shown)));
      return structure === undefined
        ? { kind: 'OTHER', name: row.DATA_TYPE_ALIAS as string }
        : { kind: 'STRUCTURED', sql: structure };
    }
    case 'BINARY':
    case 'FLOAT':
    case 'BOOLEAN':
    case 'DATE':
    case 'VARIANT':
    case 'GEOGRAPHY':
    case 'GEOMETRY':
      return { kind: row.DATA_TYPE };
    default:
      return { kind: 'OTHER', name: row.DATA_TYPE_ALIAS ?? row.DATA_TYPE };
  }
}
function serverValue(row: ColumnRow): ServerValue | null {
  if (row.KIND !== 'COLUMN')
    return row.EXPRESSION === null
      ? { kind: 'virtual' }
      : { kind: 'virtual', expression: row.EXPRESSION };
  if (row.IS_IDENTITY === 'YES')
    return {
      kind: 'identity',
      ...(row.IDENTITY_START === null ? {} : { start: row.IDENTITY_START }),
      ...(row.IDENTITY_INCREMENT === null ? {} : { increment: row.IDENTITY_INCREMENT }),
      ...(row.IDENTITY_ORDERED === null ? {} : { order: row.IDENTITY_ORDERED === 'YES' }),
    };
  return row.COLUMN_DEFAULT === null ? null : { kind: 'default', expression: row.COLUMN_DEFAULT };
}

const freeze = <T>(value: T): T => (value === null ? value : Object.freeze(value));

/**
 * Reads a schema's base tables and columns through `INFORMATION_SCHEMA`, and structured types
 * through `SHOW COLUMNS`. Results are limited to what the connection's role can access.
 *
 * @param client - A client from `snowtyped/snowflake`.
 * @param target - The schema to read, such as a {@link SchemaDefinition}.
 */
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
      sql`SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, IS_NULLABLE, CHARACTER_MAXIMUM_LENGTH, NUMERIC_PRECISION, NUMERIC_SCALE, DATETIME_PRECISION, COLUMN_DEFAULT, IS_IDENTITY, COMMENT,
        DATA_TYPE_ALIAS, IDENTITY_START, IDENTITY_INCREMENT, IDENTITY_ORDERED, KIND, EXPRESSION
      FROM ${view('COLUMNS')} WHERE TABLE_SCHEMA = ${target.schema} ORDER BY TABLE_NAME, ORDINAL_POSITION`,
    ),
  );
  const shown = new Map<string, string>();
  for (const table of tables) {
    const rows = columns.filter((row) => row.TABLE_NAME === table.TABLE_NAME);
    if (!rows.some((row) => structuredAlias.test(row.DATA_TYPE_ALIAS ?? ''))) continue;
    const name = sql.identifier(target.database, target.schema, table.TABLE_NAME);
    for (const entry of shownColumns.parse(
      await client.queryRaw(sql`SHOW COLUMNS IN TABLE ${name}`),
    ))
      shown.set(JSON.stringify([table.TABLE_NAME, entry.column_name]), entry.data_type);
  }
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
                  type: Object.freeze(
                    observedType(row, shown.get(JSON.stringify([row.TABLE_NAME, row.COLUMN_NAME]))),
                  ),
                  notNull: row.IS_NULLABLE === 'NO',
                  comment: row.COMMENT,
                  serverValue: freeze(serverValue(row)),
                }),
              ),
          ),
        }),
      ),
    ),
  });
}
