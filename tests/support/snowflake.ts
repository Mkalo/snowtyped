import { randomUUID } from 'node:crypto';
import type { ConnectionOptions } from 'snowflake-sdk';
import snowflake from 'snowflake-sdk';
import { boolean, decimal, identifier, integer, snowflakeTable, text } from '../../src/index.js';
import { createClient } from '../../src/snowflake/index.js';

export function integrationConfig(environment: NodeJS.ProcessEnv = process.env): ConnectionOptions {
  const required = [
    'SNOWFLAKE_ACCOUNT',
    'SNOWFLAKE_USERNAME',
    'SNOWFLAKE_DATABASE',
    'SNOWFLAKE_WAREHOUSE',
    'SNOWFLAKE_ROLE',
  ] as const;
  let privateKey = environment.SNOWFLAKE_PRIVATE_KEY?.trim();
  if (privateKey && !privateKey.startsWith('-----BEGIN ')) {
    privateKey = Buffer.from(privateKey, 'base64').toString('utf8').trim();
    if (!privateKey.startsWith('-----BEGIN ')) {
      throw new Error(
        'SNOWFLAKE_PRIVATE_KEY must be a PEM private key or the Base64 encoding of the full PEM.',
      );
    }
  }
  const privateKeyPath = environment.SNOWFLAKE_PRIVATE_KEY_PATH?.trim();
  const missing: string[] = required.filter((name) => !environment[name]?.trim());
  if (!privateKey && !privateKeyPath) {
    missing.push('SNOWFLAKE_PRIVATE_KEY or SNOWFLAKE_PRIVATE_KEY_PATH');
  }
  if (missing.length) {
    throw new Error(
      `Missing integration configuration: ${missing.join(', ')}. See docs/snowflake-setup.md.`,
    );
  }
  return {
    account: environment.SNOWFLAKE_ACCOUNT as string,
    username: environment.SNOWFLAKE_USERNAME as string,
    database: environment.SNOWFLAKE_DATABASE as string,
    warehouse: environment.SNOWFLAKE_WAREHOUSE as string,
    role: environment.SNOWFLAKE_ROLE as string,
    ...(privateKey ? { privateKey } : { privateKeyPath: privateKeyPath as string }),
    ...(environment.SNOWFLAKE_PRIVATE_KEY_PASSPHRASE
      ? { privateKeyPass: environment.SNOWFLAKE_PRIVATE_KEY_PASSPHRASE }
      : {}),
    authenticator: 'SNOWFLAKE_JWT',
    clientSessionKeepAlive: false,
    application: 'SNOWTYPED_INTEGRATION',
    clientRequestMFAToken: false,
  };
}

function quoteParts(...parts: [string, ...string[]]): string {
  return identifier(...parts)
    .parts.map((part) => `"${part.replaceAll('"', '""')}"`)
    .join('.');
}

/** One fresh schema per invocation; cleanup only ever targets this generated name. */
export function createFixture(options: ConnectionOptions) {
  const database = options.database;
  if (!database) throw new Error('The test fixture requires an explicit database.');
  const schemaName = `SFLIB_TEST_${randomUUID().replaceAll('-', '').toUpperCase()}`;
  const qualifiedSchema = quoteParts(database, schemaName);
  const connection = snowflake.createConnection(options);
  const table = snowflakeTable(
    'CUSTOMERS',
    {
      id: integer('ID').notNull(),
      name: text('NAME').notNull(),
      email: text('EMAIL'),
      balance: decimal('BALANCE').notNull(),
      active: boolean('ACTIVE').notNull(),
    },
    { database, schema: schemaName },
  );
  const qualifiedTable = quoteParts(database, schemaName, 'CUSTOMERS');
  let connected = false;
  let created = false;

  function execute(sqlText: string): Promise<void> {
    return new Promise((resolve, reject) => {
      connection.execute({ sqlText, complete: (error) => (error ? reject(error) : resolve()) });
    });
  }

  async function cleanup(): Promise<void> {
    try {
      if (created) {
        await execute(`DROP SCHEMA IF EXISTS ${qualifiedSchema} CASCADE`);
        created = false;
      }
    } finally {
      if (connected) {
        await new Promise<void>((resolve, reject) => {
          connection.destroy((error) => (error ? reject(error) : resolve()));
        });
        connected = false;
      }
    }
  }

  return {
    schemaName,
    table,
    client: createClient(connection),
    cleanup,
    async seed() {
      await new Promise<void>((resolve, reject) => {
        connection.connect((error) => (error ? reject(error) : resolve()));
      });
      connected = true;
      try {
        await execute(
          "ALTER SESSION SET STATEMENT_TIMEOUT_IN_SECONDS = 60, QUERY_TAG = 'snowtyped:integration'",
        );
        await execute(`CREATE SCHEMA ${qualifiedSchema}`);
        created = true;
        await execute(`CREATE TABLE ${qualifiedTable} (
          ID NUMBER(38, 0) NOT NULL,
          NAME VARCHAR NOT NULL,
          EMAIL VARCHAR,
          BALANCE NUMBER(38, 4) NOT NULL,
          ACTIVE BOOLEAN NOT NULL
        )`);
        await execute(`INSERT INTO ${qualifiedTable} VALUES
          (9007199254740993, 'Ada', NULL, 12345678901234567890.1234, TRUE),
          (2, 'Grace', 'grace@example.test', -42.5000, FALSE),
          (3, 'Linus', 'linus@example.test', 0.0000, TRUE)`);
      } catch (error) {
        await cleanup();
        throw error;
      }
    },
  };
}
