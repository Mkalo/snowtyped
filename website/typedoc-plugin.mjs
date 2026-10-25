import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Comment, CommentTag, Converter, ReflectionKind } from 'typedoc';

const root = fileURLToPath(new URL('..', import.meta.url));
const names = { index: 'snowtyped', snowflake: 'snowtyped/snowflake', ddl: 'snowtyped/ddl' };

// Exports without an explicit @category tag are categorized by the file that declares them.
const categories = {
  'src/ast.ts': 'AST',
  'src/expressions.ts': 'Expressions',
  'src/functions.ts': 'Functions',
  'src/introspection.ts': 'Introspection',
  'src/match-recognize.ts': 'MATCH_RECOGNIZE',
  'src/mutations.ts': 'Mutations',
  'src/pivot.ts': 'PIVOT and UNPIVOT',
  'src/query.ts': 'Queries',
  'src/relations.ts': 'Relations',
  'src/schema.ts': 'Schema',
  'src/snowflake-syntax.ts': 'FLATTEN',
  'src/spatial.ts': 'Schema',
  'src/sql.ts': 'Raw SQL',
  'src/structured.ts': 'Schema',
  'src/structured-types.ts': 'Schema',
  'src/snowflake/client.ts': 'Clients',
  'src/snowflake/pool.ts': 'Pools',
  'src/snowflake/request.ts': 'Clients',
  'src/ddl/definition.ts': 'Definitions',
  'src/ddl/diff.ts': 'Diffs and drift',
  'src/ddl/inspect.ts': 'Diffs and drift',
  'src/ddl/migrate.ts': 'Migrations',
  'src/ddl/statements.ts': 'Statements',
  'src/ddl/types.ts': 'Physical types',
};

function hasCategory(reflection) {
  const comments = [reflection.comment, ...(reflection.signatures ?? []).map((s) => s.comment)];
  return comments.some((comment) => comment?.blockTags.some((tag) => tag.tag === '@category'));
}

export function load(app) {
  app.converter.on(Converter.EVENT_RESOLVE_BEGIN, (context) => {
    for (const module of context.project.getReflectionsByKind(ReflectionKind.Module)) {
      module.name = names[module.name] ?? module.name;
      for (const child of module.children ?? []) {
        const source = child.sources?.[0]?.fullFileName;
        const file = source && relative(root, source).replaceAll('\\', '/');
        const category = categories[file];
        if (!category || hasCategory(child)) continue;
        child.comment ??= new Comment();
        child.comment.blockTags.push(
          new CommentTag('@category', [{ kind: 'text', text: category }]),
        );
      }
    }
  });
}
