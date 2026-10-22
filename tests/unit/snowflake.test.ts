import type { Connection, RowStatement, SnowflakeError, StatementOption } from 'snowflake-sdk';
import { describe, expect, it, vi } from 'vitest';
import { boolean, decimal, integer, select, snowflakeTable, text } from '../../src/index.js';
import { createClient } from '../../src/snowflake/index.js';

const table = snowflakeTable('CUSTOMERS', {
  id: integer('ID').notNull(),
  name: text('NAME').notNull(),
  email: text('EMAIL'),
  balance: decimal('BALANCE').notNull(),
  active: boolean('ACTIVE').notNull(),
});
const query = select(table, table.columns);
const statement = { getQueryId: () => 'query-123' } as RowStatement;

function fakeConnection(rows?: unknown[], error?: Error) {
  const execute = vi.fn((options: StatementOption) => {
    options.complete?.(error as SnowflakeError | undefined, statement, rows);
    return statement;
  });
  return { execute } satisfies Pick<Connection, 'execute'>;
}

describe('SDK client with schema-derived validation', () => {
  it('validates and decodes declared column types automatically', async () => {
    const connection = fakeConnection([
      ['9007199254740993', 'Ada', null, '12345678901234567890.1234', true],
    ]);
    const result = await createClient(connection).execute(query);
    expect(result).toEqual({
      queryId: 'query-123',
      rows: [
        {
          id: 9007199254740993n,
          name: 'Ada',
          email: null,
          balance: '12345678901234567890.1234',
          active: true,
        },
      ],
    });
    expect(connection.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        sqlText: query.compile().sql,
        binds: [],
        rowMode: 'array',
        fetchAsString: ['Number', 'Date', 'JSON'],
        streamResult: false,
        asyncExec: false,
      }),
    );
  });

  it('reuses a compiled schema across executions and filter variants', async () => {
    const client = createClient(fakeConnection([['1', 'Ada', 'a@example.test', '0.0', false]]));
    expect((await client.execute(query)).rows[0]?.id).toBe(1n);
    expect((await client.execute(query)).rows[0]?.active).toBe(false);
  });

  it('supports empty result sets', async () => {
    expect((await createClient(fakeConnection([])).execute(query)).rows).toEqual([]);
  });

  it('preserves SDK failures', async () => {
    const error = new Error('Warehouse unavailable');
    await expect(createClient(fakeConnection(undefined, error)).execute(query)).rejects.toBe(error);
  });

  it('rejects synchronous SDK failures', async () => {
    const error = new Error('Connection destroyed');
    const connection = {
      execute: () => {
        throw error;
      },
    };
    await expect(createClient(connection).execute(query)).rejects.toBe(error);
  });

  it('rejects missing result sets', async () => {
    await expect(createClient(fakeConnection()).execute(query)).rejects.toThrow(
      'Expected a SELECT',
    );
  });

  it.each([{}, [], ['1', 'Ada'], null].map((row) => ({ row })))(
    'rejects malformed rows: $row',
    async ({ row }) => {
      await expect(createClient(fakeConnection([row])).execute(query)).rejects.toThrow(
        'projection width',
      );
    },
  );

  it.each(
    [
      [1, 'Ada', null, '0.0', true],
      ['1', null, null, '0.0', true],
      ['1', 'Ada', null, 0, true],
      ['1', 'Ada', null, '0.0', 'true'],
    ].map((row) => ({ row })),
  )('rejects runtime values that contradict the declared schema: $row', async ({ row }) => {
    await expect(createClient(fakeConnection([row])).execute(query)).rejects.toThrow();
  });
});
