---
"snowtyped": minor
---

Add `.serverDefault()`, `.identity()`, and `.virtual()` column metadata, carried through introspection and code generation. Inserts now omit unspecified columns so Snowflake applies their defaults instead of NULL, mixed row shapes compile to a single `INSERT ALL`, and writes to virtual columns are rejected.
