---
"snowtyped": minor
---

Buffered `queryRaw` now accepts `{ signal, timeoutMs }` for reusable `sql` queries, matching `execute`, `stream`, and `streamRaw` cancellation on single-connection and pooled clients.
