---
"snowtyped": minor
---

Declare structured `ARRAY(type)`, `OBJECT(...)`, and `MAP(key, value)` columns with `structured(name, type)` and `structuredType` descriptors. NUMBER elements decode exactly, SQL NULL elements decode as `null`, OBJECT values require exactly the declared fields, MAP values are `Map`s, writes cast to the declared type, and code generation reads exact field names from `SHOW COLUMNS`.
