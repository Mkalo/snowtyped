---
'snowtyped': patch
---

CTE sources (`query.asCte('SRC')`) now work in `mergeInto()`, `updateFrom()`, and `deleteUsing()`. DML has no WITH clause, so the CTE's query is inlined as a derived source instead of referencing an undefined name (MERGE) or being rejected (UPDATE FROM / DELETE USING).
