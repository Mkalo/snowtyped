---
"snowtyped": patch
---

When a transaction's ROLLBACK fails, pools now destroy the connection instead of returning it for reuse, and a single-connection client rejects further operations on it.
