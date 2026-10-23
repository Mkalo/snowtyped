import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({ createPool: vi.fn() }));
vi.mock('snowflake-sdk', () => ({ default: sdk }));

import * as api from '../../src/index.js';
import * as driver from '../../src/snowflake/index.js';

const document = readFileSync(new URL('../../docs/live-coverage.md', import.meta.url), 'utf8');
const listed = new Set(
  document
    .split('\n')
    .filter((line) => line.startsWith('| '))
    .flatMap((line) => [...(line.split('|')[1] ?? '').matchAll(/`([^`]+)`/g)])
    .map((match) => match[1]),
);
const methods = (value: object, prefix = '.') =>
  Object.entries(value)
    .filter(([, member]) => typeof member === 'function')
    .map(([name]) => `${prefix}${name}`);

describe('live coverage document', () => {
  it('lists every public runtime export and builder method', async () => {
    const table = api.snowflakeTable('T', { id: api.integer('ID').notNull() });
    const source = api.alias(table, 'S');
    sdk.createPool.mockReturnValue({});
    const names = [
      ...Object.keys(api),
      ...Object.keys(driver),
      ...methods(api.select(table)),
      ...methods(api.update(table, { id: 1n })),
      ...methods(api.mergeInto(table, source, api.eq(table.columns.id, source.columns.id))),
      ...methods(api.sql, 'sql.'),
      ...methods(driver.createClient({ execute: vi.fn() })),
      ...methods(await driver.createPool({ account: 'test' })),
    ];
    const missing = [...new Set(names)].filter((name) => !listed.has(name));
    expect(missing).toEqual([]);
  });
});
