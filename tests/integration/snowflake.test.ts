import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, select, snowflakeTable, text } from '../../src/index.js';
import { createFixture, integrationConfig } from '../support/snowflake.js';

describe('real Snowflake with isolated seed data', () => {
  const fixture = createFixture(integrationConfig());
  const table = fixture.table;

  beforeAll(() => fixture.seed());
  afterAll(() => fixture.cleanup());

  it('returns schema-derived types, exact numbers, nulls, and query metadata', async () => {
    const result = await fixture.client.execute(
      select(table, table.columns).where(eq(table.columns.id, 9007199254740993n)),
    );
    expect(result.queryId).toBeTruthy();
    expect(result.rows).toEqual([
      {
        id: 9007199254740993n,
        name: 'Ada',
        email: null,
        balance: '12345678901234567890.1234',
        active: true,
      },
    ]);
  });

  it('reads the seeded population without relying on database row order', async () => {
    const result = await fixture.client.execute(select(table, { name: table.columns.name }));
    expect(result.rows.map((row) => row.name).sort()).toEqual(['Ada', 'Grace', 'Linus']);
  });

  it('validates nullable filters and boolean bindings against Snowflake', async () => {
    const nullable = await fixture.client.execute(
      select(table, { name: table.columns.name }).where(eq(table.columns.email, null)),
    );
    expect(nullable.rows).toEqual([{ name: 'Ada' }]);
    const inactive = await fixture.client.execute(
      select(table, { name: table.columns.name }).where(eq(table.columns.active, false)),
    );
    expect(inactive.rows).toEqual([{ name: 'Grace' }]);
  });

  it('treats injection-like input as data and returns an empty result', async () => {
    const result = await fixture.client.execute(
      select(table, { name: table.columns.name }).where(
        eq(table.columns.name, "Ada'; DROP TABLE CUSTOMERS; --"),
      ),
    );
    expect(result.rows).toEqual([]);
    expect(
      (await fixture.client.execute(select(table, { name: table.columns.name }))).rows,
    ).toHaveLength(3);
  });

  it('rejects real database values when a declaration contradicts them', async () => {
    const incorrect = snowflakeTable(
      'CUSTOMERS',
      { email: text('EMAIL').notNull() },
      {
        database: table.node.parts[0] as string,
        schema: fixture.schemaName,
      },
    );
    await expect(fixture.client.execute(select(incorrect, incorrect.columns))).rejects.toThrow();
  });
});
