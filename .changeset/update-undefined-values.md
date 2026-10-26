---
'snowtyped': patch
---

`update()`, `updateFrom()`, and MERGE `whenMatchedUpdate()` now leave out keys whose value is `undefined`, as `insert()` already did, instead of throwing a `ZodError`. A patch whose values are all `undefined` is rejected with `A mutation needs at least one column value.`
