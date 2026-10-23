import { type IdentifierNode, identifier } from '../ast.js';
import type { ColumnMap, ServerValue, Table } from '../schema.js';
import { serverClause } from './statements.js';
import { type PhysicalType, physicalType } from './types.js';

export interface ColumnDefinition {
  readonly key: string;
  readonly name: string;
  readonly type: PhysicalType;
  readonly notNull: boolean;
  /** Omitted comments are not managed; null requires no comment. */
  readonly comment?: string | null;
  /** DEFAULT, AUTOINCREMENT, or a virtual AS expression; omitted server values are not managed. */
  readonly serverValue?: ServerValue;
}
export interface TableDefinition {
  readonly kind: 'table-definition';
  readonly name: IdentifierNode;
  readonly columns: readonly ColumnDefinition[];
  readonly comment?: string | null;
}
export interface TableDefinitionOptions<C extends ColumnMap> {
  readonly types?: { readonly [K in keyof C]?: PhysicalType };
  readonly comments?: { readonly [K in keyof C]?: string | null };
  readonly comment?: string | null;
}
export interface SchemaDefinition {
  readonly kind: 'schema-definition';
  readonly name: IdentifierNode;
  readonly database: string;
  readonly schema: string;
  readonly tables: readonly TableDefinition[];
  readonly comment?: string | null;
}

function unknownKeys(record: object | undefined, columns: ColumnMap, label: string) {
  for (const key of Object.keys(record ?? {}))
    if (!Object.hasOwn(columns, key))
      throw new TypeError(`Unknown column key in ${label}: ${key}.`);
}

/** Physical DDL for a declared table. Each declared codec must fit its physical type. */
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

/** The desired state of one schema. Unqualified tables are placed in it. */
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
