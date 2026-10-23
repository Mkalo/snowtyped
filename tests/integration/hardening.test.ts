import { randomUUID } from 'node:crypto';
import v8 from 'node:v8';
import vm from 'node:vm';
import snowflake from 'snowflake-sdk';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq, insert, integer, select, snowflakeTable, sql, text } from '../../src/index.js';
import { createPool, type PoolOptions } from '../../src/snowflake/index.js';
import { createFixture, integrationConfig } from '../support/snowflake.js';

v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc') as () => void;

/** The generic-pool counters behind the SDK pool. */
interface SdkPool {
  readonly size: number;
  readonly borrowed: number;
  readonly pending: number;
}

describe('production scenarios against Snowflake', () => {
  const config = integrationConfig();
  const fixture = createFixture(config);
  const db = fixture.client;
  const customers = fixture.table;
  const namespace = { database: config.database as string, schema: fixture.schemaName };
  const ledger = snowflakeTable(
    'LEDGER',
    { id: integer('ID').notNull(), worker: text('WORKER').notNull() },
    namespace,
  );

  beforeAll(async () => {
    await fixture.seed();
    await db.queryRaw(
      sql`CREATE TABLE ${sql.identifier(namespace.database, namespace.schema, 'LEDGER')} (ID NUMBER(38,0) NOT NULL, WORKER VARCHAR NOT NULL)`,
    );
  });
  afterAll(() => fixture.cleanup());

  async function observedPool(options: PoolOptions) {
    const spy = vi.spyOn(snowflake, 'createPool');
    try {
      const pool = await createPool(config, options);
      return { pool, sdkPool: spy.mock.results[0]?.value as SdkPool };
    } finally {
      spy.mockRestore();
    }
  }
  const session = async (client: { queryRaw: typeof db.queryRaw }) =>
    (await client.queryRaw<{ ID: string }[]>`SELECT CURRENT_SESSION() AS ID`)[0]?.ID;
  async function consume(rows: AsyncIterable<unknown>) {
    let count = 0;
    for await (const _row of rows) count++;
    return count;
  }
  const ledgerRows = (worker: string) =>
    db
      .execute(select(ledger, { id: ledger.columns.id }).where(eq(ledger.columns.worker, worker)))
      .then((result) => result.rows.map((row) => row.id).sort());

  it('cancels a running statement on the server and reuses its connection', async () => {
    const { pool, sdkPool } = await observedPool({ max: 1 });
    try {
      const before = await session(pool);
      const tag = `cancel_${randomUUID().replaceAll('-', '')}`;
      const statement = `SELECT SYSTEM$WAIT(60) AS ${tag}`;
      const controller = new AbortController();
      const reason = new Error('cancel fixture');
      setTimeout(() => controller.abort(reason), 1_000);
      const started = Date.now();
      await expect(
        consume(pool.streamRaw(sql.unsafe(statement), { signal: controller.signal })),
      ).rejects.toBe(reason);
      expect(Date.now() - started).toBeLessThan(15_000);
      expect(sdkPool.borrowed).toBe(0);
      expect(await session(pool)).toBe(before);
      await vi.waitFor(
        async () => {
          const [history] = await pool.queryRaw<{ STATUS: string; ERROR: string }[]>`
            SELECT EXECUTION_STATUS AS STATUS, ERROR_MESSAGE AS ERROR
            FROM TABLE(INFORMATION_SCHEMA.QUERY_HISTORY_BY_SESSION())
            WHERE QUERY_TEXT = ${statement}`;
          expect(history?.STATUS).toBe('FAILED_WITH_ERROR');
          expect(history?.ERROR).toMatch(/cancel/i);
        },
        { timeout: 20_000, interval: 1_000 },
      );
    } finally {
      await pool.close();
    }
  });

  it('rejects queued requests on abort or acquire timeout without leaking a lease', async () => {
    const { pool, sdkPool } = await observedPool({ max: 1, acquireTimeoutMillis: 1_000 });
    try {
      const holder = pool
        .streamRaw(sql`SELECT SEQ4() AS N FROM TABLE(GENERATOR(ROWCOUNT => 10))`)
        [Symbol.asyncIterator]();
      await holder.next();
      expect(sdkPool.borrowed).toBe(1);
      const controller = new AbortController();
      const reason = new Error('stop waiting');
      setTimeout(() => controller.abort(reason), 100);
      await expect(pool.execute(select(customers), { signal: controller.signal })).rejects.toBe(
        reason,
      );
      await expect(pool.execute(select(customers), { timeoutMs: 100 })).rejects.toMatchObject({
        name: 'TimeoutError',
      });
      await expect(pool.execute(select(customers))).rejects.toMatchObject({
        name: 'TimeoutError',
      });
      expect(sdkPool.borrowed).toBe(1);
      await holder.return?.();
      await vi.waitFor(() => {
        expect(sdkPool.borrowed).toBe(0);
        expect(sdkPool.pending).toBe(0);
      });
      expect((await pool.execute(select(customers))).rows).toHaveLength(3);
      expect(sdkPool.size).toBe(1);
    } finally {
      await pool.close();
    }
  });

  it('streams a result larger than its memory bound and stops early on break', async () => {
    const { pool, sdkPool } = await observedPool({ max: 1 });
    const rows = sql`SELECT SEQ8() AS N, RANDSTR(300, RANDOM()) AS PAD FROM TABLE(GENERATOR(ROWCOUNT => 1000000))`;
    const live = () => {
      gc();
      const usage = process.memoryUsage();
      return usage.heapUsed + usage.external;
    };
    try {
      const baseline = live();
      let peak = 0;
      let bytes = 0;
      let count = 0;
      for await (const row of pool.streamRaw<{ PAD: string }>(rows)) {
        bytes += row.PAD.length;
        if (++count % 50_000 === 0) peak = Math.max(peak, live() - baseline);
      }
      expect(count).toBe(1_000_000);
      expect(bytes).toBe(300_000_000);
      expect(peak).toBeLessThan(200_000_000);
      let seen = 0;
      for await (const _row of pool.streamRaw(rows)) if (++seen === 100) break;
      expect(sdkPool.borrowed).toBe(0);
      expect(await session(pool)).toBeDefined();
    } finally {
      await pool.close();
    }
  });

  it('keeps work above max within max connections and drains on close', async () => {
    const { pool, sdkPool } = await observedPool({ max: 3 });
    let peak = 0;
    const sample = setInterval(() => {
      peak = Math.max(peak, sdkPool.size, sdkPool.borrowed);
    }, 5);
    try {
      const sessions = await Promise.all(
        Array.from(
          { length: 24 },
          () =>
            pool.queryRaw<{ ID: string }[]>`
              SELECT CURRENT_SESSION() AS ID, SYSTEM$WAIT(200, 'MILLISECONDS') AS W`,
        ),
      );
      expect(new Set(sessions.map((rows) => rows[0]?.ID)).size).toBeLessThanOrEqual(3);
      expect(peak).toBe(3);
      const running = pool.queryRaw<{ W: string }[]>`SELECT SYSTEM$WAIT(2) AS W`;
      const streamed = consume(
        pool.streamRaw(sql`SELECT SEQ4() AS N FROM TABLE(GENERATOR(ROWCOUNT => 1000))`),
      );
      await vi.waitFor(() => expect(sdkPool.borrowed).toBe(2));
      const closing = pool.close();
      await expect(pool.execute(select(customers))).rejects.toThrow('closed');
      expect(await running).toEqual([{ W: 'waited 2 seconds' }]);
      expect(await streamed).toBe(1000);
      await closing;
      expect(sdkPool.size).toBe(0);
    } finally {
      clearInterval(sample);
      await pool.close();
    }
  });

  it('isolates a long-lived pooled transaction from concurrent work until it ends', async () => {
    const { pool } = await observedPool({ max: 2 });
    try {
      let inserted!: () => void;
      let finish!: () => void;
      const ready = new Promise<void>((resolve) => {
        inserted = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const committed = pool.transaction(async (tx) => {
        await tx.execute(insert(ledger, [{ id: 1n, worker: 'tx' }]));
        inserted();
        await gate;
        await tx.execute(insert(ledger, [{ id: 2n, worker: 'tx' }]));
        return session(tx);
      });
      await ready;
      for (let i = 0; i < 3; i++) {
        const outside = await pool.execute(
          select(ledger, { id: ledger.columns.id }).where(eq(ledger.columns.worker, 'tx')),
        );
        expect(outside.rows).toEqual([]);
      }
      finish();
      expect(await committed).toBeDefined();
      expect(await ledgerRows('tx')).toEqual([1n, 2n]);
      const failure = new Error('rollback fixture');
      await expect(
        pool.transaction(async (tx) => {
          await tx.execute(insert(ledger, [{ id: 3n, worker: 'rolled back' }]));
          throw failure;
        }),
      ).rejects.toBe(failure);
      expect(await ledgerRows('rolled back')).toEqual([]);
    } finally {
      await pool.close();
    }
  });

  it('releases a connection after SDK errors and replaces a terminated session', async () => {
    const { pool, sdkPool } = await observedPool({ max: 1 });
    try {
      const first = await session(pool);
      const missing = sql.identifier(namespace.database, namespace.schema, 'MISSING_TABLE');
      await expect(pool.queryRaw(sql`SELECT * FROM ${missing}`)).rejects.toMatchObject({
        code: '002003',
      });
      expect(await session(pool)).toBe(first);
      await pool.queryRaw`SELECT SYSTEM$ABORT_SESSION(${Number(first)})`;
      await expect(session(pool)).rejects.toMatchObject({ code: 407002 });
      const replacement = await session(pool);
      expect(replacement).toBeDefined();
      expect(replacement).not.toBe(first);
      expect(sdkPool.size).toBe(1);
    } finally {
      await pool.close();
    }
  });

  it('replaces a terminated session before lending it with testOnBorrow', async () => {
    const { pool } = await observedPool({ max: 1, testOnBorrow: true });
    try {
      const first = await session(pool);
      await pool.queryRaw`SELECT SYSTEM$ABORT_SESSION(${Number(first)})`;
      const replacement = await session(pool);
      expect(replacement).toBeDefined();
      expect(replacement).not.toBe(first);
    } finally {
      await pool.close();
    }
  });

  it('runs a failed mutation exactly once', async () => {
    const tag = `retry_${randomUUID().replaceAll('-', '')}`;
    const target = sql.identifier(namespace.database, namespace.schema, 'LEDGER');
    await expect(
      db.queryRaw(sql`INSERT INTO ${target} SELECT 1 / 0 AS ${sql.identifier(tag)}, 'retry'`),
    ).rejects.toMatchObject({ code: '100051' });
    await vi.waitFor(
      async () => {
        const rows = await db.queryRaw<{ N: string }[]>`
          SELECT COUNT(*) AS N FROM TABLE(INFORMATION_SCHEMA.QUERY_HISTORY_BY_SESSION())
          WHERE CONTAINS(QUERY_TEXT, ${tag})`;
        expect(rows).toEqual([{ N: '1' }]);
      },
      { timeout: 20_000, interval: 1_000 },
    );
    expect(await ledgerRows('retry')).toEqual([]);
  });

  it('sustains mixed concurrent work above max and closes every connection', async () => {
    const seconds = Number(process.env.SNOWTYPED_SOAK_SECONDS ?? 15);
    const { pool, sdkPool } = await observedPool({ max: 4 });
    let peak = 0;
    const sample = setInterval(() => {
      peak = Math.max(peak, sdkPool.size, sdkPool.borrowed);
    }, 5);
    const deadline = Date.now() + seconds * 1_000;
    const completed = { query: 0, raw: 0, stream: 0, transaction: 0 };
    let nextId = 1000n;
    async function worker(index: number) {
      for (let round = 0; Date.now() < deadline; round++) {
        switch ((index + round) % 4) {
          case 0:
            expect((await pool.execute(select(customers))).rows).toHaveLength(3);
            completed.query++;
            break;
          case 1:
            expect(await pool.queryRaw<{ N: string }[]>`SELECT ${round} AS N`).toEqual([
              { N: String(round) },
            ]);
            completed.raw++;
            break;
          case 2:
            expect(
              await consume(
                pool.streamRaw(sql`SELECT SEQ4() AS N FROM TABLE(GENERATOR(ROWCOUNT => 5000))`),
              ),
            ).toBe(5000);
            completed.stream++;
            break;
          default: {
            const id = nextId++;
            await pool.transaction(async (tx) => {
              await tx.execute(insert(ledger, [{ id, worker: 'soak' }]));
            });
            completed.transaction++;
          }
        }
      }
    }
    try {
      const started = Date.now();
      await Promise.all(Array.from({ length: 12 }, (_, index) => worker(index)));
      const total = Object.values(completed).reduce((sum, value) => sum + value, 0);
      console.info(
        `sustained: ${total} operations in ${((Date.now() - started) / 1_000).toFixed(1)}s`,
        completed,
      );
      expect(peak).toBe(4);
      expect(completed.transaction).toBeGreaterThan(0);
      expect(await ledgerRows('soak')).toHaveLength(completed.transaction);
    } finally {
      clearInterval(sample);
      await pool.close();
    }
    expect(sdkPool.size).toBe(0);
    expect(sdkPool.borrowed).toBe(0);
    expect(sdkPool.pending).toBe(0);
  }, 180_000);
});
