---
"snowtyped": patch
---

Fix inserts that write NULL to VARIANT or BINARY columns. NULL is now wrapped like non-null values (`PARSE_JSON(?)`, `TO_BINARY(?, 'HEX')`), so single-row and multi-row inserts no longer fail with VARCHAR type mismatches.
