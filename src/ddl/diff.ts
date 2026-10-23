import { identifier } from '../ast.js';
import type { ServerValue } from '../schema.js';
import type { ColumnDefinition, SchemaDefinition } from './definition.js';
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
const number = /^(-?)(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i;
const constant =
  /^\s*(?:-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?|'(?:[^'\\]|''|\\[\s\S])*'|\$\$(?:(?!\$\$)[\s\S])*\$\$|TRUE|FALSE|NULL)\s*$/i;
const nullDefault = /^\s*NULL\s*$/i;
const escapes: Record<string, string> = { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', 0: '\0' };
/** Decodes a Snowflake string literal, which Snowflake re-renders after resolving escapes. */
function stringValue(literal: string): string {
  if (literal.startsWith('$$')) return literal.slice(2, -2);
  return literal
    .slice(1, -1)
    .replace(
      /''|\\(?:([0-7]{3})|x([0-9a-f]{2})|u([0-9a-f]{4})|([\s\S]))/gi,
      (match, octal, hex, unicode, char) =>
        match === "''"
          ? "'"
          : octal
            ? String.fromCharCode(Number.parseInt(octal, 8))
            : hex || unicode
              ? String.fromCharCode(Number.parseInt(hex ?? unicode, 16))
              : (escapes[char] ?? char),
    );
}
/**
 * Snowflake re-renders string literals and normalizes numbers (`1.50` becomes `1.5`), so both
 * compare by value; booleans compare by name. Other expressions come back rewritten and are not compared.
 */
function constantValue(expression: string): string | undefined {
  if (!constant.test(expression)) return undefined;
  const text = expression.trim();
  const parts = number.exec(text);
  if (!parts) return /^['$]/.test(text) ? JSON.stringify(stringValue(text)) : text.toUpperCase();
  const [, sign, whole, fraction = '', exponent = '0'] = parts;
  const digits = `${whole}${fraction}`.replace(/^0+/, '');
  if (!digits) return '0';
  const significant = digits.replace(/0+$/, '');
  const scale = Number(exponent) - fraction.length + digits.length - significant.length;
  return `${sign === '-' ? '-' : ''}${significant}e${scale}`;
}

/** Snowflake adds identity and non-constant default columns only to empty tables. */
function additionBlocker(column: ColumnDefinition): string | undefined {
  const value = column.serverValue;
  if (value?.kind === 'identity')
    return 'Adding an identity column to an existing table needs a rebuild.';
  if (value?.kind === 'default' && !constant.test(value.expression as string))
    return 'Snowflake only accepts constant defaults when adding a column.';
  if (column.notNull && (value?.kind !== 'default' || nullDefault.test(value.expression as string)))
    return 'Adding a NOT NULL column to an existing table needs a default or backfill.';
  return undefined;
}

const serverLabel = (value: ServerValue | null) =>
  value === null
    ? 'no server value'
    : {
        default: 'a DEFAULT',
        identity: 'AUTOINCREMENT',
        virtual: 'a virtual expression',
      }[value.kind];

/** Only constant defaults are compared, by value for numbers. */
function serverValueBlocker(
  desired: ServerValue | undefined,
  observed: ServerValue | null,
): string | undefined {
  if (!desired) return undefined;
  // Snowflake records DEFAULT NULL as no default.
  if (
    observed === null &&
    desired.kind === 'default' &&
    nullDefault.test(desired.expression as string)
  )
    return undefined;
  if (desired.kind !== observed?.kind)
    return `Cannot change ${serverLabel(observed)} to ${serverLabel(desired)} in place.`;
  if (desired.kind === 'default' && observed.kind === 'default') {
    const from = (observed.expression as string).trim();
    const to = (desired.expression as string).trim();
    const [left, right] = [constantValue(from), constantValue(to)];
    return left !== undefined && right !== undefined && left !== right
      ? `Cannot change the DEFAULT from ${from} to ${to} in place.`
      : undefined;
  }
  if (desired.kind !== 'identity' || observed.kind !== 'identity') return undefined;
  const changed = (['start', 'increment', 'order'] as const).filter(
    (key) => desired[key] !== undefined && desired[key] !== observed[key],
  );
  return changed.length === 0
    ? undefined
    : `Cannot change the AUTOINCREMENT ${changed.join(', ')} in place.`;
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
    changes.push(
      Object.freeze({
        statement,
        destructive: statement.destructive,
        description,
      }),
    );
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
      const skip = (reason: string) =>
        unsupported.push(Object.freeze({ table: name, column: column.name, reason }));
      if (!existing) {
        const reason = additionBlocker(column);
        if (reason) {
          skip(reason);
          continue;
        }
        change(
          alter.addColumn(column.name, column.type, {
            notNull: column.notNull,
            ...(typeof column.comment === 'string' ? { comment: column.comment } : {}),
            ...(column.serverValue ? { serverValue: column.serverValue } : {}),
          }),
          `Add column ${name}.${column.name}`,
        );
        continue;
      }
      const server = serverValueBlocker(column.serverValue, existing.serverValue);
      if (server) skip(server);
      if (!sameType(column.type, existing.type)) {
        const from =
          existing.type.kind === 'OTHER' ? existing.type.name : renderType(existing.type);
        if (alterableType(existing.type, column.type))
          change(
            alter.setColumnType(column.name, column.type),
            `Change ${name}.${column.name} from ${from} to ${renderType(column.type)}`,
          );
        else skip(`Cannot change ${from} to ${renderType(column.type)} in place.`);
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
