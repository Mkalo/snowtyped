import { Readable } from 'node:stream';
import type { RowStatement, SnowflakeError, StatementOption } from 'snowflake-sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({ createPool: vi.fn() }));
vi.mock('snowflake-sdk', () => ({ default: sdk }));

import { integer, select, snowflakeTable, sql } from '../../src/index.js';
import { createClient, createPool } from '../../src/snowflake/index.js';

const table = snowflakeTable('T', { id: integer('ID').notNull() });
const query = select(table);

type Complete = NonNullable<StatementOption['complete']>;
interface Behavior {
  /** Leave statements pending until `finish` is called. */
  deferred?: boolean;
  error?: (options: StatementOption) => Error | undefined;
  rows?: () => Readable;
}

function fakeConnection(id: number, behavior: Behavior) {
  const pending: (() => void)[] = [];
  const connection = {
    id,
    up: true,
    isUp: () => connection.up,
    execute: vi.fn((options: StatementOption) => {
      const rows = options.rowMode === 'array' ? [['1']] : [{ ID: '1' }];
      const statement = {
        getQueryId: () => `q${id}`,
        getColumns: () => undefined,
        getNumUpdatedRows: () => 1,
        streamRows: () => behavior.rows?.() ?? Readable.from(rows, { objectMode: true }),
        cancel: (callback?: (error?: SnowflakeError) => void) => callback?.(),
      } as unknown as RowStatement;
      const complete = () =>
        (options.complete as Complete)(
          behavior.error?.(options) as SnowflakeError | undefined,
          statement,
          rows,
        );
      if (behavior.deferred) pending.push(complete);
      else setImmediate(complete);
      return statement;
    }),
    finish() {
      for (const complete of pending.splice(0)) complete();
    },
  };
  return connection;
}
type FakeConnection = ReturnType<typeof fakeConnection>;

/** Models the generic-pool contract the SDK pool exposes: bounded size, FIFO waiters, drain. */
function fakeSdkPool(options: { max?: number; acquireTimeoutMillis?: number }, behavior: Behavior) {
  const max = options.max ?? 5;
  const idle: FakeConnection[] = [];
  const borrowed = new Set<FakeConnection>();
  const all: FakeConnection[] = [];
  const destroyed: FakeConnection[] = [];
  const waiters: { resolve(connection: FakeConnection): void; reject(error: Error): void }[] = [];
  const settled: (() => void)[] = [];
  let draining = false;
  let peak = 0;
  let createError: Error | undefined;
  function notify() {
    if (!waiters.length && !borrowed.size) for (const done of settled.splice(0)) done();
  }
  function dispense() {
    while (waiters.length && (idle.length || all.length - destroyed.length < max)) {
      const waiter = waiters.shift() as (typeof waiters)[number];
      if (createError && !idle.length) {
        waiter.reject(createError);
        continue;
      }
      let connection = idle.pop();
      if (!connection) {
        connection = fakeConnection(all.length, behavior);
        all.push(connection);
      }
      borrowed.add(connection);
      peak = Math.max(peak, borrowed.size);
      waiter.resolve(connection);
    }
    notify();
  }
  const pool = {
    get peak() {
      return peak;
    },
    all,
    idle,
    borrowed,
    destroyed,
    waiters,
    failCreation(error: Error) {
      createError = error;
    },
    acquire: vi.fn(
      () =>
        new Promise<FakeConnection>((resolve, reject) => {
          if (draining) {
            reject(new Error('pool is draining and cannot accept work'));
            return;
          }
          const waiter = { resolve, reject };
          waiters.push(waiter);
          if (options.acquireTimeoutMillis !== undefined)
            setTimeout(() => {
              const index = waiters.indexOf(waiter);
              if (index < 0) return;
              waiters.splice(index, 1);
              const error = new Error('ResourceRequest timed out');
              error.name = 'TimeoutError';
              reject(error);
              notify();
            }, options.acquireTimeoutMillis);
          dispense();
        }),
    ),
    release: vi.fn(async (connection: FakeConnection) => {
      borrowed.delete(connection);
      idle.push(connection);
      dispense();
    }),
    destroy: vi.fn(async (connection: FakeConnection) => {
      borrowed.delete(connection);
      destroyed.push(connection);
      dispense();
    }),
    drain: vi.fn(async () => {
      draining = true;
      if (waiters.length || borrowed.size)
        await new Promise<void>((resolve) => settled.push(resolve));
    }),
    clear: vi.fn(async () => {
      destroyed.push(...idle.splice(0));
    }),
  };
  return pool;
}

async function poolWith(options: { max?: number; acquireTimeoutMillis?: number }, behavior = {}) {
  const fake = fakeSdkPool(options, behavior);
  sdk.createPool.mockReturnValue(fake);
  return { fake, db: await createPool({}, options) };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function drain(iterable: AsyncIterable<unknown>) {
  const rows = [];
  for await (const row of iterable) rows.push(row);
  return rows;
}

beforeEach(() => sdk.createPool.mockReset());

describe('pool pressure', () => {
  it('runs mixed work above max without exceeding max leases', async () => {
    const { fake, db } = await poolWith({ max: 3 });
    const work = Array.from({ length: 40 }, (_, i) => {
      switch (i % 4) {
        case 0:
          return db.execute(query).then((result) => result.rows);
        case 1:
          return db.queryRaw`SELECT ${i}`;
        case 2:
          return drain(db.stream(query));
        default:
          return db.transaction(async (tx) => (await tx.execute(query)).rows);
      }
    });
    const results = await Promise.all(work);
    expect(results).toEqual(
      Array.from({ length: 40 }, (_, i) => (i % 4 === 1 ? [{ ID: '1' }] : [{ id: 1n }])),
    );
    expect(fake.peak).toBe(3);
    expect(fake.all).toHaveLength(3);
    expect(fake.borrowed.size).toBe(0);
    expect(fake.acquire).toHaveBeenCalledTimes(40);
    expect(fake.release).toHaveBeenCalledTimes(40);
    await db.close();
    expect(fake.destroyed).toHaveLength(3);
  });

  it('waits for running and queued work on close, then closes every connection', async () => {
    const { fake, db } = await poolWith({ max: 1 }, { deferred: true });
    const running = db.execute(query);
    const queued = db.queryRaw`SELECT 1`;
    await tick();
    const closed: string[] = [];
    const closing = db.close().then(() => closed.push('first'));
    const again = db.close().then(() => closed.push('second'));
    await expect(db.execute(query)).rejects.toThrow('closed');
    await expect(drain(db.stream(query))).rejects.toThrow('closed');
    await tick();
    expect(closed).toEqual([]);
    fake.all[0]?.finish();
    expect((await running).rows).toEqual([{ id: 1n }]);
    await tick();
    expect(closed).toEqual([]);
    fake.all[0]?.finish();
    expect(await queued).toEqual([{ ID: '1' }]);
    await Promise.all([closing, again]);
    expect(closed).toEqual(['first', 'second']);
    expect(fake.drain).toHaveBeenCalledOnce();
    expect(fake.clear).toHaveBeenCalledOnce();
    expect(fake.borrowed.size).toBe(0);
    expect(fake.destroyed).toEqual(fake.all);
  });
});

describe('pool acquisition waits', () => {
  it('rejects a waiting request on abort and returns a late lease unused', async () => {
    const { fake, db } = await poolWith({ max: 1 }, { deferred: true });
    const running = db.execute(query);
    await tick();
    const controller = new AbortController();
    const reason = new Error('caller gave up');
    const waiting = db.execute(query, { signal: controller.signal });
    controller.abort(reason);
    await expect(waiting).rejects.toBe(reason);
    expect(fake.waiters).toHaveLength(1);
    fake.all[0]?.finish();
    await running;
    await tick();
    expect(fake.borrowed.size).toBe(0);
    expect(fake.waiters).toHaveLength(0);
    expect(fake.all[0]?.execute).toHaveBeenCalledOnce();
    expect(fake.release).toHaveBeenCalledTimes(2);
    await db.close();
  });

  it('swallows a failed release of a late lease nobody is waiting for', async () => {
    const { fake, db } = await poolWith({ max: 1 }, { deferred: true });
    const release = fake.release.getMockImplementation() as (c: FakeConnection) => Promise<void>;
    fake.release.mockImplementation(async (connection) => {
      const call = fake.release.mock.calls.length;
      await release(connection);
      if (call === 2) throw new Error('pool cleared');
    });
    const running = db.execute(query);
    await tick();
    const controller = new AbortController();
    const waiting = db.execute(query, { signal: controller.signal });
    controller.abort(new Error('caller gave up'));
    await expect(waiting).rejects.toThrow('caller gave up');
    fake.all[0]?.finish();
    await running;
    await tick();
    expect(fake.release).toHaveBeenCalledTimes(2);
    expect(fake.borrowed.size).toBe(0);
    await db.close();
  });

  it('keeps one deadline across the wait and the statement', async () => {
    const { fake, db } = await poolWith({ max: 1 }, { deferred: true });
    const controller = new AbortController();
    const options = { signal: controller.signal, timeoutMs: 60_000 };
    const results = [
      db.execute(query, options),
      drain(db.stream(query, options)),
      drain(db.streamRaw(sql`SELECT 1`, options)),
    ];
    for (const _ of results) {
      await tick();
      fake.all[0]?.finish();
    }
    expect(await Promise.all(results)).toEqual([
      { rows: [{ id: 1n }], queryId: 'q0' },
      [{ id: 1n }],
      [{ ID: '1' }],
    ]);
    const running = db.execute(query, options);
    await tick();
    controller.abort(new Error('mid-statement'));
    await expect(running).rejects.toThrow('mid-statement');
    expect(fake.borrowed.size).toBe(0);
    await db.close();
  });

  it('applies timeoutMs to the wait for a connection', async () => {
    const { fake, db } = await poolWith({ max: 1 }, { deferred: true });
    const running = db.execute(query);
    await tick();
    await expect(db.execute(query, { timeoutMs: 5 })).rejects.toMatchObject({
      name: 'TimeoutError',
    });
    await expect(drain(db.streamRaw(sql`SELECT 1`, { timeoutMs: 5 }))).rejects.toMatchObject({
      name: 'TimeoutError',
    });
    fake.all[0]?.finish();
    await running;
    await tick();
    expect(fake.borrowed.size).toBe(0);
    expect(fake.all[0]?.execute).toHaveBeenCalledOnce();
    await db.close();
  });

  it('rejects on acquireTimeoutMillis without leaking a lease', async () => {
    const { fake, db } = await poolWith({ max: 1, acquireTimeoutMillis: 5 }, { deferred: true });
    const held = db.stream(query)[Symbol.asyncIterator]();
    const first = held.next();
    await tick();
    fake.all[0]?.finish();
    await first;
    await expect(db.execute(query)).rejects.toMatchObject({ name: 'TimeoutError' });
    await expect(db.execute(query, { signal: new AbortController().signal })).rejects.toMatchObject(
      { name: 'TimeoutError' },
    );
    expect(fake.borrowed.size).toBe(1);
    await held.return?.();
    expect(fake.borrowed.size).toBe(0);
    expect(fake.waiters).toHaveLength(0);
    await db.close();
  });

  it('never acquires for a pre-aborted request and surfaces connection failures', async () => {
    const { fake, db } = await poolWith({ max: 1 });
    const reason = new Error('already aborted');
    await expect(db.execute(query, { signal: AbortSignal.abort(reason) })).rejects.toBe(reason);
    await expect(drain(db.stream(query, { signal: AbortSignal.abort(reason) }))).rejects.toBe(
      reason,
    );
    expect(fake.acquire).not.toHaveBeenCalled();
    const failure = new Error('network unreachable');
    fake.failCreation(failure);
    await expect(db.execute(query)).rejects.toBe(failure);
    await expect(db.transaction(async () => 1)).rejects.toBe(failure);
    expect(fake.acquire).toHaveBeenCalledTimes(2);
    expect(fake.release).not.toHaveBeenCalled();
    await db.close();
  });
});

describe('failures and cleanup', () => {
  it('destroys a terminated connection instead of returning it to the pool', async () => {
    const terminated = Object.assign(
      new Error('Unable to perform operation using terminated connection.'),
      { code: 407002 },
    );
    let fail = true;
    const { fake, db } = await poolWith(
      { max: 1 },
      {
        error: () => {
          if (!fail) return undefined;
          (fake.all[0] as FakeConnection).up = false;
          return terminated;
        },
      },
    );
    await expect(db.execute(query)).rejects.toBe(terminated);
    expect(fake.destroy).toHaveBeenCalledExactlyOnceWith(fake.all[0]);
    fail = false;
    expect((await db.execute(query)).queryId).toBe('q1');
    expect(fake.release).toHaveBeenCalledExactlyOnceWith(fake.all[1]);
    await db.close();
  });

  it.each([
    ['network', Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })],
    ['SDK', Object.assign(new Error('SQL compilation error'), { code: '001003' })],
  ])(
    'rejects %s errors with the original error, once, and releases the lease',
    async (_, error) => {
      const { fake, db } = await poolWith({ max: 2 }, { error: () => error });
      await expect(db.execute(query)).rejects.toBe(error);
      await expect(db.queryRaw`SELECT 1`).rejects.toBe(error);
      await expect(drain(db.stream(query))).rejects.toBe(error);
      await expect(drain(db.streamRaw(sql`SELECT 1`))).rejects.toBe(error);
      await expect(db.transaction(async () => 1)).rejects.toBe(error);
      const executions = fake.all.reduce((total, c) => total + c.execute.mock.calls.length, 0);
      expect(executions).toBe(5);
      expect(fake.acquire).toHaveBeenCalledTimes(5);
      expect(fake.release).toHaveBeenCalledTimes(5);
      expect(fake.borrowed.size).toBe(0);
      await db.close();
    },
  );

  it('rejects mid-stream errors with the original error and releases the lease', async () => {
    const error = new Error('result chunk download failed');
    let readable: Readable | undefined;
    const { fake, db } = await poolWith(
      { max: 1 },
      {
        rows: () => {
          readable = new Readable({ objectMode: true, read() {} });
          readable.push(['1']);
          setImmediate(() => readable?.destroy(error));
          return readable;
        },
      },
    );
    const rows: unknown[] = [];
    await expect(async () => {
      for await (const row of db.stream(query)) rows.push(row);
    }).rejects.toBe(error);
    expect(rows).toEqual([{ id: 1n }]);
    expect(readable?.destroyed).toBe(true);
    expect(fake.borrowed.size).toBe(0);
    await db.close();
  });

  it('destroys the row stream and releases the lease when the consumer throws', async () => {
    let readable: Readable | undefined;
    const { fake, db } = await poolWith(
      { max: 1 },
      {
        rows: () => {
          readable = Readable.from(
            (function* () {
              for (let i = 0; ; i++) yield [String(i)];
            })(),
            { objectMode: true },
          );
          return readable;
        },
      },
    );
    const error = new Error('consumer failed');
    await expect(async () => {
      for await (const row of db.stream(query)) if (row.id === 3n) throw error;
    }).rejects.toBe(error);
    expect(readable?.destroyed).toBe(true);
    expect(fake.borrowed.size).toBe(0);
    await db.close();
  });

  it('never retries a failed statement on a single client', async () => {
    const error = new Error('statement failed');
    const connection = fakeConnection(0, { error: () => error });
    const client = createClient(connection);
    await expect(client.execute(query)).rejects.toBe(error);
    await expect(client.queryRaw`SELECT 1`).rejects.toBe(error);
    await expect(drain(client.streamRaw(sql`SELECT 1`))).rejects.toBe(error);
    expect(connection.execute).toHaveBeenCalledTimes(3);
    const thrown = new Error('synchronous driver failure');
    connection.execute.mockImplementation(() => {
      throw thrown;
    });
    await expect(client.execute(query)).rejects.toBe(thrown);
    expect(connection.execute).toHaveBeenCalledTimes(4);
  });
});
