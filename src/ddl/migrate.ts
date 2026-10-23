import * as z from 'zod';
import { type IdentifierNode, identifier } from '../ast.js';
import type { SnowflakeClient } from '../snowflake/client.js';
import { isRawQuery, type RawQuery, sql } from '../sql.js';
import type { SchemaDefinition, TableDefinition } from './definition.js';
import { diffSchema, type SchemaDiff } from './diff.js';
import { inspectSchema } from './inspect.js';
import { createSchema, createTable, type DdlStatement, isDdlStatement } from './statements.js';
import { type PhysicalType, sqlType } from './types.js';

type Client = Pick<SnowflakeClient, 'queryRaw'>;

export interface Migration {
  readonly id: string;
  readonly statements: readonly (DdlStatement | RawQuery)[];
  /** Acknowledges destructive DDL statements. Raw SQL is never classified. */
  readonly destructive?: boolean;
}
export interface MigrationTarget {
  readonly database: string;
  readonly schema: string;
  /** Defaults to SNOWTYPED_MIGRATIONS; the lock table adds a _LOCK suffix. */
  readonly historyTable?: string;
}
export interface MigrateOptions extends MigrationTarget {
  /** Continue a failed or interrupted migration after its last committed statement. */
  readonly resumeFailed?: boolean;
  /** Lock lease, renewed before each statement. Must exceed the longest statement. */
  readonly leaseSeconds?: number;
  /** Compares this desired schema with the database after migrating. */
  readonly verify?: SchemaDefinition;
}
export interface MigrateResult {
  readonly applied: readonly string[];
  readonly drift?: SchemaDiff;
}
export interface IncompleteMigration {
  readonly id: string;
  readonly status: 'running' | 'failed';
  readonly appliedStatements: number;
  readonly statements: number;
  readonly error: string | null;
}
export interface MigrationStatus {
  readonly applied: readonly string[];
  readonly pending: readonly string[];
  readonly incomplete?: IncompleteMigration;
}
export type MigrationErrorCode =
  | 'INVALID'
  | 'DESTRUCTIVE'
  | 'UNSUPPORTED'
  | 'LOCKED'
  | 'LOCK_LOST'
  | 'HISTORY_DRIFT'
  | 'FAILED';
export class MigrationError extends Error {
  override readonly name = 'MigrationError';
  readonly code: MigrationErrorCode;
  readonly migration: string | undefined;
  constructor(
    code: MigrationErrorCode,
    message: string,
    options: { readonly migration?: string; readonly cause?: unknown } = {},
  ) {
    super(message, 'cause' in options ? { cause: options.cause } : undefined);
    this.code = code;
    this.migration = options.migration;
  }
}

interface Planned {
  readonly id: string;
  readonly queries: readonly RawQuery[];
  readonly hashes: readonly string[];
  readonly checksum: string;
}
async function digest(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
function plan(migrations: readonly Migration[]): Promise<Planned[]> {
  const ids = new Set<string>();
  const checked = migrations.map((migration) => {
    if (!migration.id || ids.has(migration.id))
      throw new MigrationError('INVALID', `Migration ids must be unique and non-empty.`, {
        migration: migration.id,
      });
    ids.add(migration.id);
    if (!migration.statements.length)
      throw new MigrationError('INVALID', `Migration ${migration.id} has no statements.`, {
        migration: migration.id,
      });
    const queries = migration.statements.map((entry) => {
      if (isDdlStatement(entry)) {
        if (entry.destructive && !migration.destructive)
          throw new MigrationError(
            'DESTRUCTIVE',
            `Migration ${migration.id} contains a destructive statement; set destructive: true to allow it.`,
            { migration: migration.id },
          );
        return sql.unsafe(entry.compile().sql);
      }
      if (isRawQuery(entry)) return entry;
      throw new MigrationError('INVALID', `Migration ${migration.id} has an invalid statement.`, {
        migration: migration.id,
      });
    });
    return { id: migration.id, queries };
  });
  return Promise.all(
    checked.map(async ({ id, queries }) => {
      const hashes = await Promise.all(
        queries.map((query) => {
          const compiled = query.compile();
          return digest(JSON.stringify([compiled.sql, compiled.binds]));
        }),
      );
      return { id, queries, hashes, checksum: await digest(hashes.join('\n')) };
    }),
  );
}

const count = z.string().regex(/^\d+$/).transform(Number);
const parsers = () => ({
  history: z.compile(
    z.array(
      z.object({
        ID: z.string(),
        ORDINAL: count,
        CHECKSUM: z.string(),
        STATEMENT_CHECKSUMS: z
          .string()
          .transform((value) => JSON.parse(value) as unknown)
          .pipe(z.array(z.string())),
        STATUS: z.enum(['running', 'failed', 'applied']),
        STATEMENTS: count,
        APPLIED_STATEMENTS: count,
        ERROR: z.string().nullable(),
      }),
    ),
  ),
  updated: z.compile(z.tuple([z.object({ 'number of rows updated': count })])),
  rows: z.compile(z.array(z.unknown())),
});
type HistoryRow = z.infer<ReturnType<typeof parsers>['history']>[number];

function names(target: MigrationTarget) {
  const table = target.historyTable ?? 'SNOWTYPED_MIGRATIONS';
  return {
    table,
    lockTable: `${table}_LOCK`,
    history: identifier(target.database, target.schema, table),
    lock: identifier(target.database, target.schema, `${table}_LOCK`),
  };
}
function definition(name: IdentifierNode, columns: [string, PhysicalType, boolean][]) {
  return Object.freeze({
    kind: 'table-definition',
    name,
    columns: columns.map(([column, type, notNull]) => ({
      key: column,
      name: column,
      type,
      notNull,
    })),
  }) satisfies TableDefinition;
}
async function exists(client: Client, target: MigrationTarget, table?: string): Promise<boolean> {
  const view = sql.identifier(target.database, 'INFORMATION_SCHEMA', table ? 'TABLES' : 'SCHEMATA');
  const rows = parsers().rows.parse(
    await client.queryRaw(
      table
        ? sql`SELECT 1 FROM ${view} WHERE TABLE_SCHEMA = ${target.schema} AND TABLE_NAME = ${table}`
        : sql`SELECT 1 FROM ${view} WHERE SCHEMA_NAME = ${target.schema}`,
    ),
  );
  return rows.length > 0;
}
async function readHistory(client: Client, history: IdentifierNode): Promise<HistoryRow[]> {
  return parsers().history.parse(
    await client.queryRaw(
      sql`SELECT ID, ORDINAL, CHECKSUM, STATEMENT_CHECKSUMS, STATUS, STATEMENTS, APPLIED_STATEMENTS, ERROR FROM ${sql.identifier(...(history.parts as [string, ...string[]]))} ORDER BY ORDINAL`,
    ),
  );
}

/** Applied history must be an unchanged prefix of the declared migrations. */
function reconcile(planned: readonly Planned[], rows: readonly HistoryRow[]) {
  const drift = (message: string, migration: string) =>
    new MigrationError('HISTORY_DRIFT', message, { migration });
  rows.forEach((row, index) => {
    const migration = planned[index];
    if (row.ORDINAL !== index || migration?.id !== row.ID)
      throw drift(
        `Recorded migration ${row.ID} is missing or out of order in the declared migrations.`,
        row.ID,
      );
    if (row.STATUS === 'applied') {
      if (row.CHECKSUM !== migration.checksum)
        throw drift(`Migration ${row.ID} changed after it was applied.`, row.ID);
    } else if (index !== rows.length - 1) {
      throw drift(
        `Migration ${row.ID} is ${row.STATUS} but later migrations are recorded.`,
        row.ID,
      );
    } else if (
      row.APPLIED_STATEMENTS > migration.hashes.length ||
      row.STATEMENT_CHECKSUMS.slice(0, row.APPLIED_STATEMENTS).some(
        (hash, position) => hash !== migration.hashes[position],
      )
    ) {
      throw drift(`Statements already committed by migration ${row.ID} changed.`, row.ID);
    }
  });
  const last = rows.at(-1);
  const incomplete: IncompleteMigration | undefined =
    last && last.STATUS !== 'applied'
      ? Object.freeze({
          id: last.ID,
          status: last.STATUS,
          appliedStatements: last.APPLIED_STATEMENTS,
          statements: last.STATEMENTS,
          error: last.ERROR,
        })
      : undefined;
  return { done: rows.length - (incomplete ? 1 : 0), incomplete };
}

/** Reports applied, pending, and incomplete migrations without taking the lock. */
export async function migrationStatus(
  client: Client,
  migrations: readonly Migration[],
  target: MigrationTarget,
): Promise<MigrationStatus> {
  const planned = await plan(migrations);
  const { table, history } = names(target);
  const rows = (await exists(client, target, table)) ? await readHistory(client, history) : [];
  const { done, incomplete } = reconcile(planned, rows);
  return Object.freeze({
    applied: Object.freeze(planned.slice(0, done).map((entry) => entry.id)),
    pending: Object.freeze(planned.slice(done + (incomplete ? 1 : 0)).map((entry) => entry.id)),
    ...(incomplete ? { incomplete } : {}),
  });
}

/**
 * Applies pending migrations in declaration order under a lease lock. Snowflake commits each DDL
 * statement separately, so progress is recorded per statement and a failure leaves earlier
 * statements committed.
 */
export async function migrate(
  client: Client,
  migrations: readonly Migration[],
  options: MigrateOptions,
): Promise<MigrateResult> {
  const lease = options.leaseSeconds ?? 900;
  if (!Number.isSafeInteger(lease) || lease < 1 || lease > 604_800)
    throw new MigrationError('INVALID', 'leaseSeconds must be an integer from 1 to 604800.');
  const planned = await plan(migrations);
  const { history, lock } = names(options);
  const historyName = sql.identifier(...(history.parts as [string, ...string[]]));
  const lockName = sql.identifier(...(lock.parts as [string, ...string[]]));
  if (!(await exists(client, options)))
    await client.queryRaw(
      sql.unsafe(
        createSchema(identifier(options.database, options.schema), {
          ifNotExists: true,
        }).compile().sql,
      ),
    );
  const text = sqlType.varchar();
  const integer = sqlType.number();
  const timestamp = sqlType.timestamp('ltz');
  for (const table of [
    definition(history, [
      ['ID', text, true],
      ['ORDINAL', integer, true],
      ['CHECKSUM', text, true],
      ['STATEMENT_CHECKSUMS', text, true],
      ['STATUS', text, true],
      ['STATEMENTS', integer, true],
      ['APPLIED_STATEMENTS', integer, true],
      ['OWNER', text, true],
      ['STARTED_AT', timestamp, true],
      ['FINISHED_AT', timestamp, false],
      ['ERROR', text, false],
    ]),
    definition(lock, [
      ['ID', integer, true],
      ['OWNER', text, false],
      ['EXPIRES_AT', timestamp, false],
    ]),
  ])
    await client.queryRaw(sql.unsafe(createTable(table, { ifNotExists: true }).compile().sql));
  await client.queryRaw(
    sql`MERGE INTO ${lockName} AS "L" USING (SELECT 1 AS "ID") AS "S" ON "L"."ID" = "S"."ID" WHEN NOT MATCHED THEN INSERT ("ID") VALUES ("S"."ID")`,
  );
  const owner = crypto.randomUUID();
  const updated = async (query: RawQuery) =>
    parsers().updated.parse(await client.queryRaw(query))[0]['number of rows updated'];
  const expiry = sql`DATEADD(SECOND, ${lease}, CURRENT_TIMESTAMP())`;
  if (
    !(await updated(
      sql`UPDATE ${lockName} SET "OWNER" = ${owner}, "EXPIRES_AT" = ${expiry} WHERE "ID" = 1 AND ("OWNER" IS NULL OR "EXPIRES_AT" <= CURRENT_TIMESTAMP())`,
    ))
  )
    throw new MigrationError('LOCKED', 'Another migration run holds the migration lock.');
  const applied: string[] = [];
  async function run() {
    const { done, incomplete } = reconcile(planned, await readHistory(client, history));
    if (incomplete && !options.resumeFailed)
      throw new MigrationError(
        'FAILED',
        `Migration ${incomplete.id} ${incomplete.status === 'running' ? 'was interrupted' : 'failed'} after ${incomplete.appliedStatements} of ${incomplete.statements} statements${incomplete.error === null ? '' : `: ${incomplete.error}`}. Committed statements stay applied; fix the remaining statements and rerun with resumeFailed.`,
        { migration: incomplete.id },
      );
    for (let index = done; index < planned.length; index++) {
      const migration = planned[index] as Planned;
      const resume = index === done ? incomplete?.appliedStatements : undefined;
      const checksums = JSON.stringify(migration.hashes);
      await client.queryRaw(
        resume === undefined
          ? sql`INSERT INTO ${historyName} ("ID", "ORDINAL", "CHECKSUM", "STATEMENT_CHECKSUMS", "STATUS", "STATEMENTS", "APPLIED_STATEMENTS", "OWNER", "STARTED_AT") SELECT ${migration.id}, ${index}, ${migration.checksum}, ${checksums}, 'running', ${migration.queries.length}, 0, ${owner}, CURRENT_TIMESTAMP()`
          : sql`UPDATE ${historyName} SET "CHECKSUM" = ${migration.checksum}, "STATEMENT_CHECKSUMS" = ${checksums}, "STATUS" = 'running', "STATEMENTS" = ${migration.queries.length}, "OWNER" = ${owner}, "ERROR" = NULL WHERE "ID" = ${migration.id}`,
      );
      for (let position = resume ?? 0; position < migration.queries.length; position++) {
        if (
          !(await updated(
            sql`UPDATE ${lockName} SET "EXPIRES_AT" = ${expiry} WHERE "ID" = 1 AND "OWNER" = ${owner}`,
          ))
        )
          throw new MigrationError('LOCK_LOST', 'The migration lock lease expired and was taken.', {
            migration: migration.id,
          });
        try {
          await client.queryRaw(migration.queries[position] as RawQuery);
        } catch (error) {
          await client
            .queryRaw(
              sql`UPDATE ${historyName} SET "STATUS" = 'failed', "ERROR" = ${error instanceof Error ? error.message : String(error)} WHERE "ID" = ${migration.id}`,
            )
            .catch(() => undefined);
          throw new MigrationError(
            'FAILED',
            `Migration ${migration.id} failed at statement ${position + 1} of ${migration.queries.length}; earlier statements are committed.`,
            { migration: migration.id, cause: error },
          );
        }
        await client.queryRaw(
          sql`UPDATE ${historyName} SET "APPLIED_STATEMENTS" = ${position + 1} WHERE "ID" = ${migration.id}`,
        );
      }
      await client.queryRaw(
        sql`UPDATE ${historyName} SET "STATUS" = 'applied', "FINISHED_AT" = CURRENT_TIMESTAMP() WHERE "ID" = ${migration.id}`,
      );
      applied.push(migration.id);
    }
  }
  const release = () =>
    client.queryRaw(
      sql`UPDATE ${lockName} SET "OWNER" = NULL, "EXPIRES_AT" = NULL WHERE "ID" = 1 AND "OWNER" = ${owner}`,
    );
  try {
    await run();
  } catch (error) {
    await release().catch(() => undefined);
    throw error;
  }
  await release();
  return Object.freeze({
    applied: Object.freeze(applied),
    ...(options.verify ? { drift: await checkDrift(client, options.verify, options) } : {}),
  });
}

export interface DriftOptions {
  readonly historyTable?: string;
  readonly ignoreTables?: readonly string[];
}
/** Diffs the desired schema against the database, ignoring migration bookkeeping tables. */
export async function checkDrift(
  client: Client,
  desired: SchemaDefinition,
  options: DriftOptions = {},
): Promise<SchemaDiff> {
  const { table, lockTable } = names({ ...desired, ...options });
  return diffSchema(desired, await inspectSchema(client, desired), {
    ignoreTables: [...(options.ignoreTables ?? []), table, lockTable],
  });
}

/**
 * Applies the diff directly, without history or locking. Rerunning recomputes the diff, so a
 * partially applied push resumes from the database state.
 */
export async function pushSchema(
  client: Client,
  desired: SchemaDefinition,
  options: DriftOptions & { readonly allowDestructive?: boolean } = {},
): Promise<SchemaDiff> {
  const diff = await checkDrift(client, desired, options);
  if (diff.unsupported.length)
    throw new MigrationError(
      'UNSUPPORTED',
      `Write a migration for: ${diff.unsupported.map((entry) => `${entry.table}.${entry.column}: ${entry.reason}`).join('; ')}`,
    );
  const destructive = diff.changes.filter((entry) => entry.destructive);
  if (destructive.length && !options.allowDestructive)
    throw new MigrationError(
      'DESTRUCTIVE',
      `Destructive changes need allowDestructive: ${destructive.map((entry) => entry.description).join('; ')}`,
    );
  for (const entry of diff.changes)
    await client.queryRaw(sql.unsafe(entry.statement.compile().sql));
  return diff;
}
