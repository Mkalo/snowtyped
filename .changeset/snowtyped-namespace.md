---
'snowtyped': minor
---

Export every public type under the type-only `Snowtyped` namespace: `import type { Snowtyped } from 'snowtyped'`, then `Snowtyped.InferRow<typeof query>`, `Snowtyped.Table`, `Snowtyped.SnowflakeClient`, or `Snowtyped.Migration`. It covers the types of `snowtyped`, `snowtyped/snowflake`, and `snowtyped/ddl`.

The individual type exports still work but are deprecated, so editors strike them through; they will be removed in 2.0. To migrate, replace `import { type InferSelection } from 'snowtyped'` with `import { type Snowtyped } from 'snowtyped'` and write `Snowtyped.InferSelection`. Runtime exports are unchanged.
