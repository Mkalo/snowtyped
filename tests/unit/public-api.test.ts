import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import * as ddl from '../../src/ddl/index.js';
import * as core from '../../src/index.js';
import * as snowflake from '../../src/snowflake/index.js';

const names = (...lists: string[]) => lists.join(' ').trim().split(/\s+/).sort();

// Stable names first, then the experimental AST layer (docs/release-contract.md#public-api).
// Type names besides `Snowtyped` are deprecated aliases of its members; add new types only to it.
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
      upper variant vector many one withRelations`,
      'compileAst identifier quoteIdentifier',
    ),
    types: names(
      `AfterMatch AnyColumn AnyExpression AnyStructuredType BindValue BoundColumns CaseExpression
      CastType CastValue Column ColumnMap ColumnValue CompatibleOperand CompiledQuery DataType
      DatePart DefineContext Expression FilteredMutation FlattenOptions FrameBoundary
      FramedWindowOptions GeoJsonGeometry GeoPosition IdentityOptions InferColumn InferExpression
      InferSelection InferStructured InsertSource InsertValues IntersectRow IntervalUnit Snowtyped
      IntrospectedColumn IntrospectedTable MatchRecognizeColumns MatchRecognizeOptions MatchRowScope
      MatchVariableScope MeasureContext MergeQuery MutationQuery Navigation OffsetWindowOptions
      OperandRow OrderedWindowOptions Ordering PivotAggregate PivotColumns PivotOptions PivotValue
      Predicate Projection QuantifiablePattern QuantifierOptions RangeBoundary RawQuery RecursiveName
      RecursiveOperand RecursiveRow RowPattern RowsPerMatch Selection SelectQuery ServerValue
      ServerValueKind ServerValues SetColumns SetOperand SetOperator SetQuery SetScope
      SqlInterpolation SqlParameter StructuredType Table TableOptions UnionRow UnpivotColumns
      UnpivotOptions UpdateValues WindowFrame LoadedQuery LoadedRow LoadOptions Relation
      RelationCardinality RelationKeyType RelationRow`,
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
      'ExecuteOptions LoadedResult MutationResult PoolOptions PooledClient QueryResult SnowflakeClient',
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
// Types added after 1.0 that only the namespace exports.
const namespaceOnly = 'InferInsert InferRow InferUpdate';

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
    const typeOnly = exported.declarations?.some(
      (declaration) => ts.isNamespaceExport(declaration) && declaration.parent.isTypeOnly,
    );
    (target.flags & ts.SymbolFlags.Value && !typeOnly ? values : types).push(exported.name);
  }
  return { values: values.sort(), types: types.sort() };
}

/** Source text without formatting: whitespace and trailing separators. */
const normalize = (text: string) => text.replace(/\s+/g, '').replace(/[;,](?=[}>])/g, '');

function exportedSymbol(file: string, name: string): ts.Symbol {
  const source = program.getSourceFile(file);
  const module = source && checker.getSymbolAtLocation(source);
  const exported = module && checker.tryGetMemberInModuleExports(name, module);
  if (!exported) throw new Error(`${file} does not export ${name}.`);
  return exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
}

function namespaceMembers(): ts.Symbol[] {
  const members = checker.getExportsOfModule(exportedSymbol(entries.snowtyped.file, 'Snowtyped'));
  return members
    .map((member) => checker.getAliasedSymbol(member))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
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

  it('exports every type under the Snowtyped namespace', () => {
    const flat = Object.values(expected).flatMap(({ types }) => types);
    expect(namespaceMembers().map(({ name }) => name)).toEqual(
      names(...flat.filter((name) => name !== 'Snowtyped'), namespaceOnly),
    );
  });

  it('keeps each other type export as a deprecated alias of the namespace member', () => {
    const members = new Map(namespaceMembers().map((member) => [member.name, member]));
    const problems = Object.values(entries).flatMap(({ file }) =>
      declaredExports(file).types.flatMap((name) => {
        if (name === 'Snowtyped') return [];
        const declaration = exportedSymbol(file, name).declarations?.[0];
        const original = members.get(name)?.declarations?.[0];
        if (!declaration || !ts.isTypeAliasDeclaration(declaration))
          return [`${name} is not a type alias`];
        const parameters = (node: ts.Declaration) =>
          ts
            .getEffectiveTypeParameterDeclarations(node as ts.DeclarationWithTypeParameters)
            .map((parameter) => normalize(parameter.getText().replaceAll('Snowtyped.', '')));
        const target = `Snowtyped.${name}${
          declaration.typeParameters
            ? `<${declaration.typeParameters.map((p) => p.name.text).join(', ')}>`
            : ''
        }`;
        const deprecated = ts
          .getJSDocTags(declaration)
          .some(
            (tag) =>
              tag.tagName.text === 'deprecated' &&
              ts.getTextOfJSDocComment(tag.comment) === `Use \`Snowtyped.${name}\`.`,
          );
        return [
          ...(original &&
          JSON.stringify(parameters(declaration)) === JSON.stringify(parameters(original))
            ? []
            : [`${name} has different type parameters`]),
          ...(normalize(declaration.type.getText()) === normalize(target)
            ? []
            : [`${name} is not ${target}`]),
          ...(deprecated ? [] : [`${name} is not deprecated`]),
        ];
      }),
    );
    expect(problems).toEqual([]);
  });
});
