---
'snowtyped': patch
---

`mergeInto()` with a CTE source (`query.asCte('SRC')`) now compiles the CTE's query as a derived `USING` source instead of referencing an undefined name.
