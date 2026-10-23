import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  asc,
  count,
  deleteFrom,
  eq,
  insert,
  integer,
  select,
  snowflakeTable,
  sql,
  text,
  update,
} from '../../src/index.js';
import { createPool, type PooledClient } from '../../src/snowflake/index.js';
import { createFixture, integrationConfig, tableIdentifier } from '../support/snowflake.js';

const ROWS = 20_000;

describe('raw SQL, streaming, cancellation, transactions, and pools against Snowflake', () => {
  const fixture = createFixture(integrationConfig());
  const db = fixture.client;
  const customers = fixture.table;
  const namespace = { database: customers.node.parts[0] as string, schema: fixture.schemaName };
  const numbers = snowflakeTable(
    'NUMBERS',
    { n: integer('N').notNull(), pad: text('PAD').notNull() },
    namespace,
  );
  const slow = snowflakeTable('SLOW', { waited: text('WAITED') }, namespace);
  const ledger = snowflakeTable(
    'LEDGER',
    { id: integer('ID').notNull(), note: text('NOTE').notNull() },
    namespace,
  );
  const quoted = snowflakeTable('raw "quoted" table', { value: text('Value') }, namespace);
  const ledgerIds = async (client: Pick<PooledClient, 'execute'> = db) =>
    (
      await client.execute(
        select(ledger, { id: ledger.columns.id }).orderBy(asc(ledger.columns.id)),
      )
    ).rows.map((row) => row.id);
  const pools: PooledClient[] = [];
  const pool = async (max: number) => {
    const created = await createPool(integrationConfig(), { max, acquireTimeoutMillis: 15_000 });
    pools.push(created);
    return created;
  };

  beforeAll(async () => {
    await fixture.seed();
    await db.queryRaw(sql`CREATE TABLE ${tableIdentifier(numbers)} AS
      SELECT ROW_NUMBER() OVER (ORDER BY SEQ4()) AS N, RPAD('x', 100, 'x') AS PAD
      FROM TABLE(GENERATOR(ROWCOUNT => ${ROWS}))`);
    await db.queryRaw(
      sql`CREATE VIEW ${tableIdentifier(slow)} AS SELECT SYSTEM$WAIT(30) AS WAITED`,
    );
    await db.queryRaw(
      sql`CREATE TABLE ${tableIdentifier(ledger)} (ID NUMBER(38,0) NOT NULL, NOTE VARCHAR NOT NULL)`,
    );
    await db.queryRaw(
      sql`CREATE TABLE ${tableIdentifier(quoted)} (${sql.identifier('Value')} VARIANT)`,
    );
  });
  afterAll(async () => {
    try {
      await Promise.all(pools.map((created) => created.close()));
    } finally {
      await fixture.cleanup();
    }
  });

  it('binds scalar interpolations in order across nested fragments', async () => {
    expect(
      await db.queryRaw`SELECT ${1} AS A, ${sql`${'two'} AS B, ${sql`${3n}`} AS C`}, ${4.5} AS D,
        ${null} IS NULL AS E, ${false} AS F, ${9007199254740993n}::NUMBER(38,0) AS G`,
    ).toEqual([{ A: '1', B: 'two', C: '3', D: '4.5', E: true, F: false, G: '9007199254740993' }]);
    const at = new Date('2026-01-02T03:04:05.678Z');
    expect(
      await db.queryRaw`SELECT TO_VARCHAR(${at}::TIMESTAMP_TZ, 'YYYY-MM-DD HH24:MI:SS.FF3') AS T`,
    ).toEqual([{ T: '2026-01-02 03:04:05.678' }]);
    const hostile = "x'); DROP TABLE CUSTOMERS; --";
    expect(await db.queryRaw`SELECT ${hostile} AS V`).toEqual([{ V: hostile }]);
  });

  it('composes identifiers, joined lists and predicates, JSON, and trusted fragments', async () => {
    const table = tableIdentifier(customers);
    expect(
      await db.queryRaw(
        sql`SELECT ID FROM ${table} WHERE ID IN (${sql.join([2n, 3n, 404n])}) ORDER BY ID`,
      ),
    ).toEqual([{ ID: '2' }, { ID: '3' }]);
    const predicate = sql.join(
      [sql`ACTIVE = ${true}`, sql`EMAIL IS NOT NULL`, sql`NAME <> ${'Grace'}`],
      sql` AND `,
    );
    expect(await db.queryRaw(sql`SELECT NAME FROM ${table} WHERE ${predicate}`)).toEqual([
      { NAME: 'Linus' },
    ]);
    expect(
      await db.queryRaw(sql`SELECT NAME FROM ${table} ORDER BY ${sql.unsafe('NAME DESC')}`),
    ).toEqual([{ NAME: 'Linus' }, { NAME: 'Grace' }, { NAME: 'Ada' }]);
    const target = tableIdentifier(quoted);
    await db.queryRaw(
      sql`INSERT INTO ${target} (${sql.identifier('Value')}) SELECT ${sql.json({ list: [1, 2], text: "it's" })}`,
    );
    expect(
      await db.queryRaw(sql`SELECT ${sql.identifier('Value')}:list[1]::NUMBER AS SECOND,
        ${sql.identifier('Value')}:text::VARCHAR AS TEXT FROM ${target}`),
    ).toEqual([{ SECOND: '2', TEXT: "it's" }]);
  });

  it('reuses typed raw query builders with independent bindings', async () => {
    const byName = (name: string) =>
      sql<Array<{ ID: string }>>`SELECT ID FROM ${tableIdentifier(customers)} WHERE NAME = ${name}`;
    expect(await db.queryRaw(byName('Grace'))).toEqual([{ ID: '2' }]);
    expect(await db.queryRaw(byName('Linus'))).toEqual([{ ID: '3' }]);
    expect(await db.queryRaw(byName('Nobody'))).toEqual([]);
  });

  it('streams a multi-chunk structured result in order with validated rows', async () => {
    let expected = 1n;
    for await (const row of db.stream(
      select(numbers, numbers.columns).orderBy(asc(numbers.columns.n)),
    )) {
      expect(row.n).toBe(expected);
      expect(row.pad).toHaveLength(100);
      expected++;
    }
    expect(expected).toBe(BigInt(ROWS) + 1n);
  });

  it('streams raw rows and keeps the connection usable after early closure', async () => {
    let total = 0;
    for await (const _row of db.streamRaw(sql`SELECT N FROM ${tableIdentifier(numbers)}`)) total++;
    expect(total).toBe(ROWS);
    const seen: bigint[] = [];
    for await (const row of db.stream(select(numbers, { n: numbers.columns.n }))) {
      seen.push(row.n);
      if (seen.length === 10) break;
    }
    expect(seen).toHaveLength(10);
    for await (const _row of db.streamRaw(sql`SELECT N FROM ${tableIdentifier(numbers)}`)) break;
    expect((await db.execute(select(numbers, { total: count() }))).rows).toEqual([
      { total: BigInt(ROWS) },
    ]);
  });

  it('rejects a stream whose rows contradict the declaration and recovers', async () => {
    const wrong = snowflakeTable('NUMBERS', { pad: integer('PAD').notNull() }, namespace);
    await expect(async () => {
      for await (const _row of db.stream(select(wrong))) {
        /* consume */
      }
    }).rejects.toThrow();
    expect((await db.execute(select(customers, { n: count() }))).rows).toEqual([{ n: 3n }]);
  });

  it('cancels running statements by signal and deadline, then reuses the connection', async () => {
    const started = Date.now();
    const controller = new AbortController();
    const reason = new Error('caller cancelled');
    setTimeout(() => controller.abort(reason), 1_000);
    await expect(db.execute(select(slow), { signal: controller.signal })).rejects.toBe(reason);
    await expect(db.execute(select(slow), { timeoutMs: 1_000 })).rejects.toMatchObject({
      name: 'TimeoutError',
    });
    const aborted = new Error('already aborted');
    await expect(db.execute(select(slow), { signal: AbortSignal.abort(aborted) })).rejects.toBe(
      aborted,
    );
    await expect(async () => {
      for await (const _row of db.stream(select(slow), { timeoutMs: 1_000 })) {
        /* consume */
      }
    }).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(Date.now() - started).toBeLessThan(25_000);
    expect((await db.execute(select(customers, { n: count() }))).rows).toEqual([{ n: 3n }]);
  });

  it('aborts an in-flight stream after rows start arriving', async () => {
    const controller = new AbortController();
    const reason = new Error('stop streaming');
    let received = 0;
    await expect(async () => {
      for await (const _row of db.stream(select(numbers), { signal: controller.signal })) {
        received++;
        if (received === 1) controller.abort(reason);
      }
    }).rejects.toBe(reason);
    expect(received).toBeLessThan(ROWS);
    expect((await db.execute(select(customers, { n: count() }))).rows).toEqual([{ n: 3n }]);
  });

  it('commits multiple statements and returns the callback value', async () => {
    await db.execute(deleteFrom(ledger));
    const value = await db.transaction(async (tx) => {
      await tx.execute(
        insert(ledger, [
          { id: 1n, note: 'a' },
          { id: 2n, note: 'b' },
        ]),
      );
      await tx.execute(update(ledger, { note: 'changed' }).where(eq(ledger.columns.id, 2n)));
      const inside = [];
      for await (const row of tx.stream(select(ledger, { id: ledger.columns.id })))
        inside.push(row);
      return inside.length;
    });
    expect(value).toBe(2);
    expect((await db.execute(select(ledger).orderBy(asc(ledger.columns.id)))).rows).toEqual([
      { id: 1n, note: 'a' },
      { id: 2n, note: 'changed' },
    ]);
  });

  it('rolls back inserts, updates, and deletes after callback and server errors', async () => {
    await db.execute(deleteFrom(ledger));
    await db.execute(
      insert(ledger, [
        { id: 1n, note: 'kept' },
        { id: 2n, note: 'kept' },
      ]),
    );
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(insert(ledger, { id: 3n, note: 'new' }));
        await tx.execute(update(ledger, { note: 'changed' }));
        await tx.execute(deleteFrom(ledger).where(eq(ledger.columns.id, 1n)));
        expect(await ledgerIds(tx)).toEqual([2n, 3n]);
        throw new Error('undo');
      }),
    ).rejects.toThrow('undo');
    const loose = snowflakeTable('LEDGER', { id: integer('ID'), note: text('NOTE') }, namespace);
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(insert(ledger, { id: 4n, note: 'new' }));
        await tx.execute(insert(loose, { id: 5n }));
      }),
    ).rejects.toThrow();
    expect((await db.execute(select(ledger).orderBy(asc(ledger.columns.id)))).rows).toEqual([
      { id: 1n, note: 'kept' },
      { id: 2n, note: 'kept' },
    ]);
  });

  it('isolates uncommitted pooled transactions from other pooled sessions', async () => {
    const pooled = await pool(2);
    await pooled.execute(deleteFrom(ledger));
    const outside = await pooled.transaction(async (tx) => {
      await tx.execute(insert(ledger, { id: 10n, note: 'pending' }));
      expect(await ledgerIds(tx)).toEqual([10n]);
      return ledgerIds(pooled);
    });
    expect(outside).toEqual([]);
    expect(await ledgerIds(pooled)).toEqual([10n]);
    await expect(
      pooled.transaction(async (tx) => {
        await tx.execute(insert(ledger, { id: 11n, note: 'discarded' }));
        throw new Error('undo');
      }),
    ).rejects.toThrow('undo');
    expect(await ledgerIds(pooled)).toEqual([10n]);
  });

  it('bounds pooled sessions and runs concurrent work through them', async () => {
    const pooled = await pool(2);
    const sessions = await Promise.all(
      Array.from(
        { length: 4 },
        () =>
          pooled.queryRaw<
            [{ SESSION: string }]
          >`SELECT CURRENT_SESSION() AS SESSION, SYSTEM$WAIT(1) AS W`,
      ),
    );
    expect(new Set(sessions.map(([row]) => row.SESSION)).size).toBe(2);
    expect((await pooled.execute(select(customers, { n: count() }))).rows).toEqual([{ n: 3n }]);
    let streamed = 0;
    for await (const _row of pooled.streamRaw(sql`SELECT N FROM ${tableIdentifier(numbers)}`))
      streamed++;
    expect(streamed).toBe(ROWS);
  });

  it('releases a single pooled connection after failures, cancellation, and early closure', async () => {
    const pooled = await pool(1);
    await expect(
      pooled.queryRaw`SELECT * FROM ${sql.identifier('DOES_NOT_EXIST')}`,
    ).rejects.toThrow();
    await expect(pooled.execute(select(slow), { timeoutMs: 1_000 })).rejects.toMatchObject({
      name: 'TimeoutError',
    });
    for await (const _row of pooled.stream(select(numbers))) break;
    await expect(async () => {
      for await (const _row of pooled.streamRaw(sql`SELECT * FROM ${tableIdentifier(slow)}`, {
        timeoutMs: 1_000,
      })) {
        /* consume */
      }
    }).rejects.toMatchObject({ name: 'TimeoutError' });
    expect((await pooled.execute(select(customers, { n: count() }))).rows).toEqual([{ n: 3n }]);
    await pooled.close();
    await expect(pooled.execute(select(customers))).rejects.toThrow('closed');
  });
});
