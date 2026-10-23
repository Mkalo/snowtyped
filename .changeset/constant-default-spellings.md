---
"snowtyped": patch
---

`diffSchema`, `checkDrift`, and `pushSchema` now recognize every constant default spelling Snowflake accepts when adding a column to an existing table: numbers such as `.5`, `-.25`, and `5.`, strings with backslash escapes such as `'it\'s'`, and dollar-quoted strings such as `$$it's$$`. These columns used to be listed under `unsupported`; they are now added with `ADD COLUMN` and compared by value against the stored default.
