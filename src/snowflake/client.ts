import type { StatementOption } from 'snowflake-sdk';
import type * as z from 'zod';
import type { MutationQuery } from '../mutations.js';
import type { SelectQuery, SetQuery } from '../query.js';
import { type LoadedQuery, run, stream as streamLoaded } from '../relations.js';
import {
  type InferSelection,
  type Projection,
  projectionLeaves,
  projectionRow,
  resultSchema,
} from '../schema.js';
import { isRawQuery, type RawQuery, type SqlInterpolation, sql } from '../sql.js';
import type { createPool } from './pool.js';
import {
  type DriverConnection,
  type ExecuteOptions,
  request,
  requestSignal,
  streamRequest,
} from './request.js';
import { normalizeWireRow } from './wire.js';

/** The result of executing a query: its validated rows and Snowflake query ID. */
export interface QueryResult<Row> {
  /** The rows, decoded and validated against the declared columns. */
  readonly rows: readonly Row[];
  /** The Snowflake query ID of the statement. */
  readonly queryId: string;
}
/** The result of executing a query with relations. */
export interface LoadedResult<Row> extends QueryResult<Row> {
  /** The parent query's ID first, then each related query's in execution order. */
  readonly queryIds: readonly string[];
}
/** The result of executing an INSERT, UPDATE, DELETE, or MERGE. */
export interface MutationResult {
  /** The Snowflake query ID of the statement. */
  readonly queryId: string;
  /** The number of rows the statement inserted, updated, or deleted. */
  readonly affectedRows: number;
}
/**
 * Executes Snowtyped queries on a `snowflake-sdk` connection. Created by {@link createClient}, or
 * pooled by {@link createPool}.
 *
 * Queries are never retried implicitly. `execute`, `stream`, `streamRaw`, and `queryRaw(query,
 * options)` accept a `signal` and a `timeoutMs` deadline, which cancel the statement in Snowflake.
 */
export interface SnowflakeClient {
  /**
   * Executes a query and returns its rows, validated against the declared columns, and its query
   * ID.
   *
   * @throws When a returned value does not match the declared schema, or Snowflake rejects the
   * statement.
   * @example
   * ```ts
   * const { rows, queryId } = await db.execute(select(customers), { timeoutMs: 5_000 });
   * ```
   */
  execute<S extends Projection, Scope extends string, Nullable extends string>(
    query: SelectQuery<S, Scope, Nullable>,
    options?: ExecuteOptions,
  ): Promise<QueryResult<InferSelection<S, Nullable>>>;
  /** Executes a combined query and returns its validated rows and query ID. */
  execute<Row>(query: SetQuery<Row>, options?: ExecuteOptions): Promise<QueryResult<Row>>;
  /**
   * Executes a query with relations. `queryIds` lists the parent statement first, then each related
   * query in execution order.
   */
  execute<Row>(query: LoadedQuery<Row>, options?: ExecuteOptions): Promise<LoadedResult<Row>>;
  /**
   * Executes an INSERT, UPDATE, DELETE, or MERGE and returns the affected row count and query ID.
   */
  execute(query: MutationQuery, options?: ExecuteOptions): Promise<MutationResult>;
  /**
   * Runs a tagged SQL template. Interpolated values become bind parameters.
   *
   * `T` asserts the entire result, an array of rows, and is not validated. Numbers, temporal
   * values, and semi-structured values are returned as strings.
   *
   * @example
   * ```ts
   * const name = 'Ada';
   * const rows = await db.queryRaw<Array<{ ID: string }>>`
   *   SELECT ID FROM CUSTOMERS WHERE NAME = ${name}
   * `;
   * ```
   */
  queryRaw<T = unknown>(strings: TemplateStringsArray, ...values: SqlInterpolation[]): Promise<T>;
  /** Runs a fragment built with the `sql` tag, typed by the fragment's asserted result. */
  queryRaw<T = unknown>(query: RawQuery<T>, options?: ExecuteOptions): Promise<T>;
  /**
   * Runs a fragment built with the `sql` tag. `T` asserts the entire result and is not validated.
   */
  queryRaw<T = unknown>(query: RawQuery, options?: ExecuteOptions): Promise<T>;
  /**
   * Streams a query's rows, validating each one. Breaking out of the loop destroys the row stream.
   *
   * @example
   * ```ts
   * for await (const row of db.stream(select(customers))) {
   *   console.log(row.name);
   * }
   * ```
   */
  stream<S extends Projection, Scope extends string, Nullable extends string>(
    query: SelectQuery<S, Scope, Nullable>,
    options?: ExecuteOptions,
  ): AsyncIterable<InferSelection<S, Nullable>>;
  /** Streams a combined query's rows, validating each one. */
  stream<Row>(query: SetQuery<Row>, options?: ExecuteOptions): AsyncIterable<Row>;
  /**
   * Streams a query with relations. Parents are read in batches of the relation `batchSize`, and
   * each batch's children are loaded before it is yielded.
   */
  stream<Row>(query: LoadedQuery<Row>, options?: ExecuteOptions): AsyncIterable<Row>;
  /** Streams the rows of a `sql` fragment. `T` asserts each row's type and is not validated. */
  streamRaw<T = unknown>(query: RawQuery, options?: ExecuteOptions): AsyncIterable<T>;
  /**
   * Runs `callback` in a transaction: COMMIT when it resolves and ROLLBACK when it rejects.
   *
   * Use the client the callback receives, and await its queries and finish its streams before
   * returning. While the transaction runs, the outer client rejects new queries. Nested
   * transactions are not supported, and Snowflake DDL can commit on its own.
   *
   * @throws `AggregateError` with both failures when ROLLBACK itself fails. The client then rejects
   * every later operation, so replace the connection.
   * @example
   * ```ts
   * await db.transaction(async (tx) => {
   *   await tx.execute(insert(customers, { id: 2n, name: 'Grace' }));
   *   await tx.execute(update(customers, { email: null }).where(eq(customers.columns.id, 2n)));
   * });
   * ```
   */
  transaction<T>(callback: (client: SnowflakeClient) => Promise<T>): Promise<T>;
}

type RowQuery = SelectQuery<Projection, string, string> | SetQuery<Record<string, unknown>>;

const unusable = new WeakSet<DriverConnection>();

/** True once a failed ROLLBACK left the connection in an unknown transaction state. */
export function isUnusable(connection: DriverConnection): boolean {
  return unusable.has(connection);
}

/**
 * Wraps a connected `snowflake-sdk` connection. Connecting and destroying the connection stay with
 * the caller.
 *
 * @example
 * ```ts
 * import { createClient } from 'snowtyped/snowflake';
 *
 * // connection is a connected snowflake-sdk Connection.
 * const db = createClient(connection);
 * ```
 */
export function createClient(connection: DriverConnection): SnowflakeClient {
  const schemas = new WeakMap<object, z.ZodType>();
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
        schema = resultSchema(query.selection as Projection, query.nullableSources) as z.ZodType;
        schemas.set(query, schema);
      }
      const validator = schema;
      const width = projectionLeaves(query.selection).length;
      const shape = projectionRow(query.selection);
      return (row: unknown): unknown => {
        if (!Array.isArray(row) || row.length !== width)
          throw new TypeError('Result row does not match the declared projection width.');
        return validator.parse(shape(row));
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
    async function* rows(query: RowQuery, options: ExecuteOptions) {
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
    }
    async function load(query: LoadedQuery<unknown>, options: ExecuteOptions) {
      check();
      const result = await run(
        query,
        (item) => execute(item, options) as Promise<QueryResult<unknown>>,
      );
      return {
        rows: result.rows,
        queryId: result.queryIds[0] as string,
        queryIds: result.queryIds,
      };
    }
    return Object.freeze({
      execute: (query: RowQuery | MutationQuery | LoadedQuery<unknown>, options?: ExecuteOptions) =>
        tracked(
          query.kind === 'loaded' ? load(query, options ?? {}) : execute(query, options),
          session,
        ),
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
      stream(query: RowQuery | LoadedQuery<unknown>, options: ExecuteOptions = {}) {
        if (query.kind !== 'loaded') return rows(query, options);
        check();
        return streamLoaded(
          query,
          (parent) => rows(parent, options),
          (child) => execute(child, options) as Promise<QueryResult<unknown>>,
        );
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
    }) as unknown as SnowflakeClient;
  }
  return factory();
}
