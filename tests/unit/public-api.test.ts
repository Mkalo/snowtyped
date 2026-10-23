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
      `alias and asc binary boolean count date decimal deleteFrom desc eq flatten float
      generateSchema gt gte ilike inArray insert integer introspect isNotNull isNull jsonPath like
      lower lt lte max mergeInto min ne not or over rowNumber select snowflakeTable sql sum text
      time timestamp timeTravel update upper variant`,
      'compileAst identifier quoteIdentifier',
    ),
    types: names(
      `AnyColumn AnyExpression BindValue BoundColumns Column ColumnMap ColumnValue CompiledQuery
      DataType Expression FilteredMutation FlattenOptions InferColumn InferExpression InferSelection
      InsertValues IntrospectedColumn IntrospectedTable MergeQuery MutationQuery Ordering Predicate
      RawQuery SelectQuery Selection SqlInterpolation SqlParameter Table TableOptions UpdateValues`,
      `CteNode DeleteNode DerivedNode EqualityNode ExpressionNode FlattenNode IdentifierNode
      InsertNode JoinNode MergeNode OrderNode RelationNode SelectNode SourceReference StatementNode
      TableNode TemporalNode UpdateNode WireType`,
    ),
  },
  'snowtyped/snowflake': {
    values: names('createClient createPool'),
    types: names(
      'ExecuteOptions MutationResult PooledClient PoolOptions QueryResult SnowflakeClient',
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
