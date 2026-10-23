import type { ConnectionOptions } from 'snowflake-sdk';
import type { MutationQuery } from '../mutations.js';
import type { SelectQuery } from '../query.js';
import type { Selection } from '../schema.js';
import { isRawQuery, type RawQuery, type SqlInterpolation } from '../sql.js';
import { createClient, type SnowflakeClient } from './client.js';
import type { ExecuteOptions } from './request.js';

export interface PoolOptions {
  readonly min?: number;
  readonly max?: number;
  readonly acquireTimeoutMillis?: number;
  readonly idleTimeoutMillis?: number;
  readonly evictionRunIntervalMillis?: number;
}
export interface PooledClient extends SnowflakeClient {
  close(): Promise<void>;
}

export async function createPool(
  connectionOptions: ConnectionOptions,
  options: PoolOptions = {},
): Promise<PooledClient> {
  const sdk = (await import('snowflake-sdk')).default;
  const pool = sdk.createPool(connectionOptions, { min: 0, max: 5, ...options });
  let closed = false;
  function check() {
    if (closed) throw new Error('This Snowflake pool is closed.');
  }
  async function use<T>(callback: (client: SnowflakeClient) => Promise<T>): Promise<T> {
    check();
    const connection = await pool.acquire();
    try {
      return await callback(createClient(connection));
    } finally {
      await pool.release(connection);
    }
  }
  return Object.freeze({
    execute: (
      query: SelectQuery<Selection, string, string> | MutationQuery,
      executeOptions?: ExecuteOptions,
    ) =>
      use<unknown>((client) =>
        query.kind === 'select'
          ? client.execute(query, executeOptions)
          : client.execute(query, executeOptions),
      ),
    queryRaw<T = unknown>(
      input: TemplateStringsArray | RawQuery<T>,
      ...values: SqlInterpolation[] | [ExecuteOptions?]
    ) {
      return use((client) =>
        isRawQuery(input)
          ? client.queryRaw<T>(input as RawQuery<T>, values[0] as ExecuteOptions | undefined)
          : client.queryRaw<T>(input, ...(values as SqlInterpolation[])),
      );
    },
    async *stream(query: SelectQuery<Selection, string, string>, executeOptions?: ExecuteOptions) {
      check();
      const connection = await pool.acquire();
      try {
        yield* createClient(connection).stream(query, executeOptions);
      } finally {
        await pool.release(connection);
      }
    },
    async *streamRaw<T = unknown>(query: RawQuery, executeOptions?: ExecuteOptions) {
      check();
      const connection = await pool.acquire();
      try {
        yield* createClient(connection).streamRaw<T>(query, executeOptions);
      } finally {
        await pool.release(connection);
      }
    },
    transaction: <T>(callback: (client: SnowflakeClient) => Promise<T>) =>
      use((client) => client.transaction(callback)),
    async close() {
      if (closed) return;
      closed = true;
      await pool.drain();
      await pool.clear();
    },
  }) as PooledClient;
}
