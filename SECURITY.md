# Security policy

## Reporting a vulnerability

Report vulnerabilities privately through GitHub:
[Report a vulnerability](https://github.com/Mkalo/snowtyped/security/advisories/new).
Do not open a public issue, pull request, or discussion for an unfixed
vulnerability.

Include the affected version, a minimal reproduction, and the impact you
observed. Never include Snowflake credentials, private keys, or customer data.

The project is maintained by [Mkalo](https://github.com/Mkalo) on a best-effort
basis, without a response-time commitment. Accepted reports are fixed in a new
release and disclosed through a GitHub security advisory.

## Supported versions

Fixes target the latest published release. Before `1.0.0`, that is the latest
alpha or beta; older prereleases are not patched. Fixed versions do not replace
published versions; affected versions may be deprecated on npm.

## Scope

In scope: SQL generation and binding, raw SQL composition, runtime validation,
and the Snowflake client and pool in this package. Vulnerabilities in
snowflake-sdk, Zod, or Snowflake itself should go to those projects; report
here when Snowtyped's use of them is the cause. `sql.unsafe` sends trusted SQL
text as written by design.
