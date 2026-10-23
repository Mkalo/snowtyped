---
'snowtyped': patch
---

Read `float()` columns exactly. Values past 15 significant digits no longer lose precision, and the largest finite DOUBLE no longer decodes to `Infinity`.
