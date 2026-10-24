import { Readable } from 'node:stream';
import type { Column, RowStatement, SnowflakeError, StatementOption } from 'snowflake-sdk';
import { describe, expect, it, vi } from 'vitest';
import { insert, integer, select, snowflakeTable, sql, text } from '../../src/index.js';
import { isUnusable } from '../../src/snowflake/client.js';
import { createClient, type SnowflakeClient } from '../../src/snowflake/index.js';
import { normalizeWireRow } from '../../src/snowflake/wire.js';

const table = snowflakeTable('T', { id: integer('ID').notNull(), name: text('NAME') });
const query = select(table);
const canceled = () => Object.assign(new Error('SQL execution canceled'), { code: '000604' });
function driver(rows: unknown[] | undefined = [['1', 'Ada']], deferred = false) {
  const readable = Readable.from(rows ?? [], { objectMode: true });
  const statement = {
    getQueryId: () => 'query',
    getNumUpdatedRows: vi.fn<() => number | undefined>(() => 3),
    getColumns: () => undefined,
    streamRows: vi.fn(() => readable),
    cancel: vi.fn((callback?: (error?: SnowflakeError) => void) => callback?.()),
  };
  let complete: StatementOption['complete'];
  const connection = {
    execute: vi.fn((options: StatementOption) => {
      complete = options.complete;
      if (!deferred) complete?.(undefined, statement as unknown as RowStatement, rows);
      return statement as unknown as RowStatement;
    }),
  };
  return {
    connection,
    statement,
    readable,
    finish(error?: Error) {
      complete?.(error as SnowflakeError | undefined, statement as unknown as RowStatement, rows);
    },
  };
}

describe('execution, streaming, and cancellation', () => {
  it('returns mutation metadata with and without an affected-row count', async () => {
    const fake = driver();
    const db = createClient(fake.connection);
    expect(await db.execute(insert(table, { id: 1n }))).toEqual({
      queryId: 'query',
      affectedRows: 3,
    });
    fake.statement.getNumUpdatedRows.mockReturnValue(undefined);
    expect((await db.execute(insert(table, { id: 1n }))).affectedRows).toBe(0);
  });

  it('streams decoded rows and raw rows and closes on early termination', async () => {
    const fake = driver([
      ['1', 'Ada'],
      ['2', null],
    ]);
    const rows = [];
    for await (const row of createClient(fake.connection).stream(query)) rows.push(row);
    expect(rows).toEqual([
      { id: 1n, name: 'Ada' },
      { id: 2n, name: null },
    ]);
    expect(fake.statement.streamRows).toHaveBeenCalledWith({
      fetchAsString: ['Number', 'Date', 'JSON'],
    });
    const raw = driver([{ ID: '1' }]);
    const rawRows = [];
    for await (const row of createClient(raw.connection).streamRaw<{ ID: string }>(sql`SELECT ID`))
      rawRows.push(row);
    expect(rawRows).toEqual([{ ID: '1' }]);
    const early = driver([
      ['1', 'Ada'],
      ['2', null],
    ]);
    for await (const _row of createClient(early.connection).stream(query)) break;
    expect(early.readable.destroyed).toBe(true);
    expect(early.statement.cancel).not.toHaveBeenCalled();
    const invalid = driver([['bad', 'Ada']]);
    await expect(async () => {
      for await (const _row of createClient(invalid.connection).stream(query)) {
        /* consume */
      }
    }).rejects.toThrow();
    expect(invalid.readable.destroyed).toBe(true);
  });

  it('rejects an aborted request without executing it', async () => {
    const fake = driver();
    const controller = new AbortController();
    const error = new Error('stop');
    controller.abort(error);
    await expect(
      createClient(fake.connection).execute(query, { signal: controller.signal }),
    ).rejects.toBe(error);
    expect(fake.connection.execute).not.toHaveBeenCalled();
  });

  it('waits for SDK cancellation and ignores late completion callbacks', async () => {
    const fake = driver(undefined, true);
    const controller = new AbortController();
    const error = new Error('stop');
    let cancelled: ((error?: SnowflakeError) => void) | undefined;
    fake.statement.cancel.mockImplementation((callback) => {
      cancelled = callback;
    });
    const promise = createClient(fake.connection).execute(query, { signal: controller.signal });
    controller.abort(error);
    cancelled?.();
    cancelled?.();
    fake.finish();
    fake.finish(new Error('late'));
    await expect(promise).rejects.toBe(error);
    expect(fake.statement.cancel).toHaveBeenCalledOnce();
  });

  it('settles with the real result when the statement completes before the cancel', async () => {
    const fake = driver([['1', 'Ada']], true);
    fake.statement.cancel.mockImplementation(() => {});
    const controller = new AbortController();
    const promise = createClient(fake.connection).execute(query, { signal: controller.signal });
    controller.abort(new Error('stop'));
    fake.finish();
    expect((await promise).rows).toEqual([{ id: 1n, name: 'Ada' }]);
  });

  it('retries a cancel that reaches Snowflake before the statement is executing', async () => {
    vi.useFakeTimers();
    try {
      const notExecuting = Object.assign(new Error('not currently executing'), { code: '000605' });
      const fake = driver(undefined, true);
      let attempts = 0;
      fake.statement.cancel.mockImplementation((callback) => {
        attempts += 1;
        callback?.(attempts < 8 ? (notExecuting as unknown as SnowflakeError) : undefined);
      });
      const controller = new AbortController();
      const error = new Error('stop');
      const promise = createClient(fake.connection).execute(query, { signal: controller.signal });
      controller.abort(error);
      const rejected = expect(promise).rejects.toBe(error);
      const delays = [50, 100, 200, 400, 800, 1000, 1000];
      for (const [index, delay] of delays.entries()) {
        expect(attempts).toBe(index + 1);
        await vi.advanceTimersByTimeAsync(delay - 1);
        expect(attempts).toBe(index + 1);
        await vi.advanceTimersByTimeAsync(1);
      }
      await rejected;
      expect(attempts).toBe(8);
      fake.finish(canceled());
      await vi.advanceTimersByTimeAsync(5000);
      expect(attempts).toBe(8);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['succeeds', undefined],
    ['fails', canceled()],
  ])('stops retrying the cancel once the statement %s', async (_outcome, failure) => {
    vi.useFakeTimers();
    try {
      const notExecuting = Object.assign(new Error('not currently executing'), { code: '000605' });
      const fake = driver([['1', 'Ada']], true);
      fake.statement.cancel.mockImplementation((callback) =>
        callback?.(notExecuting as unknown as SnowflakeError),
      );
      const controller = new AbortController();
      const error = new Error('stop');
      const promise = createClient(fake.connection).execute(query, { signal: controller.signal });
      controller.abort(error);
      await vi.advanceTimersByTimeAsync(150);
      expect(fake.statement.cancel).toHaveBeenCalledTimes(3);
      fake.finish(failure);
      if (failure) await expect(promise).rejects.toBe(error);
      else expect((await promise).rows).toEqual([{ id: 1n, name: 'Ada' }]);
      await vi.advanceTimersByTimeAsync(5000);
      expect(fake.statement.cancel).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits for the real outcome when the cancel fails or throws', async () => {
    const failed = driver([['1', 'Ada']], true);
    failed.statement.cancel.mockImplementation((callback) =>
      callback?.(new Error('cancel failed') as SnowflakeError),
    );
    const controller = new AbortController();
    const error = new Error('stop');
    const rejected = createClient(failed.connection).execute(query, { signal: controller.signal });
    controller.abort(error);
    failed.finish(canceled());
    await expect(rejected).rejects.toBe(error);
    expect(failed.statement.cancel).toHaveBeenCalledOnce();

    const compile = driver(undefined, true);
    compile.statement.cancel.mockImplementation(() => {});
    const own = new Error('SQL compilation error');
    const aborted = new AbortController();
    const failing = createClient(compile.connection).execute(query, { signal: aborted.signal });
    aborted.abort(error);
    compile.finish(own);
    await expect(failing).rejects.toBe(own);

    const thrown = driver([['1', 'Ada']], true);
    thrown.statement.cancel.mockImplementation(() => {
      throw new Error('cancel throws');
    });
    const other = new AbortController();
    const completed = createClient(thrown.connection).execute(query, { signal: other.signal });
    other.abort();
    thrown.finish();
    expect((await completed).rows).toEqual([{ id: 1n, name: 'Ada' }]);
  });

  it('supports deferred completion and native request deadlines', async () => {
    const fake = driver([['1', null]], true);
    const pending = createClient(fake.connection).execute(query);
    fake.finish();
    fake.finish();
    expect((await pending).rows).toEqual([{ id: 1n, name: null }]);
    const timeout = driver(undefined, true);
    await expect(
      createClient(timeout.connection).execute(query, { timeoutMs: 1 }),
    ).rejects.toMatchObject({ name: 'TimeoutError' });
    const combined = driver(undefined, true);
    const controller = new AbortController();
    const promise = createClient(combined.connection).execute(query, {
      timeoutMs: 1000,
      signal: controller.signal,
    });
    controller.abort(new Error('combined'));
    await expect(promise).rejects.toThrow('combined');
    await expect(
      createClient(driver().connection).execute(query, { timeoutMs: -1 }),
    ).rejects.toThrow();
  });

  it.each([new Error('stream stopped'), 'string reason'])(
    'aborts row consumption with %s',
    async (reason) => {
      const fake = driver([
        ['1', 'Ada'],
        ['2', 'Grace'],
      ]);
      const controller = new AbortController();
      const iterator = createClient(fake.connection)
        .stream(query, { signal: controller.signal })
        [Symbol.asyncIterator]();
      expect((await iterator.next()).value).toEqual({ id: 1n, name: 'Ada' });
      controller.abort(reason);
      await expect(iterator.next()).rejects.toThrow(
        reason instanceof Error ? 'stream stopped' : 'Stream aborted',
      );
      expect(fake.readable.destroyed).toBe(true);
    },
  );

  it('handles an abort between metadata completion and row-stream creation', async () => {
    const fake = driver([['1', 'Ada']]);
    const controller = new AbortController();
    const iterator = createClient(fake.connection)
      .stream(query, { signal: controller.signal })
      [Symbol.asyncIterator]();
    const pending = iterator.next();
    controller.abort(new Error('metadata boundary'));
    await expect(pending).rejects.toThrow('metadata boundary');
  });

  it('preserves literal text NULL while normalizing SDK SQL NULL sentinels', () => {
    const metadata = (name: string, string = false, binary = false) =>
      ({ getName: () => name, isString: () => string, isBinary: () => binary }) as Column;
    const statement = {
      getColumns: () => [metadata('N'), metadata('T', true), metadata('B', false, true)],
    } as RowStatement;
    expect(normalizeWireRow(['NULL', 'NULL', 'NULL'], statement)).toEqual([null, 'NULL', 'NULL']);
    expect(normalizeWireRow({ N: 'NULL', T: 'NULL', B: 'NULL', OTHER: 'NULL' }, statement)).toEqual(
      { N: null, T: 'NULL', B: 'NULL', OTHER: 'NULL' },
    );
    expect(normalizeWireRow(null, statement)).toBeNull();
    expect(normalizeWireRow('value', statement)).toBe('value');
  });

  it('reads column metadata once per statement and copies object rows', () => {
    const metadata = (name: string, string = false) =>
      ({ getName: () => name, isString: () => string, isBinary: () => false }) as Column;
    const getColumns = vi.fn(() => [metadata('X'), metadata('X', true), metadata('__proto__')]);
    const statement = { getColumns } as unknown as RowStatement;
    const row = JSON.parse('{"X":"NULL","__proto__":"NULL"}');
    const normalized = normalizeWireRow(row, statement) as Record<string, unknown>;
    expect(normalized).not.toBe(row);
    expect(row.X).toBe('NULL');
    expect(normalized.X).toBe('NULL');
    expect(Object.getPrototypeOf(normalized)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(normalized, '__proto__')?.value).toBeNull();
    expect(normalizeWireRow(['NULL', 'NULL', 'NULL'], statement)).toEqual([null, 'NULL', null]);
    expect(getColumns).toHaveBeenCalledTimes(1);
  });
});

describe('transaction sessions', () => {
  it('awaits started transaction queries before COMMIT even when the callback does not await them', async () => {
    let finish: StatementOption['complete'];
    let started: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const statement = { getQueryId: () => 'q', getColumns: () => undefined } as RowStatement;
    const connection = {
      execute: vi.fn((options: StatementOption) => {
        if (options.sqlText === query.compile().sql) {
          finish = options.complete;
          started?.();
        } else options.complete?.(undefined, statement, []);
        return statement;
      }),
    };
    const transaction = createClient(connection).transaction(async (tx) => {
      void tx.execute(query);
      return 'done';
    });
    await ready;
    expect(connection.execute.mock.calls.some(([options]) => options.sqlText === 'COMMIT')).toBe(
      false,
    );
    finish?.(undefined, statement, [['1', null]]);
    expect(await transaction).toBe('done');
    expect(connection.execute.mock.calls.at(-1)?.[0].sqlText).toBe('COMMIT');
  });
  it('rejects BEGIN while a request or cursor is still active', async () => {
    const deferred = driver([['1', null]], true);
    const client = createClient(deferred.connection);
    const pending = client.execute(query);
    await expect(client.transaction(async () => 1)).rejects.toThrow('running queries');
    deferred.finish();
    await pending;
    const streaming = createClient(driver([['1', null]]).connection);
    const cursor = streaming.stream(query)[Symbol.asyncIterator]();
    await cursor.next();
    await expect(streaming.transaction(async () => 1)).rejects.toThrow('close streams');
    await cursor.return?.();
    expect(await streaming.transaction(async () => 2)).toBe(2);
  });

  it('honors cancellation that happens synchronously during SDK execution', async () => {
    const controller = new AbortController();
    const error = new Error('synchronous abort');
    const statement = {
      cancel: vi.fn((callback?: (error?: SnowflakeError) => void) => callback?.()),
    } as unknown as RowStatement;
    const connection = {
      execute() {
        controller.abort(error);
        return statement;
      },
    };
    await expect(
      createClient(connection).execute(query, { signal: controller.signal }),
    ).rejects.toBe(error);
    expect(statement.cancel).toHaveBeenCalledOnce();
  });
  function transactionDriver(errors: Record<string, Error> = {}) {
    const statement = { getQueryId: () => 'q', getColumns: () => undefined } as RowStatement;
    const execute = vi.fn((options: StatementOption) => {
      options.complete?.(
        errors[options.sqlText] as SnowflakeError | undefined,
        statement,
        options.rowMode === 'array' ? [['1', null]] : [],
      );
      return statement;
    });
    return { execute };
  }
  it('commits successful callbacks and rejects root, nested, and expired transaction access', async () => {
    const connection = transactionDriver();
    const db = createClient(connection);
    let leaked: SnowflakeClient | undefined;
    expect(
      await db.transaction(async (tx) => {
        leaked = tx;
        await expect(db.execute(query)).rejects.toThrow('reserved');
        await expect(tx.transaction(async () => 1)).rejects.toThrow('Nested');
        return (await tx.execute(query)).rows[0]?.id;
      }),
    ).toBe(1n);
    expect(connection.execute.mock.calls.map(([options]) => options.sqlText)).toEqual([
      'BEGIN',
      query.compile().sql,
      'COMMIT',
    ]);
    await expect(leaked?.execute(query)).rejects.toThrow('no longer active');
    await db.transaction(async () => {
      await expect(leaked?.queryRaw(sql`SELECT 1`)).rejects.toThrow('no longer active');
    });
  });
  it('rolls back callback and commit failures, preserving the original error', async () => {
    const error = new Error('application');
    const connection = transactionDriver();
    const db = createClient(connection);
    await expect(
      db.transaction(async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    expect(connection.execute.mock.calls.map(([options]) => options.sqlText)).toEqual([
      'BEGIN',
      'ROLLBACK',
    ]);
    const commit = new Error('commit failed');
    const commits = transactionDriver({ COMMIT: commit });
    await expect(createClient(commits).transaction(async () => 1)).rejects.toBe(commit);
    expect(commits.execute.mock.calls.at(-1)?.[0].sqlText).toBe('ROLLBACK');
  });
  it('retains both failures if rollback fails and unlocks after BEGIN failure', async () => {
    const callback = new Error('callback');
    const rollback = new Error('rollback');
    const connection = transactionDriver({ ROLLBACK: rollback });
    const db = createClient(connection);
    expect(isUnusable(connection)).toBe(false);
    const failure = await db
      .transaction(async () => {
        throw callback;
      })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([callback, rollback]);
    expect(isUnusable(connection)).toBe(true);
    const calls = connection.execute.mock.calls.length;
    await expect(db.execute(query)).rejects.toThrow('ROLLBACK failed');
    await expect(db.queryRaw`SELECT 1`).rejects.toThrow('ROLLBACK failed');
    await expect(db.transaction(async () => 1)).rejects.toThrow('ROLLBACK failed');
    await expect(createClient(connection).execute(query)).rejects.toThrow('ROLLBACK failed');
    await expect(
      createClient(connection).stream(query)[Symbol.asyncIterator]().next(),
    ).rejects.toThrow('ROLLBACK failed');
    expect(connection.execute).toHaveBeenCalledTimes(calls);
    const errors = { BEGIN: new Error('begin') };
    const begin = transactionDriver(errors);
    const client = createClient(begin);
    await expect(client.transaction(async () => 1)).rejects.toThrow('begin');
    delete (errors as Partial<typeof errors>).BEGIN;
    expect((await client.execute(query)).rows).toHaveLength(1);
  });
  it('allows raw statements without a row result', async () => {
    expect(await createClient(driver(undefined).connection).queryRaw`DDL`).toEqual([['1', 'Ada']]);
    const connection = {
      execute(options: StatementOption) {
        const statement = {} as RowStatement;
        options.complete?.(undefined, statement);
        return statement;
      },
    };
    expect(await createClient(connection).queryRaw`DDL`).toBeUndefined();
  });
});
