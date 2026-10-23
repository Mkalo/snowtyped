import { describe, expect, it } from 'vitest';
import { defaultIntegrationWorkers, integrationWorkers } from '../support/integration-workers.js';
import { integrationConfig } from '../support/snowflake.js';

const environment = {
  SNOWFLAKE_ACCOUNT: 'organization-account',
  SNOWFLAKE_USERNAME: 'TEST_USER',
  SNOWFLAKE_DATABASE: 'TEST_DB',
  SNOWFLAKE_WAREHOUSE: 'TEST_WH',
  SNOWFLAKE_ROLE: 'TEST_ROLE',
  SNOWFLAKE_PRIVATE_KEY_PATH: '.secrets/test.p8',
};
const privateKey = '-----BEGIN PRIVATE KEY-----\ntest-key\n-----END PRIVATE KEY-----';
const base64PrivateKey = Buffer.from(privateKey, 'utf8').toString('base64');
const directKeyFormats = [
  { format: 'PEM', value: privateKey },
  { format: 'Base64', value: base64PrivateKey },
];

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

  it.each(directKeyFormats)('accepts a $format private key without a key file', ({ value }) => {
    const config = integrationConfig({
      ...environment,
      SNOWFLAKE_PRIVATE_KEY: value,
      SNOWFLAKE_PRIVATE_KEY_PATH: '',
    });
    expect(config).toHaveProperty('privateKey', privateKey);
    expect(config).not.toHaveProperty('privateKeyPath');
  });

  it.each(directKeyFormats)('prefers a direct $format key over a configured path', ({ value }) => {
    const config = integrationConfig({ ...environment, SNOWFLAKE_PRIVATE_KEY: value });
    expect(config).toHaveProperty('privateKey', privateKey);
    expect(config).not.toHaveProperty('privateKeyPath');
  });

  it('rejects an invalid direct key even when a key path is available', () => {
    expect(() =>
      integrationConfig({ ...environment, SNOWFLAKE_PRIVATE_KEY: 'not-a-private-key' }),
    ).toThrow(
      'SNOWFLAKE_PRIVATE_KEY must be a PEM private key or the Base64 encoding of the full PEM.',
    );
  });

  it('falls back to the key path when the direct key is blank', () => {
    expect(integrationConfig({ ...environment, SNOWFLAKE_PRIVATE_KEY: ' \n ' })).toHaveProperty(
      'privateKeyPath',
      environment.SNOWFLAKE_PRIVATE_KEY_PATH,
    );
  });

  it('requires at least one nonblank private key source', () => {
    for (const privateKeyPath of [undefined, '', ' ']) {
      expect(() =>
        integrationConfig({
          ...environment,
          SNOWFLAKE_PRIVATE_KEY: ' \n ',
          SNOWFLAKE_PRIVATE_KEY_PATH: privateKeyPath,
        }),
      ).toThrow('SNOWFLAKE_PRIVATE_KEY or SNOWFLAKE_PRIVATE_KEY_PATH');
    }
  });

  it.each([
    { SNOWFLAKE_PRIVATE_KEY_PATH: environment.SNOWFLAKE_PRIVATE_KEY_PATH },
    { SNOWFLAKE_PRIVATE_KEY: privateKey, SNOWFLAKE_PRIVATE_KEY_PATH: '' },
    { SNOWFLAKE_PRIVATE_KEY: base64PrivateKey, SNOWFLAKE_PRIVATE_KEY_PATH: '' },
  ])('supports an encrypted private key with either source: %o', (keySource) => {
    expect(
      integrationConfig({
        ...environment,
        ...keySource,
        SNOWFLAKE_PRIVATE_KEY_PASSPHRASE: 'example-passphrase',
      }),
    ).toHaveProperty('privateKeyPass', 'example-passphrase');
  });
});

describe('integration worker count', () => {
  it('defaults when unset or blank', () => {
    expect(integrationWorkers({})).toBe(defaultIntegrationWorkers);
    expect(integrationWorkers({ SNOWTYPED_INTEGRATION_WORKERS: ' ' })).toBe(
      defaultIntegrationWorkers,
    );
  });

  it('reads a positive integer', () => {
    expect(integrationWorkers({ SNOWTYPED_INTEGRATION_WORKERS: '1' })).toBe(1);
    expect(integrationWorkers({ SNOWTYPED_INTEGRATION_WORKERS: ' 6 ' })).toBe(6);
  });

  it.each(['0', '-2', '1.5', 'four', '2e'])('rejects %j', (value) => {
    expect(() => integrationWorkers({ SNOWTYPED_INTEGRATION_WORKERS: value })).toThrow(
      'SNOWTYPED_INTEGRATION_WORKERS must be a positive integer',
    );
  });
});
