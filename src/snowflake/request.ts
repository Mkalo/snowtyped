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

/** Snowflake rejects a cancel that reaches it before the statement is registered. */
const NOT_EXECUTING = '000605';
const MAX_CANCEL_RETRY_MS = 1000;

/**
 * Resolve cancellation only after the SDK acknowledges it, so a pool lease is not released early.
 * A cancel that never takes effect settles with the statement's real outcome instead.
 */
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
    let retry: ReturnType<typeof setTimeout> | undefined;
    function cleanup() {
      clearTimeout(retry);
      signal?.removeEventListener('abort', abort);
    }
    function fail(error: unknown) {
      settled = true;
      cleanup();
      reject(error);
    }
    function cancel(attempt: number) {
      try {
        statement.cancel((error) => {
          if (settled) return;
          if (!error) fail(signal?.reason);
          else if (String(error.code) === NOT_EXECUTING)
            retry = setTimeout(
              cancel,
              Math.min(50 * 2 ** attempt, MAX_CANCEL_RETRY_MS),
              attempt + 1,
            );
        });
      } catch {
        // Without a working cancel, the completion callback still reports the real outcome.
      }
    }
    function abort() {
      cancelling = true;
      cancel(0);
    }
    try {
      statement = connection.execute({
        ...options,
        complete(error, completed, rows) {
          if (settled) return;
          if (error) {
            fail(cancelling ? signal?.reason : error);
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
