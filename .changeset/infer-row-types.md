---
'snowtyped': minor
---

Add `InferRow`, `InferInsert`, and `InferUpdate` helper types. `InferRow<typeof query>` is the row type of a SELECT, set operation, query with relations, or table without executing it, including outer-join nullability. `InferInsert<typeof table>` and `InferUpdate<typeof table>` are the values `insert()` and `update()` accept.
