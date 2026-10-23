import { identifier } from '../ast.js';
import type { SchemaDefinition } from './definition.js';
import type { ObservedSchema } from './inspect.js';
import {
  alterTable,
  createSchema,
  createTable,
  type DdlStatement,
  dropTable,
  setSchemaComment,
} from './statements.js';
import { alterableType, renderType, sameType } from './types.js';

export interface SchemaChange {
  readonly statement: DdlStatement;
  readonly destructive: boolean;
  readonly description: string;
}
/** A difference that needs a hand-written migration, such as a table rebuild. */
export interface UnsupportedChange {
  readonly table: string;
  readonly column: string;
  readonly reason: string;
}
export interface SchemaDiff {
  readonly changes: readonly SchemaChange[];
  readonly unsupported: readonly UnsupportedChange[];
}
export interface DiffOptions {
  /** Observed tables that are neither compared nor dropped. */
  readonly ignoreTables?: readonly string[];
}

/** Deterministic: follows declaration order, then drops extra tables by name. Renames are not inferred. */
export function diffSchema(
  desired: SchemaDefinition,
  observed: ObservedSchema,
  options: DiffOptions = {},
): SchemaDiff {
  if (observed.database !== desired.database || observed.schema !== desired.schema)
    throw new TypeError('The observed schema is not the desired schema.');
  const changes: SchemaChange[] = [];
  const unsupported: UnsupportedChange[] = [];
  const change = (statement: DdlStatement, description: string) =>
    changes.push(Object.freeze({ statement, destructive: statement.destructive, description }));
  const managed = (value: string | null | undefined, current: string | null) =>
    value !== undefined && value !== current;
  if (!observed.exists)
    change(
      createSchema(
        desired.name,
        typeof desired.comment === 'string' ? { comment: desired.comment } : {},
      ),
      `Create schema ${desired.schema}`,
    );
  else if (managed(desired.comment, observed.comment))
    change(
      setSchemaComment(desired.name, desired.comment as string | null),
      `Set comment on schema ${desired.schema}`,
    );
  const ignored = new Set(options.ignoreTables);
  const tables = new Map(observed.tables.map((table) => [table.name, table]));
  for (const table of desired.tables) {
    const name = table.name.parts[2] as string;
    const current = tables.get(name);
    if (!current) {
      change(createTable(table), `Create table ${name}`);
      continue;
    }
    const alter = alterTable(table.name);
    const columns = new Map(current.columns.map((column) => [column.name, column]));
    for (const column of table.columns) {
      const existing = columns.get(column.name);
      if (!existing && column.notNull) {
        unsupported.push(
          Object.freeze({
            table: name,
            column: column.name,
            reason: 'Adding a NOT NULL column to an existing table needs a default or backfill.',
          }),
        );
        continue;
      }
      if (!existing) {
        change(
          alter.addColumn(column.name, column.type, {
            ...(typeof column.comment === 'string' ? { comment: column.comment } : {}),
          }),
          `Add column ${name}.${column.name}`,
        );
        continue;
      }
      if (!sameType(column.type, existing.type)) {
        const from =
          existing.type.kind === 'OTHER' ? existing.type.name : renderType(existing.type);
        if (alterableType(existing.type, column.type))
          change(
            alter.setColumnType(column.name, column.type),
            `Change ${name}.${column.name} from ${from} to ${renderType(column.type)}`,
          );
        else
          unsupported.push(
            Object.freeze({
              table: name,
              column: column.name,
              reason: `Cannot change ${from} to ${renderType(column.type)} in place.`,
            }),
          );
      }
      if (column.notNull !== existing.notNull)
        change(
          column.notNull ? alter.setNotNull(column.name) : alter.dropNotNull(column.name),
          `${column.notNull ? 'Set' : 'Drop'} NOT NULL on ${name}.${column.name}`,
        );
      if (managed(column.comment, existing.comment))
        change(
          alter.setColumnComment(column.name, column.comment as string | null),
          `Set comment on ${name}.${column.name}`,
        );
    }
    const declared = new Set(table.columns.map((column) => column.name));
    for (const column of current.columns)
      if (!declared.has(column.name))
        change(alter.dropColumn(column.name), `Drop column ${name}.${column.name}`);
    if (managed(table.comment, current.comment))
      change(alter.setComment(table.comment as string | null), `Set comment on table ${name}`);
  }
  const declared = new Set(desired.tables.map((table) => table.name.parts[2]));
  const extra = observed.tables.map((table) => table.name).sort();
  for (const table of extra)
    if (!declared.has(table) && !ignored.has(table))
      change(dropTable(identifier(desired.database, desired.schema, table)), `Drop table ${table}`);
  return Object.freeze({
    changes: Object.freeze(changes),
    unsupported: Object.freeze(unsupported),
  });
}
