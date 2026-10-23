---
"snowtyped": minor
---

Add `recursiveCte` for typed `WITH RECURSIVE` queries: the anchor defines the row contract, the self-reference is scoped to its recursive branch, nullable widening is declared explicitly, and unsupported Snowflake recursion forms are rejected before execution.
