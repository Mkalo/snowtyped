# Changelog

## 0.1.0-alpha.1

### Patch Changes

- 38bfb9e: License Snowtyped under MIT, include the license in installed packages, and
  prepare public alpha/beta releases with reviewed npm staging and provenance.

## 0.1.0-alpha.0 — 2026-10-22

- Added schema-derived TypeScript inference and compiled Zod 4 validation.
- Added typed expressions, aliases, inner/outer/cross joins, grouping, aggregates, ordering, pagination, derived tables, and CTEs.
- Added window expressions, QUALIFY, correlated FLATTEN, ASOF JOIN, and time-travel source modifiers.
- Added INSERT, UPDATE, DELETE, and MERGE.
- Added parameterized raw tags with query-time result assertions and unknown defaults.
- Added SDK execution, validated streams, raw streams, AbortSignal/deadline cancellation, transactions, and connection pooling.
- Added exact numeric and temporal wire serialization, binary/VARIANT schemas, database introspection, and declaration generation.
- Added dual ESM/CJS distributions, declaration and tarball checks, tree-shaking checks, and seeded Snowflake integration tests.

This alpha remains private while licensing and API review are finalized. Unmodeled Snowflake syntax is available through raw SQL; this release does not promise exhaustive typed coverage of Snowflake's grammar.
