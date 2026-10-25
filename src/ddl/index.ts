/**
 * Schema management: table definitions derived from declarations, schema and table DDL, schema
 * diffs, drift checks, and versioned migrations. It is a separate entry point, so query-only code
 * never loads it. Experimental: it may change in a minor release. See
 * [migrations](/guides/migrations/).
 *
 * @example
 * ```ts
 * import { createTable, defineTable, migrate } from 'snowtyped/ddl';
 *
 * const migrations = [
 *   { id: '0001_customers', statements: [createTable(defineTable(customers))] },
 * ];
 * await migrate(db, migrations, { database: 'APP_DB', schema: 'PUBLIC' });
 * ```
 * @categoryDescription Definitions
 * Physical table and schema definitions derived from declarations.
 * @categoryDescription Statements
 * Schema and table DDL builders.
 * @categoryDescription Physical types
 * Physical Snowflake column types for definitions and DDL.
 * @categoryDescription Diffs and drift
 * Comparing a desired schema with the database. See
 * [schema diffs and drift](/guides/migrations/#schema-diffs-and-drift).
 * @categoryDescription Migrations
 * Versioned migrations with history and locking. See [migrations](/guides/migrations/#migrations).
 * @module
 */
export {
  type ColumnDefinition,
  defineSchema,
  defineTable,
  type SchemaDefinition,
  type TableDefinition,
  type TableDefinitionOptions,
} from './definition.js';
export {
  type DiffOptions,
  diffSchema,
  type SchemaChange,
  type SchemaDiff,
  type UnsupportedChange,
} from './diff.js';
export {
  inspectSchema,
  type ObservedColumn,
  type ObservedSchema,
  type ObservedTable,
} from './inspect.js';
export {
  checkDrift,
  type DriftOptions,
  type IncompleteMigration,
  type MigrateOptions,
  type MigrateResult,
  type Migration,
  MigrationError,
  type MigrationErrorCode,
  type MigrationStatus,
  type MigrationTarget,
  migrate,
  migrationStatus,
  pushSchema,
} from './migrate.js';
export {
  type AlterTable,
  alterTable,
  type ColumnDefinitionNode,
  type ColumnOptions,
  compileDdl,
  createSchema,
  createTable,
  type DdlNode,
  type DdlStatement,
  dropSchema,
  dropTable,
  setSchemaComment,
} from './statements.js';
export {
  type ObservedType,
  type PhysicalType,
  sqlType,
  type UnmodeledType,
} from './types.js';
