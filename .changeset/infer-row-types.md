---
'snowtyped': minor
---

Add `Snowtyped.InferRow`, `Snowtyped.InferInsert`, and `Snowtyped.InferUpdate` helper types. `Snowtyped.InferRow<typeof query>` is the row type of a SELECT, set operation, query with relations, or table without executing it, including outer-join nullability. `Snowtyped.InferInsert<typeof table>` and `Snowtyped.InferUpdate<typeof table>` are the values `insert()` and `update()` accept.
