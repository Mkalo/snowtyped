import { type CompiledQuery, type IdentifierNode, identifier, quoteIdentifier } from '../ast.js';
import type { ServerValue, Table } from '../schema.js';
import type { TableDefinition } from './definition.js';
import { type PhysicalType, renderType } from './types.js';

export interface ColumnDefinitionNode {
  readonly name: IdentifierNode;
  readonly type: PhysicalType;
  readonly notNull: boolean;
  readonly comment?: string;
  readonly serverValue?: ServerValue;
}
export type DdlNode =
  | {
      readonly kind: 'create-schema';
      readonly name: IdentifierNode;
      readonly ifNotExists: boolean;
      readonly comment?: string;
    }
  | {
      readonly kind: 'drop-schema';
      readonly name: IdentifierNode;
      readonly ifExists: boolean;
      readonly cascade: boolean;
    }
  | {
      readonly kind: 'set-schema-comment';
      readonly name: IdentifierNode;
      readonly comment: string | null;
    }
  | {
      readonly kind: 'create-table';
      readonly name: IdentifierNode;
      readonly columns: readonly ColumnDefinitionNode[];
      readonly ifNotExists: boolean;
      readonly orReplace: boolean;
      readonly comment?: string;
    }
  | {
      readonly kind: 'drop-table';
      readonly name: IdentifierNode;
      readonly ifExists: boolean;
    }
  | {
      readonly kind: 'rename-table';
      readonly name: IdentifierNode;
      readonly to: IdentifierNode;
    }
  | {
      readonly kind: 'set-table-comment';
      readonly name: IdentifierNode;
      readonly comment: string | null;
    }
  | {
      readonly kind: 'add-column';
      readonly name: IdentifierNode;
      readonly column: ColumnDefinitionNode;
    }
  | {
      readonly kind: 'drop-column';
      readonly name: IdentifierNode;
      readonly column: IdentifierNode;
    }
  | {
      readonly kind: 'rename-column';
      readonly name: IdentifierNode;
      readonly column: IdentifierNode;
      readonly to: IdentifierNode;
    }
  | {
      readonly kind: 'set-column-type';
      readonly name: IdentifierNode;
      readonly column: IdentifierNode;
      readonly type: PhysicalType;
    }
  | {
      readonly kind: 'set-column-not-null';
      readonly name: IdentifierNode;
      readonly column: IdentifierNode;
      readonly notNull: boolean;
    }
  | {
      readonly kind: 'drop-column-default';
      readonly name: IdentifierNode;
      readonly column: IdentifierNode;
    }
  | {
      readonly kind: 'set-column-comment';
      readonly name: IdentifierNode;
      readonly column: IdentifierNode;
      readonly comment: string | null;
    };
/** Snowflake commits each DDL statement on its own; destructive statements can lose data. */
export interface DdlStatement {
  readonly kind: 'ddl';
  readonly node: DdlNode;
  readonly destructive: boolean;
  compile(): CompiledQuery;
}
export interface ColumnOptions {
  readonly notNull?: boolean;
  readonly comment?: string;
  /** Expressions are trusted SQL text, as written in the column declaration. */
  readonly serverValue?: ServerValue;
}

/** DDL cannot bind parameters, so comments compile to escaped string literals. */
export function literal(value: string): string {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "''")}'`;
}
/** Rejects server values Snowflake DDL cannot express for the column. */
export function serverClause(
  name: string,
  type: PhysicalType,
  notNull: boolean,
  value: ServerValue | undefined,
): { readonly serverValue?: ServerValue } {
  if (!value) return {};
  if (value.kind !== 'identity' && value.expression === undefined)
    throw new TypeError(
      `Column ${name} needs a ${value.kind === 'default' ? 'serverDefault' : 'virtual'} expression for DDL.`,
    );
  if (value.kind === 'identity' && type.kind !== 'NUMBER' && type.kind !== 'FLOAT')
    throw new TypeError(`Identity column ${name} cannot be stored as ${renderType(type)}.`);
  // Snowflake stores `+5` as UNARY PLUS(5), and inserts into the table then fail internally.
  if (value.kind === 'default' && /^\s*\+/.test(value.expression as string))
    throw new TypeError(`Write the DEFAULT of column ${name} without a leading +.`);
  if (value.kind === 'default' && type.kind === 'STRUCTURED')
    throw new TypeError(`Structured column ${name} cannot have a DEFAULT.`);
  if (value.kind === 'virtual' && notNull)
    throw new TypeError(`Virtual column ${name} cannot be NOT NULL.`);
  return { serverValue: value };
}
function server(value: ServerValue | undefined): string {
  if (!value) return '';
  if (value.kind === 'default') return ` DEFAULT ${value.expression}`;
  if (value.kind === 'virtual') return ` AS (${value.expression})`;
  const steps =
    value.start === undefined && value.increment === undefined
      ? ''
      : ` START ${value.start ?? 1} INCREMENT ${value.increment ?? 1}`;
  return ` AUTOINCREMENT${steps}${value.order === undefined ? '' : value.order ? ' ORDER' : ' NOORDER'}`;
}
function column(node: ColumnDefinitionNode): string {
  return `${quoteIdentifier(node.name)} ${renderType(node.type)}${server(node.serverValue)}${node.notNull ? ' NOT NULL' : ''}${node.comment === undefined ? '' : ` COMMENT ${literal(node.comment)}`}`;
}
function comment(value: string | null): string {
  return value === null ? 'UNSET COMMENT' : `SET COMMENT = ${literal(value)}`;
}

export function compileDdl(node: DdlNode): string {
  const name = quoteIdentifier(node.name);
  switch (node.kind) {
    case 'create-schema':
      return `CREATE SCHEMA ${node.ifNotExists ? 'IF NOT EXISTS ' : ''}${name}${node.comment === undefined ? '' : ` COMMENT = ${literal(node.comment)}`}`;
    case 'drop-schema':
      return `DROP SCHEMA ${node.ifExists ? 'IF EXISTS ' : ''}${name} ${node.cascade ? 'CASCADE' : 'RESTRICT'}`;
    case 'set-schema-comment':
      return `ALTER SCHEMA ${name} ${comment(node.comment)}`;
    case 'create-table':
      return `CREATE ${node.orReplace ? 'OR REPLACE ' : ''}TABLE ${node.ifNotExists ? 'IF NOT EXISTS ' : ''}${name} (${node.columns.map(column).join(', ')})${node.comment === undefined ? '' : ` COMMENT = ${literal(node.comment)}`}`;
    case 'drop-table':
      return `DROP TABLE ${node.ifExists ? 'IF EXISTS ' : ''}${name}`;
    case 'rename-table':
      return `ALTER TABLE ${name} RENAME TO ${quoteIdentifier(node.to)}`;
    case 'set-table-comment':
      return `ALTER TABLE ${name} ${comment(node.comment)}`;
    case 'add-column':
      return `ALTER TABLE ${name} ADD COLUMN ${column(node.column)}`;
    case 'drop-column':
      return `ALTER TABLE ${name} DROP COLUMN ${quoteIdentifier(node.column)}`;
    case 'rename-column':
      return `ALTER TABLE ${name} RENAME COLUMN ${quoteIdentifier(node.column)} TO ${quoteIdentifier(node.to)}`;
    case 'set-column-type':
      return `ALTER TABLE ${name} ALTER COLUMN ${quoteIdentifier(node.column)} SET DATA TYPE ${renderType(node.type)}`;
    case 'set-column-not-null':
      return `ALTER TABLE ${name} ALTER COLUMN ${quoteIdentifier(node.column)} ${node.notNull ? 'SET' : 'DROP'} NOT NULL`;
    case 'drop-column-default':
      return `ALTER TABLE ${name} ALTER COLUMN ${quoteIdentifier(node.column)} DROP DEFAULT`;
    case 'set-column-comment':
      return `ALTER TABLE ${name} ALTER COLUMN ${quoteIdentifier(node.column)} ${node.comment === null ? 'UNSET COMMENT' : `COMMENT ${literal(node.comment)}`}`;
    default:
      throw new TypeError('Unsupported DDL AST node.');
  }
}

const destructiveKinds = new Set<DdlNode['kind']>(['drop-schema', 'drop-table', 'drop-column']);
export function statement(node: DdlNode): DdlStatement {
  const frozen = Object.freeze(node);
  const text = compileDdl(frozen);
  return Object.freeze({
    kind: 'ddl',
    node: frozen,
    destructive:
      destructiveKinds.has(frozen.kind) || (frozen.kind === 'create-table' && frozen.orReplace),
    compile: () => Object.freeze({ sql: text, binds: Object.freeze([]) }),
  });
}
export function isDdlStatement(value: unknown): value is DdlStatement {
  return typeof value === 'object' && value !== null && 'kind' in value && value.kind === 'ddl';
}

function nameOf(target: Table | IdentifierNode): IdentifierNode {
  return 'node' in target ? target.node : target;
}
export function columnNode(
  name: string,
  type: PhysicalType,
  options: ColumnOptions = {},
): ColumnDefinitionNode {
  const notNull = options.notNull ?? false;
  return Object.freeze({
    name: identifier(name),
    type,
    notNull,
    ...(options.comment === undefined ? {} : { comment: options.comment }),
    ...serverClause(name, type, notNull, options.serverValue),
  });
}

export function createSchema(
  name: IdentifierNode,
  options: { readonly ifNotExists?: boolean; readonly comment?: string } = {},
): DdlStatement {
  return statement({
    kind: 'create-schema',
    name,
    ifNotExists: options.ifNotExists ?? false,
    ...(options.comment === undefined ? {} : { comment: options.comment }),
  });
}
export function dropSchema(
  name: IdentifierNode,
  options: { readonly ifExists?: boolean; readonly cascade?: boolean } = {},
): DdlStatement {
  return statement({
    kind: 'drop-schema',
    name,
    ifExists: options.ifExists ?? false,
    cascade: options.cascade ?? false,
  });
}
export function setSchemaComment(name: IdentifierNode, value: string | null): DdlStatement {
  return statement({ kind: 'set-schema-comment', name, comment: value });
}
export function createTable(
  definition: TableDefinition,
  options: {
    readonly ifNotExists?: boolean;
    readonly orReplace?: boolean;
  } = {},
): DdlStatement {
  if (options.ifNotExists && options.orReplace)
    throw new TypeError('CREATE TABLE cannot combine OR REPLACE with IF NOT EXISTS.');
  return statement({
    kind: 'create-table',
    name: definition.name,
    columns: Object.freeze(
      definition.columns.map((entry) =>
        columnNode(entry.name, entry.type, {
          notNull: entry.notNull,
          ...(typeof entry.comment === 'string' ? { comment: entry.comment } : {}),
          ...(entry.serverValue ? { serverValue: entry.serverValue } : {}),
        }),
      ),
    ),
    ifNotExists: options.ifNotExists ?? false,
    orReplace: options.orReplace ?? false,
    ...(typeof definition.comment === 'string' ? { comment: definition.comment } : {}),
  });
}
export function dropTable(
  target: Table | IdentifierNode,
  options: { readonly ifExists?: boolean } = {},
): DdlStatement {
  return statement({
    kind: 'drop-table',
    name: nameOf(target),
    ifExists: options.ifExists ?? false,
  });
}

export interface AlterTable {
  /** Renames within the same database and schema. */
  renameTo(name: string): DdlStatement;
  setComment(comment: string | null): DdlStatement;
  addColumn(name: string, type: PhysicalType, options?: ColumnOptions): DdlStatement;
  dropColumn(name: string): DdlStatement;
  renameColumn(name: string, to: string): DdlStatement;
  setColumnType(name: string, type: PhysicalType): DdlStatement;
  setNotNull(name: string): DdlStatement;
  dropNotNull(name: string): DdlStatement;
  setColumnComment(name: string, comment: string | null): DdlStatement;
  dropDefault(name: string): DdlStatement;
}
export function alterTable(target: Table | IdentifierNode): AlterTable {
  const name = nameOf(target);
  return Object.freeze({
    renameTo: (to: string) =>
      statement({
        kind: 'rename-table',
        name,
        to: identifier(...(name.parts.slice(0, -1) as [string]), to),
      }),
    setComment: (value: string | null) =>
      statement({ kind: 'set-table-comment', name, comment: value }),
    addColumn: (column: string, type: PhysicalType, options?: ColumnOptions) =>
      statement({
        kind: 'add-column',
        name,
        column: columnNode(column, type, options),
      }),
    dropColumn: (column: string) =>
      statement({ kind: 'drop-column', name, column: identifier(column) }),
    renameColumn: (column: string, to: string) =>
      statement({
        kind: 'rename-column',
        name,
        column: identifier(column),
        to: identifier(to),
      }),
    setColumnType: (column: string, type: PhysicalType) =>
      statement({
        kind: 'set-column-type',
        name,
        column: identifier(column),
        type,
      }),
    setNotNull: (column: string) =>
      statement({
        kind: 'set-column-not-null',
        name,
        column: identifier(column),
        notNull: true,
      }),
    dropNotNull: (column: string) =>
      statement({
        kind: 'set-column-not-null',
        name,
        column: identifier(column),
        notNull: false,
      }),
    dropDefault: (column: string) =>
      statement({
        kind: 'drop-column-default',
        name,
        column: identifier(column),
      }),
    setColumnComment: (column: string, value: string | null) =>
      statement({
        kind: 'set-column-comment',
        name,
        column: identifier(column),
        comment: value,
      }),
  });
}
