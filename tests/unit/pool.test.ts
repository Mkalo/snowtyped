import { Readable } from 'node:stream';
import type { RowStatement, SnowflakeError, StatementOption } from 'snowflake-sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({ createPool: vi.fn() }));
vi.mock('snowflake-sdk', () => ({ default: sdk }));

import {
  insert,
  integer,
  many,
  select,
  snowflakeTable,
  sql,
  withRelations,
} from '../../src/index.js';
import { createPool } from '../../src/snowflake/index.js';

const table = snowflakeTable('T', { id: integer('ID').notNull() });
const children = snowflakeTable('C', { parentId: integer('PARENT_ID').notNull() });
const loaded = withRelations(select(table), {
  children: many(children, { from: table.columns.id, to: children.columns.parentId }),
});
function fakePool(error?: Error, errors: Record<string, Error> = {}) {
  const connection = {
    isUp: () => true,
    execute: vi.fn((options: StatementOption) => {
      const failure = errors[options.sqlText] ?? error;
      const rows = options.rowMode === 'array' ? [['1']] : [{ ID: '1' }];
      const statement = {
        getQueryId: () => 'q',
        getColumns: () => undefined,
        getNumUpdatedRows: () => 1,
        streamRows: () => Readable.from(rows, { objectMode: true }),
      } as RowStatement;
      options.complete?.(failure as SnowflakeError | undefined, statement, rows);
      return statement;
    }),
  };
  const pool = {
    acquire: vi.fn(async () => connection),
    release: vi.fn(async () => {}),
    destroy: vi.fn(async () => {}),
    drain: vi.fn(async () => {}),
    clear: vi.fn(async () => {}),
  };
  sdk.createPool.mockReturnValue(pool);
  return pool;
}

describe('SDK-backed pool leases', () => {
  beforeEach(() => sdk.createPool.mockReset());

  it('leases connections for typed queries, raw tags, and mutations', async () => {
    const driver = fakePool();
    const db = await createPool({ account: 'test' });
    expect(sdk.createPool).toHaveBeenCalledWith({ account: 'test' }, { min: 0, max: 5 });
    expect((await db.execute(select(table))).rows).toEqual([{ id: 1n }]);
    expect((await db.execute(insert(table, { id: 1n }))).affectedRows).toBe(1);
    expect(await db.queryRaw`SELECT 1`).toEqual([{ ID: '1' }]);
    expect(await db.queryRaw(sql`SELECT 1`)).toEqual([{ ID: '1' }]);
    expect((await db.execute(select(table).union(select(table)))).rows).toEqual([{ id: 1n }]);
    expect((await db.execute(loaded)).rows).toEqual([{ id: 1n, children: [{ parentId: 1n }] }]);
    expect(driver.release).toHaveBeenCalledTimes(6);
    await db.close();
    await db.close();
    expect(driver.drain).toHaveBeenCalledOnce();
    expect(driver.clear).toHaveBeenCalledOnce();
    await expect(db.execute(select(table))).rejects.toThrow('closed');
    await expect(db.queryRaw`SELECT 1`).rejects.toThrow('closed');
  });

  it('holds streaming leases through consumption and early return', async () => {
    const driver = fakePool();
    const db = await createPool({}, { max: 2, min: 0 });
    const iterator = db.stream(select(table))[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual({ id: 1n });
    expect(driver.release).not.toHaveBeenCalled();
    await iterator.return?.();
    expect(driver.release).toHaveBeenCalledOnce();
    const rows = [];
    for await (const row of db.streamRaw<{ ID: string }>(sql`SELECT 1`)) rows.push(row);
    expect(rows).toEqual([{ ID: '1' }]);
    expect(driver.release).toHaveBeenCalledTimes(2);
    const combined = [];
    for await (const row of db.stream(select(table).except(select(table)))) combined.push(row);
    expect(combined).toEqual([{ id: 1n }]);
    expect(driver.release).toHaveBeenCalledTimes(3);
    const related = [];
    for await (const row of db.stream(loaded)) related.push(row);
    expect(related).toEqual([{ id: 1n, children: [{ parentId: 1n }] }]);
    expect(driver.release).toHaveBeenCalledTimes(4);
    await db.close();
    await expect(async () => {
      for await (const _row of db.stream(select(table))) {
        /* consume */
      }
    }).rejects.toThrow('closed');
    await expect(async () => {
      for await (const _row of db.streamRaw(sql`SELECT 1`)) {
        /* consume */
      }
    }).rejects.toThrow('closed');
  });

  it('pins transactions to one lease and releases after errors', async () => {
    const driver = fakePool();
    const db = await createPool({});
    expect(await db.transaction(async (tx) => (await tx.execute(select(table))).rows[0]?.id)).toBe(
      1n,
    );
    expect(driver.acquire).toHaveBeenCalledOnce();
    expect(driver.release).toHaveBeenCalledOnce();
    await expect(
      db.transaction(async () => {
        throw new Error('callback');
      }),
    ).rejects.toThrow('callback');
    expect(driver.release).toHaveBeenCalledTimes(2);
    await db.close();
    const failed = fakePool(new Error('query failed'));
    const other = await createPool({});
    await expect(other.execute(select(table))).rejects.toThrow('query failed');
    expect(failed.release).toHaveBeenCalledOnce();
    await expect(async () => {
      for await (const _row of other.streamRaw(sql`SELECT 1`)) {
        /* consume */
      }
    }).rejects.toThrow('query failed');
    expect(failed.release).toHaveBeenCalledTimes(2);
    await other.close();
  });

  it('rejects aborted calls before leasing and releases only after cancellation completes', async () => {
    const driver = fakePool();
    const db = await createPool({});
    const controller = new AbortController();
    expect(
      await db.queryRaw<{ ID: string }[]>(sql`SELECT 1`, {
        signal: controller.signal,
        timeoutMs: 1000,
      }),
    ).toEqual([{ ID: '1' }]);
    expect(driver.release).toHaveBeenCalledOnce();
    const reason = new Error('stop');
    controller.abort(reason);
    await expect(db.queryRaw(sql`SELECT 1`, { signal: controller.signal })).rejects.toBe(reason);
    await expect(db.execute(select(table), { signal: controller.signal })).rejects.toBe(reason);
    await expect(async () => {
      for await (const _row of db.stream(select(table), { signal: controller.signal })) {
        /* consume */
      }
    }).rejects.toBe(reason);
    await expect(async () => {
      for await (const _row of db.streamRaw(sql`SELECT 1`, { signal: controller.signal })) {
        /* consume */
      }
    }).rejects.toBe(reason);
    expect(driver.acquire).toHaveBeenCalledOnce();
    expect(driver.release).toHaveBeenCalledOnce();
    let cancelled: ((error?: SnowflakeError) => void) | undefined;
    const statement = {
      cancel: vi.fn((callback?: (error?: SnowflakeError) => void) => {
        cancelled = callback;
      }),
    } as unknown as RowStatement;
    const connection = await driver.acquire();
    connection.execute.mockImplementation(() => statement);
    const pending = db.queryRaw(sql`SELECT SYSTEM$WAIT(10)`, { timeoutMs: 1 });
    await vi.waitFor(() => expect(statement.cancel).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(driver.release).toHaveBeenCalledOnce();
    cancelled?.();
    await expect(pending).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(driver.release).toHaveBeenCalledTimes(2);
    await db.close();
    await expect(db.queryRaw(sql`SELECT 1`, { timeoutMs: 1000 })).rejects.toThrow('closed');
  });

  it('destroys the lease instead of releasing it when ROLLBACK fails', async () => {
    const rollback = new Error('rollback failed');
    const driver = fakePool(undefined, { ROLLBACK: rollback });
    const db = await createPool({});
    const callback = new Error('callback');
    const failure = await db
      .transaction(async () => {
        throw callback;
      })
      .catch((error: unknown) => error);
    expect((failure as AggregateError).errors).toEqual([callback, rollback]);
    expect(driver.destroy).toHaveBeenCalledExactlyOnceWith(
      await driver.acquire.mock.results[0]?.value,
    );
    expect(driver.release).not.toHaveBeenCalled();
    await db.close();
  });

  it('passes testOnBorrow through to the SDK pool', async () => {
    fakePool();
    const db = await createPool({}, { testOnBorrow: true });
    expect(sdk.createPool).toHaveBeenCalledWith({}, { min: 0, max: 5, testOnBorrow: true });
    await db.close();
  });
});
