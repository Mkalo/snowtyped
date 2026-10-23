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
