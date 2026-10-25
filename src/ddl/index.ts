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
  defineSchema,
  defineTable,
} from './definition.js';
export type * from './deprecated-types.js';
export { diffSchema } from './diff.js';
export { inspectSchema } from './inspect.js';
export {
  checkDrift,
  MigrationError,
  migrate,
  migrationStatus,
  pushSchema,
} from './migrate.js';
export {
  alterTable,
  compileDdl,
  createSchema,
  createTable,
  dropSchema,
  dropTable,
  setSchemaComment,
} from './statements.js';
export { sqlType } from './types.js';
