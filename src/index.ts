/**
 * Declare Snowflake tables once, then build typed queries, mutations, and parameterized raw SQL
 * from them. Query results are decoded into exact values and validated against the declarations.
 *
 * Declare tables with {@link snowflakeTable} and the column factories, query them with
 * {@link select}, and execute with a client from `snowtyped/snowflake`. The
 * [guides](/getting-started/) explain each feature in depth.
 *
 * @example
 * ```ts
 * import { eq, integer, select, snowflakeTable, text } from 'snowtyped';
 *
 * const customers = snowflakeTable('CUSTOMERS', {
 *   id: integer('ID').notNull(),
 *   name: text('NAME').notNull(),
 *   email: text('EMAIL'),
 * });
 * const query = select(customers, { id: customers.columns.id, email: customers.columns.email })
 *   .where(eq(customers.columns.name, 'Ada'));
 * ```
 * @categoryDescription Schema
 * Table and column declarations, the source of result types and validation. See
 * [schema declarations](/guides/schemas/).
 * @categoryDescription Queries
 * SELECT queries, set operations, CTEs, and subqueries. See [queries](/guides/queries/).
 * @categoryDescription Expressions
 * Comparisons, logic, ordering, and the expression types they produce. Literals are bound as
 * parameters. See [expressions](/guides/queries/#expressions).
 * @categoryDescription Functions
 * Typed SQL functions: arithmetic, CASE, COALESCE, casts, text, and dates.
 * @categoryDescription Aggregates
 * Aggregate functions for grouped queries and windows. See
 * [grouping](/guides/queries/#grouping-and-pagination).
 * @categoryDescription Windows
 * Window functions, frames, and their options. See
 * [windows and QUALIFY](/guides/snowflake-syntax/#windows-and-qualify).
 * @categoryDescription Relations
 * Loading related rows per parent in batched queries. See [relations](/guides/queries/#relations).
 * @categoryDescription Mutations
 * INSERT, UPDATE, DELETE, and MERGE. See [mutations](/guides/mutations/).
 * @categoryDescription Raw SQL
 * Parameterized tagged templates. See [raw SQL](/guides/raw-sql/).
 * @categoryDescription FLATTEN
 * See [FLATTEN](/guides/snowflake-syntax/#flatten).
 * @categoryDescription PIVOT and UNPIVOT
 * See [PIVOT and UNPIVOT](/guides/snowflake-syntax/#pivot-and-unpivot).
 * @categoryDescription MATCH_RECOGNIZE
 * Row pattern matching. See [MATCH_RECOGNIZE](/guides/snowflake-syntax/#match_recognize).
 * @categoryDescription Introspection
 * Reading an existing schema and generating declarations. See
 * [introspection](/guides/introspection/).
 * @categoryDescription AST
 * The syntax tree behind every query, and its compiler. Experimental: it may change in a minor
 * release. See [testing](/guides/testing/#compiled-sql).
 * @module
 */
export {
  compileAst,
  identifier,
  quoteIdentifier,
} from './ast.js';
export type * from './deprecated-types.js';
export {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  jsonPath,
  like,
  lower,
  lt,
  lte,
  max,
  min,
  ne,
  not,
  or,
  over,
  rangeBetween,
  rowNumber,
  rowsBetween,
  sum,
  upper,
} from './expressions.js';
export {
  add,
  avg,
  caseWhen,
  cast,
  coalesce,
  concat,
  dateAdd,
  dateDiff,
  datePart,
  dateTrunc,
  denseRank,
  div,
  lag,
  lead,
  length,
  mul,
  rank,
  sub,
  substring,
  trim,
} from './functions.js';
export {
  generateSchema,
  introspect,
} from './introspection.js';
export {
  matchRecognize,
  rowPattern,
} from './match-recognize.js';
export {
  deleteFrom,
  deleteUsing,
  insert,
  insertFrom,
  mergeInto,
  update,
  updateFrom,
} from './mutations.js';
export {
  dynamicPivot,
  pivot,
  unpivot,
} from './pivot.js';
export {
  exists,
  inSubquery,
  notExists,
  recursiveCte,
  scalar,
  select,
} from './query.js';
export {
  many,
  one,
  withRelations,
} from './relations.js';
export {
  alias,
  array,
  binary,
  boolean,
  date,
  decimal,
  float,
  geography,
  geometry,
  integer,
  object,
  snowflakeTable,
  text,
  time,
  timestamp,
  timeTravel,
  variant,
  vector,
} from './schema.js';
export { flatten } from './snowflake-syntax.js';
export { sql } from './sql.js';
export { structured } from './structured.js';
/**
 * Element types for {@link structured} ARRAY, OBJECT, and MAP columns. `integer`, `decimal`,
 * `text`, and `boolean` take the same constraint options as the column factories, and `array`,
 * `object`, and `map` nest them.
 *
 * @category Schema
 */
export * as structuredType from './structured-types.js';
/**
 * Every public type of `snowtyped`, `snowtyped/snowflake`, and `snowtyped/ddl`. The same types are
 * still exported individually, deprecated in favor of this namespace, until 2.0.
 *
 * @example
 * ```ts
 * import type { Snowtyped } from 'snowtyped';
 *
 * const query = select(customers, { id: customers.columns.id, email: customers.columns.email });
 * type Row = Snowtyped.InferRow<typeof query>;
 * // { readonly id: bigint; readonly email: string | null }
 * ```
 * @category Types
 */
export type * as Snowtyped from './types.js';
