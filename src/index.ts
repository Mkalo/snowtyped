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
  type AssignmentNode,
  type BindValue,
  type CompiledQuery,
  type CteNode,
  compileAst,
  type DefaultNode,
  type DeleteNode,
  type DerivedNode,
  type EqualityNode,
  type ExistsNode,
  type ExpressionNode,
  type FlattenNode,
  type FrameBoundaryNode,
  type IdentifierNode,
  type InSubqueryNode,
  type InsertNode,
  type IntervalUnit,
  identifier,
  type JoinNode,
  type MatchRecognizeNode,
  type MergeBranchNode,
  type MergeNode,
  type NavigationNode,
  type OrderNode,
  type PatternNode,
  type PivotLiteral,
  type PivotNode,
  type QueryNode,
  quoteIdentifier,
  type RelationNode,
  type SelectNode,
  type SelfReferenceNode,
  type SemanticsNode,
  type SetOperationNode,
  type SetOperator,
  type SourceReference,
  type StarNode,
  type StatementNode,
  type SubqueryNode,
  type TableNode,
  type TemporalNode,
  type UnpivotNode,
  type UpdateNode,
  type WindowFrameNode,
  type WireType,
} from './ast.js';
export {
  type AnyExpression,
  and,
  asc,
  count,
  desc,
  type Expression,
  eq,
  type FrameBoundary,
  type FramedWindowOptions,
  gt,
  gte,
  type InferExpression,
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
  type Ordering,
  or,
  over,
  type Predicate,
  type RangeBoundary,
  rangeBetween,
  rowNumber,
  rowsBetween,
  sum,
  upper,
  type WindowFrame,
} from './expressions.js';
export {
  add,
  avg,
  type CaseExpression,
  type CastType,
  type CastValue,
  caseWhen,
  cast,
  coalesce,
  concat,
  type DatePart,
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
  type OffsetWindowOptions,
  type OrderedWindowOptions,
  rank,
  sub,
  substring,
  trim,
} from './functions.js';
export {
  generateSchema,
  type IntrospectedColumn,
  type IntrospectedTable,
  introspect,
} from './introspection.js';
export {
  type AfterMatch,
  type DefineContext,
  type MatchRecognizeColumns,
  type MatchRecognizeOptions,
  type MatchRowScope,
  type MatchVariableScope,
  type MeasureContext,
  matchRecognize,
  type Navigation,
  type QuantifiablePattern,
  type QuantifierOptions,
  type RowPattern,
  type RowsPerMatch,
  rowPattern,
} from './match-recognize.js';
export {
  deleteFrom,
  deleteUsing,
  type FilteredMutation,
  type InferInsert,
  type InferUpdate,
  type InsertSource,
  type InsertValues,
  insert,
  insertFrom,
  type MergeQuery,
  type MutationQuery,
  mergeInto,
  type UpdateValues,
  update,
  updateFrom,
} from './mutations.js';
export {
  dynamicPivot,
  type PivotAggregate,
  type PivotColumns,
  type PivotOptions,
  type PivotValue,
  pivot,
  type UnpivotColumns,
  type UnpivotOptions,
  unpivot,
} from './pivot.js';
export {
  type CompatibleOperand,
  exists,
  type InferRow,
  type IntersectRow,
  inSubquery,
  notExists,
  type OperandRow,
  type RecursiveName,
  type RecursiveOperand,
  type RecursiveRow,
  recursiveCte,
  type SelectQuery,
  type SetColumns,
  type SetOperand,
  type SetQuery,
  type SetScope,
  scalar,
  select,
  type UnionRow,
} from './query.js';
export {
  type LoadedQuery,
  type LoadedRow,
  type LoadOptions,
  many,
  one,
  type Relation,
  type RelationCardinality,
  type RelationKeyType,
  type RelationRow,
  withRelations,
} from './relations.js';
export {
  type AnyColumn,
  alias,
  array,
  type BoundColumns,
  binary,
  boolean,
  type Column,
  type ColumnMap,
  type ColumnValue,
  type DataType,
  date,
  decimal,
  float,
  geography,
  geometry,
  type IdentityOptions,
  type InferColumn,
  type InferSelection,
  integer,
  object,
  type Projection,
  type Selection,
  type ServerValue,
  type ServerValueKind,
  type ServerValues,
  snowflakeTable,
  type Table,
  type TableOptions,
  text,
  time,
  timestamp,
  timeTravel,
  variant,
  vector,
} from './schema.js';
export { type FlattenOptions, flatten } from './snowflake-syntax.js';
export type { GeoJsonGeometry, GeoPosition } from './spatial.js';
export { type RawQuery, type SqlInterpolation, type SqlParameter, sql } from './sql.js';
export {
  type AnyStructuredType,
  type InferStructured,
  type StructuredType,
  structured,
} from './structured.js';
/**
 * Element types for {@link structured} ARRAY, OBJECT, and MAP columns. `integer`, `decimal`,
 * `text`, and `boolean` take the same constraint options as the column factories, and `array`,
 * `object`, and `map` nest them.
 *
 * @category Schema
 */
export * as structuredType from './structured-types.js';
