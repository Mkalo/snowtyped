---
"snowtyped": minor
---

Add `insertFrom`, `updateFrom`, and `deleteUsing` for typed INSERT … SELECT, UPDATE … FROM, and DELETE … USING mutations; the sourced UPDATE and DELETE forms require a join predicate. MERGE now accepts ordered conditional branches through an optional condition on `whenMatchedUpdate`, `whenMatchedDelete`, and `whenNotMatchedInsert`, rejects unreachable branches, and limits NOT MATCHED values and conditions to the source scope.
