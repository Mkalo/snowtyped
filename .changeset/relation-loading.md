---
"snowtyped": minor
---

Add relation loading. `one` and `many` declare related tables by key, and `withRelations` loads them with one parent query plus one query per relation and batch of parent keys, keeping parent pagination, exact wire types, streaming batches, and transactions. `db.execute()` reports every statement's ID in `queryIds`.
