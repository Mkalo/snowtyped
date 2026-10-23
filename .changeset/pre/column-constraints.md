---
"snowtyped": minor
---

Declare NUMBER precision/scale, VARCHAR and BINARY length, and TIME/TIMESTAMP fractional precision on columns. Writes and decoded results that do not fit are rejected instead of being silently rounded or truncated, and introspection generates the matching declarations.
