import { type IdentifierNode, identifier } from '../ast.js';
import type { ColumnMap, ServerValue, Table } from '../schema.js';
import { serverClause } from './statements.js';
import { type PhysicalType, physicalType } from './types.js';

/** A physical column of a {@link TableDefinition}. */
export interface ColumnDefinition {
  /** The column's key in the table declaration. */
  readonly key: string;
  /** The physical column name. */
  readonly name: string;
  /** The physical type, such as `VARCHAR(20)`. */
  readonly type: PhysicalType;
  /** Whether the column is NOT NULL. */
  readonly notNull: boolean;
  /** The column comment. Omitted comments are not managed; `null` requires no comment. */
  readonly comment?: string | null;
  /** DEFAULT, AUTOINCREMENT, or a virtual AS expression; omitted server values are not managed. */
  readonly serverValue?: ServerValue;
}
/** The physical definition of a table, created by {@link defineTable}. */
export interface TableDefinition {
  /** Identifies a table definition. */
  readonly kind: 'table-definition';
  /** The table's name, qualified as declared. */
  readonly name: IdentifierNode;
  /** The table's columns, in declaration order. */
  readonly columns: readonly ColumnDefinition[];
  /** The table comment. Omitted comments are not managed; `null` requires no comment. */
  readonly comment?: string | null;
}
/** Options of {@link defineTable}. Column keys are the declaration's keys. */
export interface TableDefinitionOptions<C extends ColumnMap> {
  /**
   * Physical types that override the derived ones, built with {@link sqlType}. Each declared codec
   * must be able to read its type.
   */
  readonly types?: { readonly [K in keyof C]?: PhysicalType };
  /** Column comments. Omitted comments are not managed; `null` requires no comment. */
  readonly comments?: { readonly [K in keyof C]?: string | null };
  /** The table comment. Omitted comments are not managed; `null` requires no comment. */
  readonly comment?: string | null;
}
/** The desired state of one schema, created by {@link defineSchema}. */
export interface SchemaDefinition {
  /** Identifies a schema definition. */
  readonly kind: 'schema-definition';
  /** The schema's qualified name. */
  readonly name: IdentifierNode;
  /** The schema's database. */
  readonly database: string;
  /** The schema's name. */
  readonly schema: string;
  /** The schema's tables, qualified with the schema. */
  readonly tables: readonly TableDefinition[];
  /** The schema comment. Omitted comments are not managed; `null` requires no comment. */
  readonly comment?: string | null;
}

function unknownKeys(record: object | undefined, columns: ColumnMap, label: string) {
  for (const key of Object.keys(record ?? {}))
    if (!Object.hasOwn(columns, key))
      throw new TypeError(`Unknown column key in ${label}: ${key}.`);
}

/**
 * Derives the physical definition of a declared table.
 *
 * Declared lengths, precisions, scales, and VECTOR element types and dimensions become the physical
 * type, such as `VARCHAR(20)` or `NUMBER(12, 4)`, and server values become DEFAULT, AUTOINCREMENT,
 * or AS clauses.
 *
 * @throws `TypeError` when `table` is not a base `snowflakeTable()` declaration, an option names an
 * unknown column, or a type does not fit its codec.
 * @example
 * ```ts
 * const customersTable = defineTable(customers, {
 *   types: { name: sqlType.varchar(200) },
 *   comments: { email: 'Primary contact' },
 * });
 * ```
 */
export function defineTable<C extends ColumnMap>(
  table: Table<C>,
  options: TableDefinitionOptions<C> = {},
): TableDefinition {
  if (table.source.kind !== 'table' || table.source.alias || table.source.temporal)
    throw new TypeError('Define DDL from a base snowflakeTable() declaration.');
  unknownKeys(options.types, table.columns, 'types');
  unknownKeys(options.comments, table.columns, 'comments');
  const types = (options.types ?? {}) as Readonly<Record<string, PhysicalType>>;
  const comments = (options.comments ?? {}) as Readonly<Record<string, string | null>>;
  return Object.freeze({
    kind: 'table-definition',
    name: table.node,
    columns: Object.freeze(
      Object.entries(table.columns).map(([key, value]) => {
        const name = value.node.parts[0] as string;
        const type = physicalType(value.dataType, value.constraints, types[key]);
        return Object.freeze({
          key,
          name,
          type,
          notNull: value.required,
          ...(comments[key] === undefined ? {} : { comment: comments[key] }),
          ...serverClause(name, type, value.required, value.serverValue ?? undefined),
        });
      }),
    ),
    ...(options.comment === undefined ? {} : { comment: options.comment }),
  });
}

/**
 * Defines the desired state of one schema from table declarations or definitions. Unqualified
 * tables are placed in it.
 *
 * @throws `TypeError` when a table is declared in another schema or two tables share a name.
 * @example
 * ```ts
 * const desired = defineSchema({ database: 'APP_DB', schema: 'PUBLIC' }, [customers]);
 * ```
 */
export function defineSchema(
  target: {
    readonly database: string;
    readonly schema: string;
    readonly comment?: string | null;
  },
  tables: readonly (TableDefinition | Table)[],
): SchemaDefinition {
  const definitions = tables.map((entry) => {
    const definition = 'kind' in entry ? entry : defineTable(entry);
    const parts = definition.name.parts;
    const name = parts.at(-1) as string;
    const qualifier = parts.slice(0, -1);
    const expected = [target.database, target.schema].slice(2 - qualifier.length);
    if (qualifier.some((part, index) => part !== expected[index]))
      throw new TypeError(`Table ${name} is declared outside ${target.database}.${target.schema}.`);
    return Object.freeze({
      ...definition,
      name: identifier(target.database, target.schema, name),
    });
  });
  const names = definitions.map((entry) => entry.name.parts[2]);
  if (new Set(names).size !== names.length) throw new TypeError('Duplicate table names in schema.');
  return Object.freeze({
    kind: 'schema-definition',
    name: identifier(target.database, target.schema),
    database: target.database,
    schema: target.schema,
    tables: Object.freeze(definitions),
    ...(target.comment === undefined ? {} : { comment: target.comment }),
  });
}
