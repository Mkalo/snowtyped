import type { Connection, SnowflakeError, StatementOption } from 'snowflake-sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const driver = vi.hoisted(() => ({ createConnection: vi.fn() }));
vi.mock('snowflake-sdk', () => ({ default: driver }));

import { createFixture } from '../support/snowflake.js';

function fakeConnection(failures: { connect?: Error; statement?: string; destroy?: Error } = {}) {
  const statements: string[] = [];
  const connection = {
    connect: vi.fn((callback: (error?: Error) => void) => callback(failures.connect)),
    destroy: vi.fn((callback: (error?: Error) => void) => callback(failures.destroy)),
    execute: vi.fn((options: StatementOption) => {
      statements.push(options.sqlText);
      const error =
        failures.statement && options.sqlText.startsWith(failures.statement)
          ? new Error('fixture SQL failed')
          : undefined;
      options.complete?.(
        error as SnowflakeError | undefined,
        {} as ReturnType<Connection['execute']>,
        [],
      );
      return {} as ReturnType<Connection['execute']>;
    }),
  };
  driver.createConnection.mockReturnValue(connection);
  return { connection, statements };
}

describe('isolated live fixture lifecycle (mocked SDK)', () => {
  beforeEach(() => driver.createConnection.mockReset());

  it('requires an explicit database', () => {
    expect(() => createFixture({ account: 'test' })).toThrow('explicit database');
    expect(driver.createConnection).not.toHaveBeenCalled();
  });

  it('seeds deterministically and drops only its own generated schema', async () => {
    const { connection, statements } = fakeConnection();
    const fixture = createFixture({ account: 'test', database: 'TEST_DB' });
    expect(fixture.schemaName).toMatch(/^SFLIB_TEST_[A-F0-9]{32}$/);
    await fixture.seed();
    expect(statements).toHaveLength(4);
    expect(statements[1]).toBe(`CREATE SCHEMA "TEST_DB"."${fixture.schemaName}"`);
    expect(statements[3]).toContain('9007199254740993');
    expect(statements[3]).toContain('12345678901234567890.1234');
    await fixture.cleanup();
    expect(statements[4]).toBe(`DROP SCHEMA IF EXISTS "TEST_DB"."${fixture.schemaName}" CASCADE`);
    expect(connection.destroy).toHaveBeenCalledOnce();
    await fixture.cleanup();
    expect(statements).toHaveLength(5);
    expect(connection.destroy).toHaveBeenCalledOnce();
  });

  it('creates distinct schema names for concurrent test runs', () => {
    fakeConnection();
    expect(createFixture({ database: 'TEST_DB' }).schemaName).not.toBe(
      createFixture({ database: 'TEST_DB' }).schemaName,
    );
  });

  it('escapes the configured database as one identifier component', async () => {
    const { statements } = fakeConnection();
    const fixture = createFixture({ database: 'DB".odd' });
    await fixture.seed();
    await fixture.cleanup();
    expect(statements[1]).toBe(`CREATE SCHEMA "DB"".odd"."${fixture.schemaName}"`);
  });

  it('does not drop a schema that was never successfully created', async () => {
    const { connection, statements } = fakeConnection({ statement: 'CREATE SCHEMA' });
    const fixture = createFixture({ database: 'TEST_DB' });
    await expect(fixture.seed()).rejects.toThrow('fixture SQL failed');
    expect(statements.some((sql) => sql.startsWith('DROP'))).toBe(false);
    expect(connection.destroy).toHaveBeenCalledOnce();
    await fixture.cleanup();
    expect(connection.destroy).toHaveBeenCalledOnce();
  });

  it.each(['CREATE TABLE', 'INSERT INTO'])(
    'cleans up after partial setup failure: %s',
    async (statement) => {
      const { connection, statements } = fakeConnection({ statement });
      const fixture = createFixture({ database: 'TEST_DB' });
      await expect(fixture.seed()).rejects.toThrow('fixture SQL failed');
      expect(statements.at(-1)).toBe(
        `DROP SCHEMA IF EXISTS "TEST_DB"."${fixture.schemaName}" CASCADE`,
      );
      expect(connection.destroy).toHaveBeenCalledOnce();
    },
  );

  it('propagates authentication failures before issuing SQL', async () => {
    const error = new Error('JWT rejected');
    const { statements } = fakeConnection({ connect: error });
    const fixture = createFixture({ database: 'TEST_DB' });
    await expect(fixture.seed()).rejects.toBe(error);
    await fixture.cleanup();
    expect(statements).toEqual([]);
  });

  it('still closes the connection when schema deletion fails', async () => {
    const { connection } = fakeConnection({ statement: 'DROP SCHEMA' });
    const fixture = createFixture({ database: 'TEST_DB' });
    await fixture.seed();
    await expect(fixture.cleanup()).rejects.toThrow('fixture SQL failed');
    expect(connection.destroy).toHaveBeenCalledOnce();
  });

  it('surfaces connection cleanup failures', async () => {
    const error = new Error('Destroy failed');
    fakeConnection({ destroy: error });
    const fixture = createFixture({ database: 'TEST_DB' });
    await fixture.seed();
    await expect(fixture.cleanup()).rejects.toBe(error);
  });
});
