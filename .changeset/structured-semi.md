---
"snowtyped": minor
---

Declare semi-structured ARRAY and OBJECT columns with `array(name, elementSchema?)` and `object(name, schema?)`. Results and writes are validated against the declared schema, writes are cast to the column type (including NULL in multi-row inserts), and code generation emits these declarations while rejecting structured `ARRAY(type)` and `OBJECT(...)` columns.

VARIANT, ARRAY, OBJECT, and `jsonPath()` reads now reject JSON numbers that a JavaScript number cannot hold exactly instead of silently rounding them. SQL NULL array elements, which `TO_JSON` prints as `undefined`, now decode as `null` instead of failing the read.
