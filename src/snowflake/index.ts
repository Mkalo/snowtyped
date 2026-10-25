/**
 * Executes Snowtyped queries through `snowflake-sdk`: a client for an existing connection, and a
 * pool. Both validate rows, stream results, run transactions, and cancel statements. See
 * [execution](/guides/execution/).
 *
 * @example
 * ```ts
 * import { createClient } from 'snowtyped/snowflake';
 *
 * const db = createClient(connection);
 * const { rows } = await db.execute(select(customers));
 * ```
 * @module
 */
export { createClient } from './client.js';
export type * from './deprecated-types.js';
export { createPool } from './pool.js';
