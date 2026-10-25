import type { Connection, ConnectionOptions } from 'snowflake-sdk';
import type { MutationQuery } from '../mutations.js';
import type { SelectQuery, SetQuery } from '../query.js';
import type { LoadedQuery } from '../relations.js';
import type { Projection } from '../schema.js';
import { isRawQuery, type RawQuery, type SqlInterpolation } from '../sql.js';
import { createClient, isUnusable, type SnowflakeClient } from './client.js';
import { type ExecuteOptions, requestSignal } from './request.js';

/** Options of {@link createPool}, passed to the `snowflake-sdk` pool. */
export interface PoolOptions {
  /** The number of connections kept open. Defaults to 0. */
  readonly min?: number;
  /**
   * The most connections open at once. Defaults to 5. A transaction or stream holds one for its
   * duration.
   */
  readonly max?: number;
  /** How long a request waits for a connection before it fails. Waits are unbounded by default. */
  readonly acquireTimeoutMillis?: number;
  /** How long a connection can stay idle before eviction closes it. */
  readonly idleTimeoutMillis?: number;
  /**
   * How often idle connections are evicted. Without it, idle connections stay open until `close()`.
   */
  readonly evictionRunIntervalMillis?: number;
  /**
   * Heartbeats each connection before lending it and replaces a terminated one. Costs one round
   * trip per acquire.
   */
  readonly testOnBorrow?: boolean;
}
/**
 * A {@link SnowflakeClient} that borrows a pooled connection for each request, and pins one for a
 * whole transaction or stream.
 */
export interface PooledClient extends SnowflakeClient {
  /**
   * Rejects new work, waits for running and queued operations, including unfinished streams, and
   * then closes every connection.
   */
  close(): Promise<void>;
}

/**
 * Creates a connection pool with the `snowflake-sdk` pool, loading `snowflake-sdk` only when
 * called.
 *
 * A connection whose session has terminated is destroyed instead of being lent again. A pooled
 * request's `signal` and `timeoutMs` also cover the wait for a connection. Always `close()` the
 * pool.
 *
 * @example
 * ```ts
 * const pool = await createPool(connectionOptions, { max: 8, acquireTimeoutMillis: 10_000 });
 * try {
 *   await pool.execute(select(customers));
 * } finally {
 *   await pool.close();
 * }
 * ```
 */
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
      query:
        | SelectQuery<Projection, string, string>
        | SetQuery<Record<string, unknown>>
        | LoadedQuery<unknown>
        | MutationQuery,
      executeOptions?: ExecuteOptions,
    ) =>
      use<unknown>(
        (client, options) =>
          query.kind === 'select'
            ? client.execute(query, options)
            : query.kind === 'set'
              ? client.execute(query, options)
              : query.kind === 'loaded'
                ? client.execute(query, options)
                : client.execute(query, options),
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
    async *stream(
      query:
        | SelectQuery<Projection, string, string>
        | SetQuery<Record<string, unknown>>
        | LoadedQuery<unknown>,
      executeOptions?: ExecuteOptions,
    ) {
      const signal = requestSignal(executeOptions ?? {});
      const connection = await acquire(signal);
      try {
        const client = createClient(connection);
        const options = signal ? { signal } : {};
        yield* query.kind === 'select'
          ? client.stream(query, options)
          : query.kind === 'set'
            ? client.stream(query, options)
            : client.stream(query, options);
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
