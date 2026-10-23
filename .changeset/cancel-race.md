---
"snowtyped": patch
---

A `signal` or `timeoutMs` abort that reaches Snowflake before the statement is executing (error `000605`, common on a session's first statement) now retries the cancel instead of rejecting with `Query cancellation failed.` while the statement runs on. When the statement finishes before a cancel takes effect, the request settles with its real result or error, so a caller is never told a committed write failed.
