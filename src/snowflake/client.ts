import type { StatementOption } from 'snowflake-sdk';
import type { MutationQuery } from '../mutations.js';
import type { SelectQuery, SetQuery } from '../query.js';
import { type InferSelection, resultSchema, type Selection } from '../schema.js';
import { isRawQuery, type RawQuery, type SqlInterpolation, sql } from '../sql.js';
import {
  type DriverConnection,
  type ExecuteOptions,
  request,
  requestSignal,
  streamRequest,
} from './request.js';
import { normalizeWireRow } from './wire.js';

export interface QueryResult<Row> {
  readonly rows: readonly Row[];
  readonly queryId: string;
}
export interface MutationResult {
  readonly queryId: string;
  readonly affectedRows: number;
}
export interface SnowflakeClient {
  execute<S extends Selection, Scope extends string, Nullable extends string>(
    query: SelectQuery<S, Scope, Nullable>,
    options?: ExecuteOptions,
  ): Promise<QueryResult<InferSelection<S, Nullable>>>;
  execute<Row>(query: SetQuery<Row>, options?: ExecuteOptions): Promise<QueryResult<Row>>;
  execute(query: MutationQuery, options?: ExecuteOptions): Promise<MutationResult>;
  queryRaw<T = unknown>(strings: TemplateStringsArray, ...values: SqlInterpolation[]): Promise<T>;
  queryRaw<T = unknown>(query: RawQuery<T>, options?: ExecuteOptions): Promise<T>;
  queryRaw<T = unknown>(query: RawQuery, options?: ExecuteOptions): Promise<T>;
  stream<S extends Selection, Scope extends string, Nullable extends string>(
    query: SelectQuery<S, Scope, Nullable>,
    options?: ExecuteOptions,
  ): AsyncIterable<InferSelection<S, Nullable>>;
  stream<Row>(query: SetQuery<Row>, options?: ExecuteOptions): AsyncIterable<Row>;
  streamRaw<T = unknown>(query: RawQuery, options?: ExecuteOptions): AsyncIterable<T>;
  transaction<T>(callback: (client: SnowflakeClient) => Promise<T>): Promise<T>;
}

type RowQuery = SelectQuery<Selection, string, string> | SetQuery<Record<string, unknown>>;

const unusable = new WeakSet<DriverConnection>();

/** True once a failed ROLLBACK left the connection in an unknown transaction state. */
export function isUnusable(connection: DriverConnection): boolean {
  return unusable.has(connection);
}

/** Uses a connected SDK connection. The caller owns connection lifecycle. */
export function createClient(connection: DriverConnection): SnowflakeClient {
  const schemas = new WeakMap<object, ReturnType<typeof resultSchema>>();
  interface Session {
    readonly requests: Promise<unknown>[];
    closed: boolean;
  }
  let activeSession: Session | undefined;
  const pending = new Set<Promise<unknown>>();
  let streams = 0;
  async function tracked<T>(promise: Promise<T>, session?: Session): Promise<T> {
    pending.add(promise);
    session?.requests.push(promise);
    try {
      return await promise;
    } finally {
      pending.delete(promise);
    }
  }
  function factory(session?: Session): SnowflakeClient {
    function check() {
      if (unusable.has(connection))
        throw new Error(
          'This connection is unusable because a transaction ROLLBACK failed; discard it.',
        );
      if (activeSession && !session)
        throw new Error(
          'This connection is reserved by an active transaction; use its transaction client.',
        );
      if (session && (activeSession !== session || session.closed))
        throw new Error('This transaction client is no longer active.');
    }
    function prepared(query: RowQuery) {
      let schema = schemas.get(query);
      if (!schema) {
        schema = resultSchema(query.selection, query.nullableSources);
        schemas.set(query, schema);
      }
      const validator = schema;
      const keys = Object.keys(query.selection);
      return (row: unknown): unknown => {
        if (!Array.isArray(row) || row.length !== keys.length)
          throw new TypeError('Result row does not match the declared projection width.');
        return validator.parse(Object.fromEntries(keys.map((key, i) => [key, row[i]])));
      };
    }
    const driverOptions = (
      query: { compile(): { sql: string; binds: readonly (string | number | boolean | null)[] } },
      rowMode: 'object' | 'array',
    ): StatementOption => {
      const compiled = query.compile();
      return {
        sqlText: compiled.sql,
        binds: [...compiled.binds],
        rowMode,
        streamResult: false,
        asyncExec: false,
        fetchAsString: ['Number', 'Date', 'JSON'],
        parameters: {
          JS_TREAT_INTEGER_AS_BIGINT: true,
          DATE_OUTPUT_FORMAT: 'YYYY-MM-DD',
          TIME_OUTPUT_FORMAT: 'HH24:MI:SS.FF9',
          TIMESTAMP_NTZ_OUTPUT_FORMAT: 'YYYY-MM-DD HH24:MI:SS.FF9',
          TIMESTAMP_LTZ_OUTPUT_FORMAT: 'YYYY-MM-DD HH24:MI:SS.FF9 TZH:TZM',
          TIMESTAMP_TZ_OUTPUT_FORMAT: 'YYYY-MM-DD HH24:MI:SS.FF9 TZH:TZM',
        },
      };
    };
    async function execute(
      query: RowQuery | MutationQuery,
      options: ExecuteOptions = {},
    ): Promise<QueryResult<unknown> | MutationResult> {
      check();
      const decode = query.kind === 'mutation' ? undefined : prepared(query);
      const result = await request(
        connection,
        driverOptions(query, 'array'),
        requestSignal(options),
      );
      if (!decode)
        return {
          queryId: result.statement.getQueryId(),
          affectedRows: result.statement.getNumUpdatedRows() ?? 0,
        };
      if (!result.rows) throw new TypeError('Expected a SELECT result set.');
      return {
        rows: result.rows.map((row) => decode(normalizeWireRow(row, result.statement))),
        queryId: result.statement.getQueryId(),
      };
    }
    return Object.freeze({
      execute: (query: RowQuery | MutationQuery, options?: ExecuteOptions) =>
        tracked(execute(query, options), session),
      async queryRaw<T = unknown>(
        input: TemplateStringsArray | RawQuery<T>,
        ...values: SqlInterpolation[] | [ExecuteOptions?]
      ): Promise<T> {
        check();
        const raw = isRawQuery(input);
        const query = raw ? input : sql<T>(input, ...(values as SqlInterpolation[]));
        const options = (raw ? values[0] : undefined) as ExecuteOptions | undefined;
        return tracked(
          request(connection, driverOptions(query, 'object'), requestSignal(options ?? {})).then(
            (result) => result.rows?.map((row) => normalizeWireRow(row, result.statement)) as T,
          ),
          session,
        );
      },
      async *stream(query: RowQuery, options: ExecuteOptions = {}) {
        check();
        const decode = prepared(query);
        streams++;
        try {
          for await (const { row, statement } of streamRequest(
            connection,
            driverOptions(query, 'array'),
            requestSignal(options),
          ))
            yield decode(normalizeWireRow(row, statement));
        } finally {
          streams--;
        }
      },
      async *streamRaw<T = unknown>(
        query: RawQuery,
        options: ExecuteOptions = {},
      ): AsyncGenerator<T> {
        check();
        streams++;
        try {
          for await (const { row, statement } of streamRequest(
            connection,
            driverOptions(query, 'object'),
            requestSignal(options),
          ))
            yield normalizeWireRow(row, statement) as T;
        } finally {
          streams--;
        }
      },
      async transaction<T>(callback: (client: SnowflakeClient) => Promise<T>): Promise<T> {
        check();
        if (session) throw new Error('Nested transactions are not supported by this client.');
        if (pending.size || streams)
          throw new Error('Await running queries and close streams before starting a transaction.');
        const current: Session = { requests: [], closed: false };
        activeSession = current;
        const tx = factory(current);
        try {
          await request(connection, driverOptions(sql`BEGIN`, 'object'));
          let value: T;
          try {
            value = await callback(tx);
            current.closed = true;
            await Promise.all(current.requests);
            await request(connection, driverOptions(sql`COMMIT`, 'object'));
          } catch (error) {
            current.closed = true;
            await Promise.allSettled(current.requests);
            try {
              await request(connection, driverOptions(sql`ROLLBACK`, 'object'));
            } catch (rollback) {
              unusable.add(connection);
              throw new AggregateError(
                [error, rollback],
                'Transaction failed and rollback also failed.',
              );
            }
            throw error;
          }
          return value;
        } finally {
          current.closed = true;
          activeSession = undefined;
        }
      },
    }) as SnowflakeClient;
  }
  return factory();
}
