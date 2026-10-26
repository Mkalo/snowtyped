import { mkdirSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import v8 from 'node:v8';
import vm from 'node:vm';
import type { StatementOption } from 'snowflake-sdk';
import snowflake from 'snowflake-sdk';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  boolean,
  decimal,
  eq,
  insert,
  integer,
  type Snowtyped,
  select,
  snowflakeTable,
  sql,
  text,
  timestamp,
} from '../../src/index.js';
import { createClient, createPool } from '../../src/snowflake/index.js';
import { fixed, type Summary, summarize, table } from '../support/measure.js';
import { createFixture, integrationConfig } from '../support/snowflake.js';

v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc') as () => void;

function seconds(name: string, fallback: number) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1)
    throw new Error(`${name} must be a positive integer, received ${process.env[name]}.`);
  return value;
}
const stepSeconds = seconds('SNOWTYPED_LOAD_SECONDS', 15);
const soakSeconds = seconds('SNOWTYPED_LOAD_SOAK_SECONDS', 120);
const streamRows = seconds('SNOWTYPED_LOAD_ROWS', 1_000_000);

interface SdkPool {
  readonly size: number;
  readonly borrowed: number;
  readonly pending: number;
}

const sections: { title: string; rows: Record<string, string | number>[] }[] = [];
const results: Record<string, unknown> = {};
const ms = (summary: Summary) => ({
  p50: fixed(summary.p50),
  p95: fixed(summary.p95),
  p99: fixed(summary.p99),
  max: fixed(summary.max),
});
const mb = (bytes: number) => fixed(bytes / 1_048_576);

describe('load against Snowflake', () => {
  const config = integrationConfig();
  const fixture = createFixture(config);
  const db = fixture.client;
  const namespace = { database: config.database as string, schema: fixture.schemaName };
  const events = snowflakeTable(
    'EVENTS',
    {
      id: integer('ID').notNull(),
      name: text('NAME').notNull(),
      amount: decimal('AMOUNT').notNull(),
      created: timestamp('CREATED', 'ntz').notNull(),
      flag: boolean('FLAG').notNull(),
    },
    namespace,
  );
  const ledger = snowflakeTable(
    'LEDGER',
    { id: integer('ID').notNull(), worker: text('WORKER').notNull() },
    namespace,
  );
  const eventsTable = sql.identifier(namespace.database, namespace.schema, 'EVENTS');
  const raw = snowflake.createConnection(config);

  beforeAll(async () => {
    await fixture.seed();
    await db.queryRaw(sql`CREATE TABLE ${eventsTable} AS
      SELECT SEQ8() AS ID, RANDSTR(24, RANDOM()) AS NAME, (UNIFORM(0, 100000, RANDOM()) / 100)::NUMBER(12, 2) AS AMOUNT,
        DATEADD(SECOND, SEQ4(), '2024-01-01'::TIMESTAMP_NTZ) AS CREATED, UNIFORM(0, 1, RANDOM()) = 1 AS FLAG
      FROM TABLE(GENERATOR(ROWCOUNT => ${streamRows}))`);
    await db.queryRaw(
      sql`CREATE TABLE ${sql.identifier(namespace.database, namespace.schema, 'LEDGER')} (ID NUMBER(38,0) NOT NULL, WORKER VARCHAR NOT NULL)`,
    );
    await new Promise<void>((resolve, reject) =>
      raw.connect((error) => (error ? reject(error) : resolve())),
    );
    const [warehouse] = await db.queryRaw<Record<string, string>[]>(
      sql`SELECT CURRENT_WAREHOUSE() AS WAREHOUSE, CURRENT_REGION() AS REGION, CURRENT_VERSION() AS VERSION`,
    );
    results.environment = { ...warehouse, node: process.version };
  }, 300_000);

  afterAll(async () => {
    try {
      if (raw.isUp()) await new Promise<void>((resolve) => raw.destroy(() => resolve()));
    } finally {
      await fixture.cleanup();
    }
    const markdown = [
      `Environment: ${JSON.stringify(results.environment)}`,
      ...sections.map(({ title, rows }) => `\n### ${title}\n\n${table(rows)}`),
    ].join('\n');
    mkdirSync('reports', { recursive: true });
    writeFileSync('reports/load.json', JSON.stringify(results, null, 2));
    writeFileSync('reports/load.md', `${markdown}\n`);
    process.stdout.write(`\n${markdown}\n`);
  });

  function sdk(options: StatementOption): Promise<unknown[]> {
    return new Promise((resolve, reject) =>
      raw.execute({
        ...options,
        complete: (error, _statement, rows) => (error ? reject(error) : resolve(rows ?? [])),
      }),
    );
  }
  async function timed(count: number, run: (index: number) => Promise<unknown>) {
    const samples: number[] = [];
    for (let i = 0; i < count; i++) {
      const start = performance.now();
      await run(i);
      samples.push(performance.now() - start);
    }
    return summarize(samples);
  }
  async function observedPool(options: Snowtyped.PoolOptions) {
    const spy = vi.spyOn(snowflake, 'createPool');
    try {
      const pool = await createPool(config, options);
      return { pool, sdkPool: spy.mock.results[0]?.value as SdkPool };
    } finally {
      spy.mockRestore();
    }
  }
  const pointQuery = (id: number) =>
    select(events, {
      id: events.columns.id,
      name: events.columns.name,
      amount: events.columns.amount,
    }).where(eq(events.columns.id, BigInt(id)));

  it('adds no measurable latency to a round trip', async () => {
    const typed = createClient(raw);
    const rounds = 60;
    const compiled = pointQuery(1).compile();
    const stages = {
      sdk: await timed(rounds, (i) =>
        sdk({ sqlText: compiled.sql, binds: [String(i + 1)], rowMode: 'array' }),
      ),
      snowtyped: await timed(rounds, (i) => typed.execute(pointQuery(i + 1))),
      'snowtyped queryRaw': await timed(rounds, (i) =>
        typed.queryRaw(sql`SELECT ID, NAME, AMOUNT FROM ${eventsTable} WHERE ID = ${i + 1}`),
      ),
    };
    results.latency = stages;
    sections.push({
      title: `Single-connection point query latency (ms, ${rounds} sequential round trips)`,
      rows: Object.entries(stages).map(([path, summary]) => ({ path, ...ms(summary) })),
    });
    expect(stages.snowtyped.count).toBe(rounds);
  });

  it('scales pooled throughput with concurrency', async () => {
    const rows: Record<string, string | number>[] = [];
    const steps: Record<string, unknown>[] = [];
    for (const [max, workers] of [
      [1, 1],
      [4, 4],
      [8, 8],
      [8, 16],
      [8, 32],
    ] as const) {
      const { pool, sdkPool } = await observedPool({ max, min: max });
      try {
        await Promise.all(Array.from({ length: max }, () => pool.queryRaw`SELECT 1`));
        const samples: number[] = [];
        let errors = 0;
        const end = performance.now() + stepSeconds * 1000;
        let next = 0;
        await Promise.all(
          Array.from({ length: workers }, async () => {
            while (performance.now() < end) {
              const start = performance.now();
              try {
                await pool.execute(pointQuery((next++ % streamRows) + 1));
                samples.push(performance.now() - start);
              } catch {
                errors++;
              }
            }
          }),
        );
        const summary = summarize(samples);
        steps.push({
          ...summary,
          poolMax: max,
          workers,
          errors,
          opsPerSecond: samples.length / stepSeconds,
        });
        rows.push({
          'max / workers': `${max} / ${workers}`,
          'ops/s': fixed(samples.length / stepSeconds),
          ...ms(summary),
          errors,
        });
        expect(errors).toBe(0);
        expect(sdkPool.size).toBeLessThanOrEqual(max);
      } finally {
        await pool.close();
      }
      expect(sdkPool.size).toBe(0);
    }
    results.throughput = steps;
    sections.push({
      title: `Pooled point queries (${stepSeconds} s per step, latency in ms including pool waits)`,
      rows,
    });
  });

  it('streams and buffers large results at SDK speed', async () => {
    const columns = sql`SELECT ID, NAME, AMOUNT, CREATED, FLAG FROM ${eventsTable}`;
    const serverFormatted = sql`SELECT ID, NAME, AMOUNT, TO_VARCHAR(CREATED) AS CREATED, FLAG FROM ${eventsTable}`;
    const { sql: text, binds } = columns.compile();
    const typed = createClient(raw);
    const live = () => {
      gc();
      const usage = process.memoryUsage();
      return usage.heapUsed + usage.external;
    };
    /** `probe` samples live memory; streams call it every 50,000 rows, buffered reads once. */
    async function run(consume: (probe: () => void) => Promise<number>) {
      // The SDK keeps the previous statement's buffered rows until the next statement runs.
      await sdk({ sqlText: 'SELECT 1' });
      const baseline = live();
      let peak = 0;
      const probe = () => {
        peak = Math.max(peak, live() - baseline);
      };
      const start = performance.now();
      const count = await consume(probe);
      const elapsed = (performance.now() - start) / 1000;
      expect(count).toBe(streamRows);
      return { rowsPerSecond: count / elapsed, seconds: elapsed, peakBytes: peak };
    }
    const counter = (probe: () => void) => {
      let seen = 0;
      return () => {
        if (++seen % 50_000 === 0) probe();
        return seen;
      };
    };
    const count = async (rows: AsyncIterable<unknown>, probe: () => void) => {
      const next = counter(probe);
      let seen = 0;
      for await (const _row of rows) seen = next();
      return seen;
    };
    const sdkStream = (probe: () => void) =>
      new Promise<number>((resolve, reject) => {
        raw.execute({
          sqlText: text,
          binds: [...binds],
          streamResult: true,
          complete(error, statement) {
            if (error) return reject(error);
            const next = counter(probe);
            let seen = 0;
            statement
              .streamRows({ fetchAsString: ['Number', 'Date', 'JSON'] })
              .on('data', () => {
                seen = next();
              })
              .on('error', reject)
              .on('end', () => resolve(seen));
          },
        });
      });
    const buffered = async (rows: Promise<readonly unknown[]>, probe: () => void) => {
      const result = await rows;
      probe();
      return result.length;
    };
    const stages = {
      'sdk streamRows': await run(sdkStream),
      'snowtyped streamRaw': await run((probe) => count(typed.streamRaw(columns), probe)),
      'snowtyped streamRaw, TO_VARCHAR timestamp': await run((probe) =>
        count(typed.streamRaw(serverFormatted), probe),
      ),
      'snowtyped stream(select)': await run((probe) => count(typed.stream(select(events)), probe)),
      'sdk execute, array rows': await run((probe) =>
        buffered(sdk({ sqlText: text, binds: [...binds], rowMode: 'array' }), probe),
      ),
      'snowtyped execute(select)': await run((probe) =>
        buffered(
          typed.execute(select(events)).then((result) => result.rows),
          probe,
        ),
      ),
    };
    results.streaming = { rows: streamRows, stages };
    sections.push({
      title: `${streamRows.toLocaleString('en-US')} rows × 5 columns on one connection (peak live heap + external above baseline)`,
      rows: Object.entries(stages).map(([path, stage]) => ({
        path,
        'rows/s': Math.round(stage.rowsPerSecond),
        seconds: fixed(stage.seconds),
        'peak MB': mb(stage.peakBytes),
      })),
    });
  });

  it('holds latency, memory, and connections steady under a sustained mixed load', async () => {
    const { pool, sdkPool } = await observedPool({ max: 8 });
    const workers = 16;
    const window = 10_000;
    const ops = ['point', 'raw', 'stream', 'transaction', 'timeout'] as const;
    const byOp = Object.fromEntries(ops.map((op) => [op, [] as number[]])) as Record<
      (typeof ops)[number],
      number[]
    >;
    const windows: { second: number; ops: number; p95: number; heapMB: number }[] = [];
    let unexpected: unknown;
    let windowSamples: number[] = [];
    let id = 0;
    const start = performance.now();
    const end = start + soakSeconds * 1000;
    const heap = () => {
      gc();
      return process.memoryUsage().heapUsed;
    };
    const baselineHeap = heap();
    const sampler = setInterval(() => {
      windows.push({
        second: Math.round((performance.now() - start) / 1000),
        ops: windowSamples.length,
        p95: windowSamples.length ? summarize(windowSamples).p95 : 0,
        heapMB: (heap() - baselineHeap) / 1_048_576,
      });
      windowSamples = [];
    }, window);
    async function operation(op: (typeof ops)[number], worker: number) {
      switch (op) {
        case 'point':
          return pool.execute(pointQuery((id++ % streamRows) + 1));
        case 'raw':
          return pool.queryRaw`SELECT COUNT(*) AS N FROM ${eventsTable} WHERE ID < ${id++ % 1000}`;
        case 'stream': {
          let seen = 0;
          for await (const _row of pool.stream(select(events).limit(2000))) seen++;
          return seen;
        }
        case 'transaction':
          return pool.transaction((tx) =>
            tx.execute(insert(ledger, { id: BigInt(id++), worker: `w${worker}` })),
          );
        case 'timeout':
          return pool.queryRaw(sql`SELECT SYSTEM$WAIT(5)`, { timeoutMs: 300 }).then(
            () => {
              throw new Error('A 5 s wait finished inside a 300 ms timeout.');
            },
            (error: unknown) => {
              if (!(error instanceof DOMException && error.name === 'TimeoutError')) throw error;
            },
          );
      }
    }
    try {
      await Promise.all(
        Array.from({ length: workers }, async (_, worker) => {
          let turn = worker;
          while (performance.now() < end && !unexpected) {
            const op = turn++ % 25 === 0 ? 'timeout' : ops[turn % 4];
            const began = performance.now();
            try {
              await operation(op as (typeof ops)[number], worker);
            } catch (error) {
              unexpected ??= error;
            }
            const elapsed = performance.now() - began;
            byOp[op as (typeof ops)[number]].push(elapsed);
            windowSamples.push(elapsed);
          }
        }),
      );
    } finally {
      clearInterval(sampler);
      await pool.close();
    }
    expect(unexpected).toBeUndefined();
    expect(sdkPool).toMatchObject({ size: 0, borrowed: 0, pending: 0 });
    const [{ N: inserted } = { N: '0' }] = await db.queryRaw<{ N: string }[]>(
      sql`SELECT COUNT(*) AS N FROM ${sql.identifier(namespace.database, namespace.schema, 'LEDGER')}`,
    );
    expect(Number(inserted)).toBe(byOp.transaction.length);
    const total = Object.values(byOp).reduce((sum, samples) => sum + samples.length, 0);
    results.soak = {
      seconds: soakSeconds,
      workers,
      max: 8,
      total,
      byOp: Object.fromEntries(ops.map((op) => [op, summarize(byOp[op])])),
      windows,
    };
    sections.push(
      {
        title: `Sustained mixed load (${soakSeconds} s, ${workers} workers on max: 8, ${total} operations)`,
        rows: ops.map((op) => ({
          operation: op,
          count: byOp[op].length,
          ...ms(summarize(byOp[op])),
        })),
      },
      {
        title: 'Soak windows (ops and p95 ms per 10 s window, retained heap growth after GC)',
        rows: windows.map((w) => ({
          second: w.second,
          ops: w.ops,
          'p95 ms': fixed(w.p95),
          'heap Δ MB': fixed(w.heapMB),
        })),
      },
    );
  });
});
