import type { Connection, ConnectionOptions } from 'snowflake-sdk';
import type { MutationQuery } from '../mutations.js';
import type { SelectQuery } from '../query.js';
import type { Selection } from '../schema.js';
import { isRawQuery, type RawQuery, type SqlInterpolation } from '../sql.js';
import { createClient, isUnusable, type SnowflakeClient } from './client.js';
import { type ExecuteOptions, requestSignal } from './request.js';

export interface PoolOptions {
  readonly min?: number;
  readonly max?: number;
  readonly acquireTimeoutMillis?: number;
  readonly idleTimeoutMillis?: number;
  readonly evictionRunIntervalMillis?: number;
  /** Heartbeat each connection before lending it; costs one round trip per acquire. */
  readonly testOnBorrow?: boolean;
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
  let closing: Promise<void> | undefined;
  function check() {
    if (closing) throw new Error('This Snowflake pool is closed.');
  }
  /** A terminated session would fail every later lease, so it leaves the pool. */
  async function release(connection: Connection) {
    await (isUnusable(connection) || !connection.isUp()
      ? pool.destroy(connection)
      : pool.release(connection));
  }
  /** Stops waiting on abort; a connection granted after that goes straight back to the pool. */
  function acquire(signal: AbortSignal | undefined): Promise<Connection> {
    check();
    signal?.throwIfAborted();
    const lease = pool.acquire();
    if (!signal) return lease;
    return new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      lease.then(
        (connection) => {
          signal.removeEventListener('abort', abort);
          if (signal.aborted) release(connection).catch(() => {});
          else resolve(connection);
        },
        (error: unknown) => {
          signal.removeEventListener('abort', abort);
          reject(error);
        },
      );
    });
  }
  async function use<T>(
    callback: (client: SnowflakeClient, options: ExecuteOptions) => Promise<T>,
    executeOptions: ExecuteOptions = {},
  ): Promise<T> {
    const signal = requestSignal(executeOptions);
    const connection = await acquire(signal);
    try {
      return await callback(createClient(connection), signal ? { signal } : {});
    } finally {
      await release(connection);
    }
  }
  return Object.freeze({
    execute: (
      query: SelectQuery<Selection, string, string> | MutationQuery,
      executeOptions?: ExecuteOptions,
    ) =>
      use<unknown>(
        (client, options) =>
          query.kind === 'select' ? client.execute(query, options) : client.execute(query, options),
        executeOptions,
      ),
    queryRaw<T = unknown>(
      input: TemplateStringsArray | RawQuery<T>,
      ...values: SqlInterpolation[] | [ExecuteOptions?]
    ) {
      const options = isRawQuery(input) ? (values[0] as ExecuteOptions | undefined) : undefined;
      return use(
        (client, requestOptions) =>
          isRawQuery(input)
            ? client.queryRaw<T>(input as RawQuery<T>, requestOptions)
            : client.queryRaw<T>(input, ...(values as SqlInterpolation[])),
        options,
      );
    },
    async *stream(query: SelectQuery<Selection, string, string>, executeOptions?: ExecuteOptions) {
      const signal = requestSignal(executeOptions ?? {});
      const connection = await acquire(signal);
      try {
        yield* createClient(connection).stream(query, signal ? { signal } : {});
      } finally {
        await release(connection);
      }
    },
    async *streamRaw<T = unknown>(query: RawQuery, executeOptions?: ExecuteOptions) {
      const signal = requestSignal(executeOptions ?? {});
      const connection = await acquire(signal);
      try {
        yield* createClient(connection).streamRaw<T>(query, signal ? { signal } : {});
      } finally {
        await release(connection);
      }
    },
    transaction: <T>(callback: (client: SnowflakeClient) => Promise<T>) =>
      use((client) => client.transaction(callback)),
    close() {
      closing ??= pool.drain().then(() => pool.clear());
      return closing;
    },
  }) as PooledClient;
}
