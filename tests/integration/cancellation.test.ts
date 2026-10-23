import { randomUUID } from 'node:crypto';
import snowflake from 'snowflake-sdk';
import { expect, it } from 'vitest';
import { request } from '../../src/snowflake/request.js';
import { integrationConfig } from '../support/snowflake.js';

async function finalStatus(connection: snowflake.Connection, tag: string): Promise<string> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const { rows } = await request(connection, {
      sqlText: `SELECT EXECUTION_STATUS FROM TABLE(INFORMATION_SCHEMA.QUERY_HISTORY_BY_SESSION())
        WHERE QUERY_TEXT LIKE 'SELECT SYSTEM$WAIT%' AND CONTAINS(QUERY_TEXT, ?)`,
      binds: [tag],
    });
    const status = (rows as { EXECUTION_STATUS: string }[] | undefined)?.[0]?.EXECUTION_STATUS;
    if (status && !['RUNNING', 'QUEUED', 'RESUMING_WAREHOUSE', 'BLOCKED'].includes(status))
      return status;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Statement ${tag} did not finish.`);
}

it('never reports a rejection for a statement that went on to succeed on a cold session', async () => {
  const outcomes: { deadline: number; rejected: boolean; status: string }[] = [];
  for (const deadline of [150, 200, 250, 300]) {
    const connection = snowflake.createConnection(integrationConfig());
    await new Promise<void>((resolve, reject) =>
      connection.connect((error) => (error ? reject(error) : resolve())),
    );
    try {
      const tag = randomUUID();
      const outcome = await request(
        connection,
        { sqlText: `SELECT SYSTEM$WAIT(3) AS "${tag}"` },
        AbortSignal.timeout(deadline),
      ).then(
        () => ({ rejected: false }),
        (error: unknown) => {
          expect(error).toMatchObject({ name: 'TimeoutError' });
          return { rejected: true };
        },
      );
      outcomes.push({ deadline, ...outcome, status: await finalStatus(connection, tag) });
    } finally {
      await new Promise<void>((resolve) => connection.destroy(() => resolve()));
    }
  }
  for (const outcome of outcomes)
    expect(outcome).toEqual({
      ...outcome,
      status: outcome.rejected ? 'FAILED_WITH_ERROR' : 'SUCCESS',
    });
  expect(outcomes.some((outcome) => outcome.rejected)).toBe(true);
}, 120_000);
