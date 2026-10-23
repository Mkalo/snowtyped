import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import * as ddl from '../../src/ddl/index.js';
import * as core from '../../src/index.js';
import * as snowflake from '../../src/snowflake/index.js';

const names = (...lists: string[]) => lists.join(' ').trim().split(/\s+/).sort();

// Stable names first, then the experimental AST layer (docs/release-contract.md#public-api).
const expected = {
  snowtyped: {
    values: names(
      `add alias and array asc avg binary boolean caseWhen cast coalesce concat count date dateAdd
      dateDiff datePart dateTrunc decimal deleteFrom deleteUsing denseRank desc div dynamicPivot eq
      exists flatten float generateSchema geography geometry gt gte ilike inArray insert insertFrom
      inSubquery integer introspect isNotNull isNull jsonPath lag lead length like lower lt lte
      matchRecognize max mergeInto min mul ne not notExists object or over pivot rangeBetween rank
      recursiveCte rowNumber rowPattern rowsBetween scalar select snowflakeTable sql structured
      structuredType sub substring sum text time timestamp timeTravel trim unpivot update updateFrom
      upper variant vector`,
      'compileAst identifier quoteIdentifier',
    ),
    types: names(
      `AfterMatch AnyColumn AnyExpression AnyStructuredType BindValue BoundColumns CaseExpression
      CastType CastValue Column ColumnMap ColumnValue CompatibleOperand CompiledQuery DataType
      DatePart DefineContext Expression FilteredMutation FlattenOptions FrameBoundary
      FramedWindowOptions GeoJsonGeometry GeoPosition IdentityOptions InferColumn InferExpression
      InferSelection InferStructured InsertSource InsertValues IntersectRow IntervalUnit
      IntrospectedColumn IntrospectedTable MatchRecognizeColumns MatchRecognizeOptions MatchRowScope
      MatchVariableScope MeasureContext MergeQuery MutationQuery Navigation OffsetWindowOptions
      OperandRow OrderedWindowOptions Ordering PivotAggregate PivotColumns PivotOptions PivotValue
      Predicate QuantifiablePattern QuantifierOptions RangeBoundary RawQuery RecursiveName
      RecursiveOperand RecursiveRow RowPattern RowsPerMatch Selection SelectQuery ServerValue
      ServerValueKind ServerValues SetColumns SetOperand SetOperator SetQuery SetScope
      SqlInterpolation SqlParameter StructuredType Table TableOptions UnionRow UnpivotColumns
      UnpivotOptions UpdateValues WindowFrame`,
      `AssignmentNode CteNode DefaultNode DeleteNode DerivedNode EqualityNode ExistsNode
      ExpressionNode FlattenNode FrameBoundaryNode IdentifierNode InsertNode InSubqueryNode JoinNode
      MatchRecognizeNode MergeBranchNode MergeNode NavigationNode OrderNode PatternNode PivotLiteral
      PivotNode QueryNode RelationNode SelectNode SelfReferenceNode SemanticsNode SetOperationNode
      SourceReference StarNode StatementNode SubqueryNode TableNode TemporalNode UnpivotNode
      UpdateNode WindowFrameNode WireType`,
    ),
  },
  'snowtyped/snowflake': {
    values: names('createClient createPool'),
    types: names(
      'ExecuteOptions MutationResult PoolOptions PooledClient QueryResult SnowflakeClient',
    ),
  },
  'snowtyped/ddl': {
    values: names(
      `alterTable checkDrift compileDdl createSchema createTable defineSchema defineTable
      diffSchema dropSchema dropTable inspectSchema MigrationError migrate migrationStatus
      pushSchema setSchemaComment sqlType`,
    ),
    types: names(
      `AlterTable ColumnDefinition ColumnDefinitionNode ColumnOptions DdlNode DdlStatement
      DiffOptions DriftOptions IncompleteMigration MigrateOptions MigrateResult Migration
      MigrationErrorCode MigrationStatus MigrationTarget ObservedColumn ObservedSchema
      ObservedTable ObservedType PhysicalType SchemaChange SchemaDefinition SchemaDiff
      TableDefinition TableDefinitionOptions UnmodeledType UnsupportedChange`,
    ),
  },
};

const entries = {
  snowtyped: { module: core, file: fileURLToPath(new URL('../../src/index.ts', import.meta.url)) },
  'snowtyped/snowflake': {
    module: snowflake,
    file: fileURLToPath(new URL('../../src/snowflake/index.ts', import.meta.url)),
  },
  'snowtyped/ddl': {
    module: ddl,
    file: fileURLToPath(new URL('../../src/ddl/index.ts', import.meta.url)),
  },
};
const program = ts.createProgram(
  Object.values(entries).map(({ file }) => file),
  {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    noEmit: true,
  },
);
const checker = program.getTypeChecker();

function declaredExports(file: string) {
  const source = program.getSourceFile(file);
  const symbol = source && checker.getSymbolAtLocation(source);
  if (!symbol) throw new Error(`Cannot read exports of ${file}.`);
  const values: string[] = [];
  const types: string[] = [];
  for (const exported of checker.getExportsOfModule(symbol)) {
    const target =
      exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
    (target.flags & ts.SymbolFlags.Value ? values : types).push(exported.name);
  }
  return { values: values.sort(), types: types.sort() };
}

describe('public API', () => {
  it('matches the reviewed export snapshot of each entry point', () => {
    for (const [name, { file }] of Object.entries(entries)) {
      expect(declaredExports(file), name).toEqual(expected[name as keyof typeof expected]);
    }
  });

  it('exposes exactly the declared runtime values', () => {
    for (const [name, { module }] of Object.entries(entries)) {
      expect(Object.keys(module).sort(), name).toEqual(
        expected[name as keyof typeof expected].values,
      );
    }
  });
});
