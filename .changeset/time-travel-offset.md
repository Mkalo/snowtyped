---
'snowtyped': patch
---

Honor the UTC offset in `timeTravel(table, { timestamp })`. The selector is now cast to `TIMESTAMP_TZ`; a timestamp without an offset is read in the session time zone instead of as UTC.
