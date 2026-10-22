import { generateKeyPairSync } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Generates local files only. The user runs the SQL in their new account's worksheet.
const secrets = resolve('.secrets');
const privateKeyPath = resolve(secrets, 'snowflake_test_key.p8');
const publicKeyPath = resolve(secrets, 'snowflake_test_key.pub');
await mkdir(secrets, { recursive: true });

if (!existsSync(privateKeyPath) && !existsSync(publicKeyPath)) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  await writeFile(privateKeyPath, privateKey, { flag: 'wx', mode: 0o600 });
  await writeFile(publicKeyPath, publicKey, { flag: 'wx', mode: 0o600 });
} else if (!existsSync(privateKeyPath) || !existsSync(publicKeyPath)) {
  throw new Error(
    'Incomplete local key pair. Restore the matching key files before running setup.',
  );
}

const publicKey = (await readFile(publicKeyPath, 'utf8'))
  .replace(/-----[^-]+-----/g, '')
  .replace(/\s/g, '');
const sql = `-- Run once in a Snowflake SQL worksheet as your account administrator.
-- All object names below are dedicated to this project's integration tests.
USE ROLE ACCOUNTADMIN;

CREATE ROLE IF NOT EXISTS SNOWFLAKE_TYPESAFE_TEST_ROLE;
CREATE DATABASE IF NOT EXISTS SNOWFLAKE_TYPESAFE_TEST_DB;
CREATE WAREHOUSE IF NOT EXISTS SNOWFLAKE_TYPESAFE_TEST_WH
  WAREHOUSE_SIZE = 'XSMALL'
  AUTO_SUSPEND = 60
  AUTO_RESUME = TRUE
  INITIALLY_SUSPENDED = TRUE;

GRANT USAGE ON WAREHOUSE SNOWFLAKE_TYPESAFE_TEST_WH TO ROLE SNOWFLAKE_TYPESAFE_TEST_ROLE;
GRANT USAGE, CREATE SCHEMA ON DATABASE SNOWFLAKE_TYPESAFE_TEST_DB TO ROLE SNOWFLAKE_TYPESAFE_TEST_ROLE;

-- Deliberately no OR REPLACE: never overwrite an existing user's credentials.
CREATE USER SNOWFLAKE_TYPESAFE_TEST_USER
  TYPE = SERVICE
  DEFAULT_ROLE = SNOWFLAKE_TYPESAFE_TEST_ROLE
  DEFAULT_WAREHOUSE = SNOWFLAKE_TYPESAFE_TEST_WH
  RSA_PUBLIC_KEY = '${publicKey}';
GRANT ROLE SNOWFLAKE_TYPESAFE_TEST_ROLE TO USER SNOWFLAKE_TYPESAFE_TEST_USER;
`;
await writeFile(resolve('.snowflake/bootstrap.sql'), sql).catch(async (error) => {
  if (error.code !== 'ENOENT') throw error;
  await mkdir('.snowflake', { recursive: true });
  await writeFile(resolve('.snowflake/bootstrap.sql'), sql);
});
if (!existsSync('.env.integration')) {
  const template = await readFile('.env.integration.example', 'utf8');
  await writeFile('.env.integration', template, { flag: 'wx', mode: 0o600 });
}
console.log('Prepared .snowflake/bootstrap.sql and .env.integration.');
console.log('Run the SQL in Snowsight, then set SNOWFLAKE_ACCOUNT in .env.integration.');
console.log('Private keys remain in .secrets/; do not paste them into chat or commit them.');
