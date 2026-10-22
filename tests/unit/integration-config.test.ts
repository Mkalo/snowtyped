import { describe, expect, it } from 'vitest';
import { integrationConfig } from '../support/snowflake.js';

const environment = {
  SNOWFLAKE_ACCOUNT: 'organization-account',
  SNOWFLAKE_USERNAME: 'TEST_USER',
  SNOWFLAKE_DATABASE: 'TEST_DB',
  SNOWFLAKE_WAREHOUSE: 'TEST_WH',
  SNOWFLAKE_ROLE: 'TEST_ROLE',
  SNOWFLAKE_PRIVATE_KEY_PATH: '.secrets/test.p8',
};

describe('integration configuration', () => {
  it('fails explicitly when live test configuration is missing', () => {
    expect(() => integrationConfig({})).toThrow('Missing integration configuration');
    expect(() => integrationConfig({ ...environment, SNOWFLAKE_ACCOUNT: ' ' })).toThrow(
      'SNOWFLAKE_ACCOUNT',
    );
  });

  it('uses noninteractive key-pair authentication with no keepalive', () => {
    expect(integrationConfig(environment)).toMatchObject({
      account: 'organization-account',
      authenticator: 'SNOWFLAKE_JWT',
      clientSessionKeepAlive: false,
      privateKeyPath: '.secrets/test.p8',
    });
    expect(integrationConfig(environment)).not.toHaveProperty('privateKeyPass');
  });

  it('supports an encrypted private key', () => {
    expect(
      integrationConfig({ ...environment, SNOWFLAKE_PRIVATE_KEY_PASSPHRASE: 'example-passphrase' }),
    ).toHaveProperty('privateKeyPass', 'example-passphrase');
  });
});
