---
"snowtyped": minor
---

Add nested object projections. Plain objects in `select` and `.select()` projections decode into nested result objects with schema-derived types and validation, and an object over an outer-joined source becomes `null` when its NOT NULL keys show the joined row is absent.
