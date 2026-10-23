---
"snowtyped": patch
---

Pooled requests stop waiting for a connection when their `signal` aborts or `timeoutMs` elapses, connections whose Snowflake session terminated are destroyed instead of reused, and concurrent `close()` calls wait for the same drain.
