import type { Connection, RowStatement, StatementOption } from 'snowflake-sdk';

export interface ExecuteOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}
export type DriverConnection = Pick<Connection, 'execute'>;
export interface DriverResult {
  readonly statement: RowStatement;
  readonly rows: readonly unknown[] | undefined;
}

export function requestSignal(options: ExecuteOptions): AbortSignal | undefined {
  if (options.timeoutMs === undefined) return options.signal;
  const timeout = AbortSignal.timeout(options.timeoutMs);
  return options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
}

/** Resolve cancellation only after the SDK acknowledges it, so a pool lease is not released early. */
export function request(
  connection: DriverConnection,
  options: StatementOption,
  signal?: AbortSignal,
): Promise<DriverResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    let statement: RowStatement;
    let settled = false;
    let cancelling = false;
    function cleanup() {
      signal?.removeEventListener('abort', abort);
    }
    function fail(error: unknown) {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    }
    function abort() {
      cancelling = true;
      try {
        statement.cancel((error) =>
          fail(
            error
              ? new AggregateError([signal?.reason, error], 'Query cancellation failed.')
              : signal?.reason,
          ),
        );
      } catch (error) {
        fail(error);
      }
    }
    try {
      statement = connection.execute({
        ...options,
        complete(error, completed, rows) {
          if (settled || cancelling) return;
          if (error) {
            fail(error);
            return;
          }
          settled = true;
          cleanup();
          resolve({ statement: completed, rows });
        },
      });
      if (!settled) {
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      }
    } catch (error) {
      fail(error);
    }
  });
}

export async function* streamRequest(
  connection: DriverConnection,
  options: StatementOption,
  signal?: AbortSignal,
): AsyncGenerator<{ readonly row: unknown; readonly statement: RowStatement }> {
  const { statement } = await request(connection, { ...options, streamResult: true }, signal);
  const readable = statement.streamRows({ fetchAsString: ['Number', 'Date', 'JSON'] });
  const abort = () =>
    readable.destroy(
      signal?.reason instanceof Error
        ? signal.reason
        : new Error('Stream aborted.', { cause: signal?.reason }),
    );
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  try {
    for await (const row of readable) yield { row, statement };
  } finally {
    signal?.removeEventListener('abort', abort);
    readable.destroy();
  }
}
