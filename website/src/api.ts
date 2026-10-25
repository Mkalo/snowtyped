// TypeDoc settings shared by the API reference build and the tests that check its coverage.
export const apiEntryPoints = [
  '../src/index.ts',
  '../src/snowflake/index.ts',
  '../src/ddl/index.ts',
];
export const apiTsconfig = '../tsconfig.build.json';

export const apiTypeDocOptions = {
  excludePrivate: true,
  excludeProtected: true,
  excludeInternal: true,
  excludeExternals: true,
  categorizeByGroup: false,
  categoryOrder: [
    'Schema',
    'Queries',
    'Expressions',
    'Functions',
    'Aggregates',
    'Windows',
    'Relations',
    'Mutations',
    'Raw SQL',
    'Clients',
    'Pools',
    'Definitions',
    'Statements',
    'Physical types',
    'Diffs and drift',
    'Migrations',
    'Types',
    '*',
    'AST',
  ],
  plugin: ['./typedoc-plugin.mjs'],
};
