---
'snowtyped': patch
---

Honor the UTC offset in `timeTravel(table, { timestamp })`. The selector is now cast to `TIMESTAMP_TZ`, so `'2026-10-22T15:00:00-07:00'` selects that instant instead of being read as 15:00 UTC.

Timestamps without an offset are now read in the session `TIMEZONE` instead of as UTC. Snowflake's default session time zone is `America/Los_Angeles`, so unless your sessions set `TIMEZONE = 'UTC'`, an offset-less string now points several hours later than before (which can fail with "Future data is not yet available" or select a different snapshot). To keep the old meaning, append `Z` or `+00:00` to UTC timestamps.
