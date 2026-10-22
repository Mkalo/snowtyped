# Snowtyped: initial plan

Status: 0.1.0-alpha.0 implementation completed, 2026-10-22. README.md and CHANGELOG.md describe the implemented surface and remaining boundaries. The design history below records the original proposals.

## Product direction

Build a TypeScript library for developers who want to compose Snowflake queries in TypeScript and infer their results without manually supplying result interfaces.

Confirmed preference: a fluent query builder, similar to Drizzle or Kysely.

Confirmed requirement: own the query AST and its type semantics so Snowflake operations can be modeled directly. The user has already evaluated Drizzle and Kysely dialects and found their AST extension boundaries unsuitable for this goal.

Confirmed implementation direction: pnpm; ESM/CJS packaging and tree shaking; execution over snowflake-sdk; mandatory Drizzle-style schema declarations. The library derives result types and compiled Zod 4 runtime validation from those declarations. There is no user-supplied decoder API. Real Snowflake tests use an isolated seeded schema in a dedicated database.

Raw tagged queries are an explicit additional API: db.queryRaw<ReturnType> and reusable sql<ReturnType> fragments use caller-supplied result assertions and default to unknown. They do not derive runtime validation from a TypeScript generic.

Scaffold baseline: Node.js 22.18+ / 24.11+. Working product assumptions: existing Snowflake databases and analytics reads as the first use case. Validate the workload before committing to the first release scope.

The core promise is that supported query operations check table and column references, parameter types, and result types against a declared or generated schema. Runtime decoding must produce values that match those types. Compile-time checking cannot guarantee permissions, current database availability, or absence of schema drift.

## Existing options and opportunity

Snowflake provides a [Node.js driver](https://docs.snowflake.com/en/developer-guide/node-js/nodejs-driver), which supplies the transport layer we can reuse.

There is already a [community Snowflake dialect for Kysely](https://github.com/dsauerbrun/snowflake-kysely-dialect), and an [upstream dialect request](https://github.com/kysely-org/kysely/issues/1686). These establish prior art, but this initial research does not establish their production readiness or complete feature coverage.

Positioning hypothesis: represent Snowflake operations directly, with query composition, schema discovery, and value handling working together reliably. Existing dialects are prior art; they are not the proposed foundation.

## Architecture direction

Build an independent Snowflake query builder with an owned AST, type system, and SQL compiler. Reuse the official driver for transport.

Kysely supports [custom expressions and raw builders](https://www.kysely.dev/docs/recipes/extending-kysely). Emitting a SQL fragment is a different capability from adding a query operation with its own scope, legality checks, and inferred output. The latter is the requirement here. Do not repeat the dialect feasibility investigation unless the user requests it.

Keep schema metadata, query construction and inference, AST validation, SQL compilation, execution, and value decoding as separate responsibilities. Use the official SDK for the first execution adapter; defer an HTTP SQL API adapter until there is demonstrated demand.

### AST and type semantics

The fluent API constructs immutable AST values; it does not concatenate SQL strings. A compiler traverses the AST to produce SQL and ordered bindings. A SQL parser is unnecessary for this initial construction path.

Model distinct categories for scalar expressions, relation sources, query clauses, and statements. Each operation must specify its inputs, scope rules, output schema or value type, nullability, and SQL generation. Track SQL type information as well as the decoded TypeScript representation: two different SQL types can share the same TypeScript representation without supporting the same operations.

| Construct       | Proposed model                                    | Typing responsibility                                                                                                     |
| --------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| QUALIFY         | SELECT clause containing a predicate              | Resolve legal source/projection references and window expressions; require a window function where Snowflake requires one |
| LATERAL FLATTEN | Correlated relation source                        | Allow references to preceding sources and expose FLATTEN output columns; preserve unknown payload types unless validated  |
| ASOF JOIN       | Distinct join node with MATCH_CONDITION           | Restrict match predicates and account for nullable unmatched right-side columns                                           |
| AT / BEFORE     | Modifier on an eligible relation source           | Validate the selected time-travel selector and its expression                                                             |
| MATCH_RECOGNIZE | Relation transformation with its own substructure | Derive the output scope from measures, partition expressions, and rows-per-match mode                                     |

These are examples from [Snowflake query syntax](https://docs.snowflake.com/en/sql-reference/constructs), not a promise to implement every construct in the alpha. See [FLATTEN](https://docs.snowflake.com/en/sql-reference/functions/flatten), [ASOF JOIN](https://docs.snowflake.com/en/sql-reference/constructs/asof-join), and [MATCH_RECOGNIZE](https://docs.snowflake.com/en/sql-reference/constructs/match_recognize) for their specific semantics.

AST ownership is required; a public third-party AST plugin protocol is an open, separate decision. Start with explicit node definitions and exhaustive compiler handling. Do not replace semantic nodes with an arbitrary keyword or fragment node as the primary extension mechanism.

## Illustrative API

This is a design sketch, not an implemented API. Its familiar chaining syntax does not imply using Kysely internally. Assume `db` has a schema describing `CUSTOMERS`, with `ID` decoded as `bigint` and nullable `EMAIL` decoded as `string | null`.

```ts
const customers = await db
  .selectFrom('CUSTOMERS')
  .select(['ID', 'EMAIL'])
  .where('ACTIVE', '=', true)
  .limit(100)
  .execute();

// Inferred: Array<{ ID: bigint; EMAIL: string | null }>

// Compile-time failures:
db.selectFrom('CUSTOMERS').select('EMIAL');
db.selectFrom('CUSTOMERS').where('ACTIVE', '=', 'yes');
```

Also prototype a Drizzle-style table-object API before selecting the public syntax. The public API is independent of the internal AST representation.

## Type and runtime contracts

- Schema: start with explicit declarations; support introspection that generates reviewable declarations from an existing database. Record physical database, schema, table, and column names separately from any TypeScript property aliases.
- Nullability: preserve nullable columns and introduce nullability for outer joins. Require explicit handling for nullable expressions.
- Numbers: propose `bigint` for integral fixed-point values and exact decimal strings for scaled values, with opt-in codecs later. Driver options and decoding must enforce the selected policy, including expression results.
- Time: preserve DATE, TIME, TIMESTAMP_NTZ, TIMESTAMP_LTZ, and TIMESTAMP_TZ semantics. Decide string or dedicated value representations before shipping; do not assume every value can be represented faithfully by JavaScript Date.
- Semi-structured values: default unstructured VARIANT payloads to `unknown`. A supplied TypeScript interface alone does not validate their shape; typed refinement requires runtime validation. Treat structured Snowflake types separately.
- Identifiers: preserve exact physical names and quote each qualified component. Do not silently uppercase or lowercase identifiers. Snowflake resolves unquoted identifiers to uppercase and preserves case in quoted identifiers; see [identifier rules](https://docs.snowflake.com/en/sql-reference/identifiers-syntax).
- Parameters: compile values to SDK bindings and keep identifier construction separate. Raw SQL must expose its weaker guarantees explicitly; a caller-supplied result generic is an assertion.

These policies matter because the SDK has configurable numeric and date conversions, and duplicate result column names need deliberate handling. See [result consumption and data mappings](https://docs.snowflake.com/en/developer-guide/node-js/nodejs-driver-consume).

## Delivery sequence

1. **Design proof:** choose a small representative schema and queries. Build a vertical slice from typed construction through AST and SQL compilation to decoded results. Include window expressions with QUALIFY and correlated LATERAL FLATTEN to prove clause and relation extension, alongside projections, aliases, parameter checks, exact numeric decoding, and qualified identifiers. Deliver an architecture decision and executable proof.
2. **Read-focused alpha:** stabilize the demonstrated Snowflake operations plus SELECT, WHERE, ORDER BY, LIMIT, inner and left joins, basic aggregates and GROUP BY; schema declarations; bound parameters; promise execution; streaming; query IDs; cancellation; connection cleanup; explicit raw SQL escape hatch. Confirm each promised construct has coherent inference and decoding.
3. **Snowflake depth and adoption:** schema introspection, generated declarations and drift checks; CTEs, broader window support, ASOF JOIN, time travel, and additional semi-structured operations. Prioritize MATCH_RECOGNIZE, writes, and MERGE from real use cases.

Defer migrations, entity tracking, relation loading, universal database support, and browser execution for the initial release.

## Release evidence

- Compile-time fixtures accept valid queries, reject unknown columns and invalid comparisons, and verify exact projection and outer-join result types.
- Compiler tests verify SQL and bind arrays, escaping, aliases, qualification, and repeated composition.
- Snowflake-specific fixtures verify scope and result inference for QUALIFY and correlated FLATTEN. Unsupported operations fail explicitly; they never silently degrade to an asserted output type.
- Opt-in integration tests against Snowflake verify runtime types, numeric precision, time semantics, duplicate output names, streaming cleanup, and cancellation. No credentials or database access are assumed for planning.
- Measure compiler and editor behavior on a representative large schema before promising broad scale.

## Open decisions

1. Which first users and queries should define success: analytical reads, application CRUD, or ingestion and transformations?
2. Should the public API use string references, table objects, or both?
3. How should future Snowflake introspection or dbt tooling generate the required TypeScript schema declarations?
4. Should a future public extension protocol allow third parties to register nodes, or is extending the library's own AST sufficient?

Next planning deliverable: write a small schema and five realistic query examples, including Snowflake operations, then specify their AST shapes and inference rules before implementing the builder.
