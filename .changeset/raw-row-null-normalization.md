---
"snowtyped": patch
---

Raw query rows now treat SQL NULL correctly when a result repeats a column name. The type of the last column with that name decides, matching the SDK's object rows. NULL normalization for `queryRaw` and `streamRaw` rows also costs the same per row whatever the column count (it used to grow quadratically), and typed rows are built with less allocation.
