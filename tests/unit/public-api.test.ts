import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import * as core from '../../src/index.js';
import * as snowflake from '../../src/snowflake/index.js';

const names = (...lists: string[]) => lists.join(' ').trim().split(/\s+/).sort();

// Stable names first, then the experimental AST layer (docs/release-contract.md#public-api).
const expected = {
  snowtyped: {
    values: names(
      `add alias and array asc avg binary boolean caseWhen cast coalesce concat count date dateAdd
      dateDiff datePart dateTrunc decimal deleteFrom deleteUsing denseRank desc div eq flatten
      float generateSchema geography geometry gt gte ilike inArray insert insertFrom integer
      introspect isNotNull isNull jsonPath lag lead length like lower lt lte matchRecognize max
      mergeInto min mul ne not object or over rangeBetween rank rowNumber rowPattern rowsBetween
      select snowflakeTable sql sub substring sum text time timeTravel timestamp trim update
      updateFrom upper variant vector`,
      'compileAst identifier quoteIdentifier',
    ),
    types: names(
      `AfterMatch AnyColumn AnyExpression BindValue BoundColumns CaseExpression CastType CastValue
      Column ColumnMap ColumnValue CompiledQuery DataType DatePart DefineContext Expression
      FilteredMutation FlattenOptions FrameBoundary FramedWindowOptions GeoJsonGeometry
      GeoPosition IdentityOptions InferColumn InferExpression InferSelection InsertSource
      InsertValues IntervalUnit IntrospectedColumn IntrospectedTable MatchRecognizeColumns
      MatchRecognizeOptions MatchRowScope MatchVariableScope MeasureContext MergeQuery
      MutationQuery Navigation OffsetWindowOptions OrderedWindowOptions Ordering Predicate
      QuantifiablePattern QuantifierOptions RangeBoundary RawQuery RowPattern RowsPerMatch
      SelectQuery Selection ServerValue ServerValueKind ServerValues SqlInterpolation SqlParameter
      Table TableOptions UpdateValues WindowFrame`,
      `AssignmentNode CteNode DefaultNode DeleteNode DerivedNode EqualityNode ExpressionNode
      FlattenNode FrameBoundaryNode IdentifierNode InsertNode JoinNode MatchRecognizeNode
      MergeBranchNode MergeNode NavigationNode OrderNode PatternNode RelationNode SelectNode
      SemanticsNode SourceReference StarNode StatementNode TableNode TemporalNode UpdateNode
      WindowFrameNode WireType`,
    ),
  },
  'snowtyped/snowflake': {
    values: names('createClient createPool'),
    types: names(
      'ExecuteOptions MutationResult PoolOptions PooledClient QueryResult SnowflakeClient',
    ),
  },
};

const entries = {
  snowtyped: { module: core, file: fileURLToPath(new URL('../../src/index.ts', import.meta.url)) },
  'snowtyped/snowflake': {
    module: snowflake,
    file: fileURLToPath(new URL('../../src/snowflake/index.ts', import.meta.url)),
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
