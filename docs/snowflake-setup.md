# Set up a fresh Snowflake account for integration tests

The test suite uses a dedicated service user, role, database, and X-Small warehouse. Your human login keeps its normal MFA; automated tests use a separate RSA key pair. No password or private key needs to be shared in chat.

## 1. Prepare the local files

From this project directory:

```sh
pnpm snowflake:setup
```

This creates these ignored files:
- `.secrets/snowflake_test_key.p8`: local private key (unencrypted PKCS#8).
- `.secrets/snowflake_test_key.pub`: matching public key.
- `.snowflake/bootstrap.sql`: account setup SQL containing only the public key.
- `.env.integration`: configuration template.

The command preserves an existing complete key pair and environment file. It regenerates the SQL from the public key. Restrict access to `.secrets` on shared machines; Unix file modes do not configure Windows ACLs. You can instead use an encrypted PKCS#8 private key and configure `SNOWFLAKE_PRIVATE_KEY_PASSPHRASE`.

## 2. Run the bootstrap SQL in Snowsight

Sign in to your Snowflake account and open a SQL worksheet (or the SQL editor available in your account). Open `.snowflake/bootstrap.sql` locally, copy its contents into that worksheet, and execute it as `ACCOUNTADMIN`.

It creates:

| Object       | Name                           |
| ------------ | ------------------------------ |
| Database     | `SNOWFLAKE_TYPESAFE_TEST_DB`   |
| Warehouse    | `SNOWFLAKE_TYPESAFE_TEST_WH`   |
| Test role    | `SNOWFLAKE_TYPESAFE_TEST_ROLE` |
| Service user | `SNOWFLAKE_TYPESAFE_TEST_USER` |

The test role receives warehouse usage plus usage and schema creation in this database. Each run owns its newly created schema and fixtures. The service user gets no administrative role. The warehouse starts suspended, resumes on demand, and auto-suspends after 60 seconds of inactivity. Tests use real compute and consume trial credits or billed credits.

The script deliberately uses `CREATE USER` without replacement. If that user already exists, do not replace its key blindly. If you are rerunning after a successful setup, skip the user creation and verify its existing key/role, then run the grant statements as needed. For a shared account, have an administrator adapt the names and permissions to their policies.

## 3. Set the account identifier

In Snowflake's account details, find the client account identifier in the `organization-account` form. Account navigation labels can vary; use the value shown for connecting clients. Edit `.env.integration`:

```dotenv
SNOWFLAKE_ACCOUNT=your-organization-your-account
SNOWFLAKE_USERNAME=SNOWFLAKE_TYPESAFE_TEST_USER
SNOWFLAKE_DATABASE=SNOWFLAKE_TYPESAFE_TEST_DB
SNOWFLAKE_WAREHOUSE=SNOWFLAKE_TYPESAFE_TEST_WH
SNOWFLAKE_ROLE=SNOWFLAKE_TYPESAFE_TEST_ROLE
SNOWFLAKE_PRIVATE_KEY_PATH=.secrets/snowflake_test_key.p8
```

To provide the key directly without a key file at test time, Base64-encode the entire PEM (including its header, footer, and newlines) and replace `SNOWFLAKE_PRIVATE_KEY_PATH` with the resulting single-line value:

```dotenv
SNOWFLAKE_PRIVATE_KEY=<base64-encoded full PEM>
```

The test configuration decodes Base64 before passing the key to the Snowflake SDK. A raw PEM in a quoted multiline value is also accepted. `SNOWFLAKE_PRIVATE_KEY` takes precedence when both key settings are present. For an encrypted PEM, also set `SNOWFLAKE_PRIVATE_KEY_PASSPHRASE` to its existing passphrase; unencrypted keys need no passphrase. Keep private keys in the ignored `.env.integration` file or your secret manager.

The account field takes an account identifier, not a full `https://` URL. Relative key paths are resolved from the project directory. Existing process environment variables take precedence over the same variables in the local file. Other `.env` files are not loaded.

## 4. Run live tests

```sh
pnpm test:integration
```

Each run creates a schema named `SFLIB_TEST_<random UUID>`, seeds three deterministic customers including a 38-digit-capable integer and an exact decimal, executes the library's queries, and drops that schema in teardown. Setup failures after schema creation also attempt cleanup. No existing schema is selected for deletion.

If the process is killed or the network fails during cleanup, a schema can remain. Inspect only schemas with the `SFLIB_TEST_` prefix in the dedicated database and remove known abandoned test schemas manually. There is no automatic sweep of old schemas.

Common failures:
- **Missing integration configuration:** fill the named variables in `.env.integration`.
- **JWT/authentication failure:** verify account identifier, service username, matching public/private key, and system clock.
- **Role or privilege failure:** rerun the relevant grants as an administrator.
- **Warehouse unavailable:** verify the warehouse name and the role's USAGE grant.
- **Network restriction:** check account network policy and client access rules.

## Optional GitHub Actions setup

The live workflow is manually triggered with `workflow_dispatch`; pull requests never receive these credentials. Create a GitHub environment named `snowflake-integration`, optionally restrict allowed branches, then configure:

| Kind             | Name                               | Value                                         |
| ---------------- | ---------------------------------- | --------------------------------------------- |
| Secret           | `SNOWFLAKE_ACCOUNT`                | Client account identifier                     |
| Secret           | `SNOWFLAKE_PRIVATE_KEY`            | Full private-key PEM, including header/footer |
| Secret, optional | `SNOWFLAKE_PRIVATE_KEY_PASSPHRASE` | For an encrypted key                          |
| Variable         | `SNOWFLAKE_USERNAME`               | Test service user                             |
| Variable         | `SNOWFLAKE_DATABASE`               | Dedicated test database                       |
| Variable         | `SNOWFLAKE_WAREHOUSE`              | Test warehouse                                |
| Variable         | `SNOWFLAKE_ROLE`                   | Test role                                     |

Use a separate CI service user/key if the project grows beyond a personal test account. The workflow writes the key to the runner's temporary directory and removes it after the run.

References: [Snowflake key-pair authentication](https://docs.snowflake.com/en/user-guide/key-pair-auth), [Node.js authentication](https://docs.snowflake.com/en/developer-guide/node-js/nodejs-driver-authenticate), [CREATE USER](https://docs.snowflake.com/en/sql-reference/sql/create-user), [warehouse management](https://docs.snowflake.com/en/user-guide/warehouses-overview).
