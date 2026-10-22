import { describe, expect, it, vi } from 'vitest';
import {
  generateSchema,
  type IntrospectedColumn,
  introspect,
  type RawQuery,
} from '../../src/index.js';
import type { SnowflakeClient } from '../../src/snowflake/index.js';

describe('schema introspection and code generation', () => {
  it('binds filters, validates metadata, and preserves names, ordinals, and nullability', async () => {
    const queryRaw = vi.fn(async (_query: RawQuery) => [
      {
        TABLE_SCHEMA: 'S',
        TABLE_NAME: 'T',
        COLUMN_NAME: 'ID',
        DATA_TYPE: 'NUMBER',
        IS_NULLABLE: 'NO',
        NUMERIC_PRECISION: '38',
        NUMERIC_SCALE: '0',
      },
      {
        TABLE_SCHEMA: 'S',
        TABLE_NAME: 'T',
        COLUMN_NAME: 'Name"',
        DATA_TYPE: 'TEXT',
        IS_NULLABLE: 'YES',
        NUMERIC_PRECISION: null,
        NUMERIC_SCALE: null,
      },
      {
        TABLE_SCHEMA: 'S',
        TABLE_NAME: 'OTHER',
        COLUMN_NAME: 'ID',
        DATA_TYPE: 'NUMBER',
        IS_NULLABLE: 'NO',
        NUMERIC_PRECISION: '38',
        NUMERIC_SCALE: '2',
      },
    ]);
    const client = { queryRaw } as unknown as SnowflakeClient;
    const tables = await introspect(client, { database: 'Odd.DB', schema: "S'; --" });
    expect(tables).toHaveLength(2);
    expect(tables[0]?.columns).toEqual([
      { name: 'ID', dataType: 'NUMBER', nullable: false, precision: 38, scale: 0 },
      { name: 'Name"', dataType: 'TEXT', nullable: true, precision: null, scale: null },
    ]);
    expect(queryRaw.mock.calls[0]?.[0].compile()).toMatchObject({
      binds: ['INFORMATION_SCHEMA', "S'; --"],
    });
    expect(queryRaw.mock.calls[0]?.[0].compile().sql).toContain(
      '"Odd.DB"."INFORMATION_SCHEMA"."COLUMNS"',
    );
    await introspect(client, { database: 'DB' });
    expect(queryRaw.mock.calls[1]?.[0].compile().binds).toEqual(['INFORMATION_SCHEMA']);
    expect(generateSchema(tables)).toContain('"Name\\"": text("Name\\"")');
  });

  it('rejects invalid driver metadata', async () => {
    const client = { queryRaw: async () => [{}] } as unknown as SnowflakeClient;
    await expect(introspect(client, { database: 'DB' })).rejects.toThrow();
  });

  it('maps each supported Snowflake data type into a declaration', () => {
    const types = [
      'NUMBER',
      'FIXED',
      'DECIMAL',
      'TEXT',
      'VARCHAR',
      'CHAR',
      'BOOLEAN',
      'FLOAT',
      'REAL',
      'DOUBLE',
      'DATE',
      'TIME',
      'TIMESTAMP_NTZ',
      'TIMESTAMP_LTZ',
      'TIMESTAMP_TZ',
      'VARIANT',
      'ARRAY',
      'OBJECT',
      'BINARY',
    ];
    const columns: IntrospectedColumn[] = types.map((dataType, index) => ({
      name: `C${index}`,
      dataType,
      nullable: index % 2 === 0,
      precision: 38,
      scale: index === 0 ? 0 : 2,
    }));
    const code = generateSchema([{ database: 'DB', schema: 'S', name: 'T', columns }]);
    for (const name of [
      'integer',
      'decimal',
      'text',
      'boolean',
      'float',
      'date',
      'time',
      'timestamp',
      'variant',
      'binary',
    ])
      expect(code).toContain(`${name}(`);
    expect(code).toContain('"ntz"');
    expect(code).toContain('"ltz"');
    expect(code).toContain('"tz"');
    expect(code).toContain('.notNull()');
    expect(generateSchema([])).toContain('snowflakeTable');
    expect(() =>
      generateSchema([
        {
          database: 'DB',
          schema: 'S',
          name: 'T',
          columns: [
            { name: 'V', dataType: 'GEOGRAPHY', nullable: false, precision: null, scale: null },
          ],
        },
      ]),
    ).toThrow('Unsupported');
  });
});
