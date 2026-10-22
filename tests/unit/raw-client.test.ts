import type { Connection, RowStatement, SnowflakeError, StatementOption } from 'snowflake-sdk';
import { describe, expect, it, vi } from 'vitest';
import { sql } from '../../src/index.js';
import { createClient } from '../../src/snowflake/index.js';

function fake(error?: Error) {
  const execute = vi.fn((options: StatementOption) => {
    options.complete?.(error as SnowflakeError | undefined, {} as RowStatement, [{ ID: '42' }]);
    return {} as RowStatement;
  });
  return { execute } satisfies Pick<Connection, 'execute'>;
}

describe('raw client queries', () => {
  it('supports a direct tag with a query-time result assertion', async () => {
    const connection = fake();
    const result = await createClient(connection).queryRaw<{ ID: string }[]>`SELECT ${42} AS ID`;
    expect(result).toEqual([{ ID: '42' }]);
    expect(connection.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        sqlText: 'SELECT ? AS ID',
        binds: [42],
        rowMode: 'object',
      }),
    );
  });

  it('executes a reusable SQL tag abstraction', async () => {
    expect(await createClient(fake()).queryRaw(sql<{ ID: string }[]>`SELECT ${42} AS ID`)).toEqual([
      { ID: '42' },
    ]);
  });

  it('rejects driver failures without converting them into results', async () => {
    const error = new Error('SQL failed');
    await expect(createClient(fake(error)).queryRaw`SELECT 1`).rejects.toBe(error);
    await expect(
      createClient({
        execute() {
          throw error;
        },
      }).queryRaw`SELECT 1`,
    ).rejects.toBe(error);
  });
});
