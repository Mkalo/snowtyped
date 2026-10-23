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
function deferred() {
  let complete: StatementOption['complete'];
  let cancelled: ((error?: SnowflakeError) => void) | undefined;
  const statement = {
    getColumns: () => undefined,
    cancel: vi.fn((callback?: (error?: SnowflakeError) => void) => {
      cancelled = callback;
    }),
  };
  const execute = vi.fn((options: StatementOption) => {
    complete = options.complete;
    return statement as unknown as RowStatement;
  });
  return {
    connection: { execute },
    statement,
    finish(error?: Error) {
      complete?.(error as SnowflakeError | undefined, statement as unknown as RowStatement, [
        { ID: '1' },
      ]);
    },
    acknowledge(error?: Error) {
      cancelled?.(error as SnowflakeError | undefined);
    },
  };
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

  it('accepts execution options with a reusable query and completes normally', async () => {
    const fake = deferred();
    const controller = new AbortController();
    const pending = createClient(fake.connection).queryRaw(sql<{ ID: string }[]>`SELECT 1 AS ID`, {
      signal: controller.signal,
      timeoutMs: 1000,
    });
    fake.finish();
    expect(await pending).toEqual([{ ID: '1' }]);
    controller.abort();
    expect(fake.statement.cancel).not.toHaveBeenCalled();
    const plain = deferred();
    const empty = createClient(plain.connection).queryRaw(sql`SELECT 1`, {});
    plain.finish();
    expect(await empty).toEqual([{ ID: '1' }]);
  });

  it('rejects a pre-aborted raw query without executing it', async () => {
    const fake = deferred();
    const controller = new AbortController();
    const error = new Error('stop');
    controller.abort(error);
    await expect(
      createClient(fake.connection).queryRaw(sql`SELECT 1`, { signal: controller.signal }),
    ).rejects.toBe(error);
    expect(fake.connection.execute).not.toHaveBeenCalled();
  });

  it('cancels on a deadline once the SDK acknowledges and ignores late completion', async () => {
    const fake = deferred();
    let settled = false;
    const pending = createClient(fake.connection)
      .queryRaw(sql`SELECT SYSTEM$WAIT(10)`, { timeoutMs: 1 })
      .finally(() => {
        settled = true;
      });
    await vi.waitFor(() => expect(fake.statement.cancel).toHaveBeenCalledOnce());
    await Promise.resolve();
    expect(settled).toBe(false);
    fake.acknowledge();
    fake.finish(new Error('late'));
    await expect(pending).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(fake.statement.cancel).toHaveBeenCalledOnce();
  });

  it('settles with the real result when a raw query finishes before its cancel', async () => {
    const fake = deferred();
    const controller = new AbortController();
    const pending = createClient(fake.connection).queryRaw(sql`SELECT 1`, {
      signal: controller.signal,
    });
    controller.abort(new Error('stop'));
    fake.acknowledge(new Error('cancel failed'));
    fake.finish();
    await expect(pending).resolves.toEqual([{ ID: '1' }]);
  });

  it('rejects invalid deadlines before executing', async () => {
    const fake = deferred();
    await expect(
      createClient(fake.connection).queryRaw(sql`SELECT 1`, { timeoutMs: -1 }),
    ).rejects.toThrow();
    expect(fake.connection.execute).not.toHaveBeenCalled();
  });
});
