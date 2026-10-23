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
        DATA_TYPE_ALIAS: null,
        IS_NULLABLE: 'NO',
        NUMERIC_PRECISION: '38',
        NUMERIC_SCALE: '0',
        CHARACTER_MAXIMUM_LENGTH: null,
        DATETIME_PRECISION: null,
        COLUMN_DEFAULT: null,
        IS_IDENTITY: 'NO',
        IDENTITY_START: null,
        IDENTITY_INCREMENT: null,
        IDENTITY_ORDERED: null,
        KIND: 'COLUMN',
        EXPRESSION: null,
      },
      {
        TABLE_SCHEMA: 'S',
        TABLE_NAME: 'T',
        COLUMN_NAME: 'Name"',
        DATA_TYPE: 'TEXT',
        DATA_TYPE_ALIAS: null,
        IS_NULLABLE: 'YES',
        NUMERIC_PRECISION: null,
        NUMERIC_SCALE: null,
        CHARACTER_MAXIMUM_LENGTH: '16777216',
        DATETIME_PRECISION: null,
        COLUMN_DEFAULT: null,
        IS_IDENTITY: 'NO',
        IDENTITY_START: null,
        IDENTITY_INCREMENT: null,
        IDENTITY_ORDERED: null,
        KIND: 'COLUMN',
        EXPRESSION: null,
      },
      {
        TABLE_SCHEMA: 'S',
        TABLE_NAME: 'T',
        COLUMN_NAME: 'AT',
        DATA_TYPE: 'TIMESTAMP_TZ',
        DATA_TYPE_ALIAS: null,
        IS_NULLABLE: 'YES',
        NUMERIC_PRECISION: null,
        NUMERIC_SCALE: null,
        CHARACTER_MAXIMUM_LENGTH: null,
        DATETIME_PRECISION: '3',
        COLUMN_DEFAULT: null,
        IS_IDENTITY: 'NO',
        IDENTITY_START: null,
        IDENTITY_INCREMENT: null,
        IDENTITY_ORDERED: null,
        KIND: 'COLUMN',
        EXPRESSION: null,
      },
      {
        TABLE_SCHEMA: 'S',
        TABLE_NAME: 'OTHER',
        COLUMN_NAME: 'ID',
        DATA_TYPE: 'NUMBER',
        DATA_TYPE_ALIAS: null,
        IS_NULLABLE: 'NO',
        NUMERIC_PRECISION: '38',
        NUMERIC_SCALE: '2',
        CHARACTER_MAXIMUM_LENGTH: null,
        DATETIME_PRECISION: null,
        COLUMN_DEFAULT: null,
        IS_IDENTITY: 'NO',
        IDENTITY_START: null,
        IDENTITY_INCREMENT: null,
        IDENTITY_ORDERED: null,
        KIND: 'COLUMN',
        EXPRESSION: null,
      },
    ]);
    const client = { queryRaw } as unknown as SnowflakeClient;
    const tables = await introspect(client, { database: 'Odd.DB', schema: "S'; --" });
    expect(tables).toHaveLength(2);
    expect(tables[0]?.columns).toEqual([
      {
        name: 'ID',
        dataType: 'NUMBER',
        nullable: false,
        precision: 38,
        scale: 0,
        length: null,
        serverValue: null,
      },
      {
        name: 'Name"',
        dataType: 'TEXT',
        nullable: true,
        precision: null,
        scale: null,
        length: 16777216,
        serverValue: null,
      },
      {
        name: 'AT',
        dataType: 'TIMESTAMP_TZ',
        nullable: true,
        precision: 3,
        scale: null,
        length: null,
        serverValue: null,
      },
    ]);
    expect(tables[1]?.columns[0]).toMatchObject({ precision: 38, scale: 2 });
    expect(queryRaw.mock.calls[0]?.[0].compile()).toMatchObject({
      binds: ['INFORMATION_SCHEMA', "S'; --"],
    });
    expect(queryRaw.mock.calls[0]?.[0].compile().sql).toContain(
      '"Odd.DB"."INFORMATION_SCHEMA"."COLUMNS"',
    );
    await introspect(client, { database: 'DB' });
    expect(queryRaw.mock.calls[1]?.[0].compile().binds).toEqual(['INFORMATION_SCHEMA']);
    const code = generateSchema(tables);
    expect(code).toContain('"Name\\"": text("Name\\""),');
    expect(code).toContain('"ID": integer("ID").notNull()');
    expect(code).toContain('"AT": timestamp("AT", "tz", { precision: 3 })');
    expect(code).toContain('"ID": decimal("ID", { precision: 38, scale: 2 }).notNull()');
  });

  it('distinguishes semi-structured ARRAY and OBJECT from structured types', async () => {
    const row = (name: string, type: string, alias: string | null) => ({
      TABLE_SCHEMA: 'S',
      TABLE_NAME: 'T',
      COLUMN_NAME: name,
      DATA_TYPE: type,
      DATA_TYPE_ALIAS: alias,
      IS_NULLABLE: 'YES',
      NUMERIC_PRECISION: null,
      NUMERIC_SCALE: null,
      CHARACTER_MAXIMUM_LENGTH: null,
      DATETIME_PRECISION: null,
      COLUMN_DEFAULT: null,
      IS_IDENTITY: 'NO',
      IDENTITY_START: null,
      IDENTITY_INCREMENT: null,
      IDENTITY_ORDERED: null,
      KIND: 'COLUMN',
      EXPRESSION: null,
    });
    const client = {
      queryRaw: async () => [
        row('A', 'ARRAY', 'ARRAY'),
        row('O', 'OBJECT', 'OBJECT'),
        row('SA', 'ARRAY', 'ARRAY(NUMBER)'),
        row('SO', 'OBJECT', 'OBJECT(CITY VARCHAR)'),
      ],
    } as unknown as SnowflakeClient;
    const [table] = await introspect(client, { database: 'DB' });
    if (!table) throw new Error('Expected a table.');
    expect(table.columns.map((column) => column.dataType)).toEqual([
      'ARRAY',
      'OBJECT',
      'ARRAY(NUMBER)',
      'OBJECT(CITY VARCHAR)',
    ]);
    const code = generateSchema([{ ...table, columns: table.columns.slice(0, 2) }]);
    expect(code).toContain("import { array, object, snowflakeTable } from 'snowtyped';");
    expect(code).toContain('"A": array("A"),');
    expect(code).toContain('"O": object("O"),');
    for (const column of table.columns.slice(2))
      expect(() => generateSchema([{ ...table, columns: [column] }])).toThrow(
        `Unsupported Snowflake type for code generation: ${column.dataType}`,
      );
  });

  it('reads default, identity, and virtual column metadata into declarations', async () => {
    const base = {
      TABLE_SCHEMA: 'S',
      TABLE_NAME: 'T',
      DATA_TYPE: 'NUMBER',
      IS_NULLABLE: 'YES',
      NUMERIC_PRECISION: '38',
      NUMERIC_SCALE: '0',
      DATA_TYPE_ALIAS: null,
      CHARACTER_MAXIMUM_LENGTH: null,
      DATETIME_PRECISION: null,
      COLUMN_DEFAULT: null,
      IS_IDENTITY: 'NO',
      IDENTITY_START: null,
      IDENTITY_INCREMENT: null,
      IDENTITY_ORDERED: null,
      KIND: 'COLUMN',
      EXPRESSION: null,
    };
    const client = {
      queryRaw: async () => [
        {
          ...base,
          COLUMN_NAME: 'ID',
          IS_NULLABLE: 'NO',
          IS_IDENTITY: 'YES',
          IDENTITY_START: '10',
          IDENTITY_INCREMENT: '5',
          IDENTITY_ORDERED: 'YES',
        },
        { ...base, COLUMN_NAME: 'SEQ', IS_IDENTITY: 'YES' },
        { ...base, COLUMN_NAME: 'STATUS', DATA_TYPE: 'TEXT', COLUMN_DEFAULT: "'new'" },
        { ...base, COLUMN_NAME: 'DOUBLED', KIND: 'VIRTUAL_COLUMN', EXPRESSION: 'ID * 2' },
        { ...base, COLUMN_NAME: 'PART', KIND: 'PARTITION_COLUMN' },
      ],
    } as unknown as SnowflakeClient;
    const tables = await introspect(client, { database: 'DB' });
    expect(tables[0]?.columns.map((column) => column.serverValue)).toEqual([
      { kind: 'identity', start: 10, increment: 5, order: true },
      { kind: 'identity' },
      { kind: 'default', expression: "'new'" },
      { kind: 'virtual', expression: 'ID * 2' },
      { kind: 'virtual' },
    ]);
    const code = generateSchema(tables);
    expect(code).toContain(
      '"ID": integer("ID").notNull().identity({ start: 10, increment: 5, order: true }),',
    );
    expect(code).toContain('"SEQ": integer("SEQ").identity(),');
    expect(code).toContain('"STATUS": text("STATUS").serverDefault("\'new\'"),');
    expect(code).toContain('"DOUBLED": integer("DOUBLED").virtual("ID * 2"),');
    expect(code).toContain('"PART": integer("PART").virtual(),');
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
      length: null,
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
      'array',
      'object',
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
            {
              name: 'V',
              dataType: 'GEOGRAPHY',
              nullable: false,
              precision: null,
              scale: null,
              length: null,
            },
          ],
        },
      ]),
    ).toThrow('Unsupported');
  });

  it('generates declared precision, scale, and length constraints', () => {
    const column = (
      dataType: string,
      precision: number | null,
      scale: number | null,
      length: number | null,
    ): IntrospectedColumn => ({
      name: `${dataType}_${precision}_${scale}_${length}`,
      dataType,
      nullable: true,
      precision,
      scale,
      length,
    });
    const code = generateSchema([
      {
        database: 'DB',
        schema: 'S',
        name: 'T',
        columns: [
          column('NUMBER', 10, 0, null),
          column('NUMBER', null, 0, null),
          column('NUMBER', 5, 2, null),
          column('NUMBER', null, null, null),
          column('TEXT', null, null, 3),
          column('TEXT', null, null, null),
          column('BINARY', null, null, 4),
          column('BINARY', null, null, 8388608),
          column('TIME', 0, null, null),
          column('TIME', 9, null, null),
          column('TIMESTAMP_LTZ', 6, null, null),
          column('TIMESTAMP_NTZ', 9, null, null),
          column('TIMESTAMP_NTZ', null, null, null),
        ],
      },
    ]);
    for (const declaration of [
      'integer("NUMBER_10_0_null", { precision: 10 })',
      'integer("NUMBER_null_0_null")',
      'decimal("NUMBER_5_2_null", { precision: 5, scale: 2 })',
      'decimal("NUMBER_null_null_null")',
      'text("TEXT_null_null_3", { length: 3 })',
      'text("TEXT_null_null_null")',
      'binary("BINARY_null_null_4", { length: 4 })',
      'binary("BINARY_null_null_8388608")',
      'time("TIME_0_null_null", { precision: 0 })',
      'time("TIME_9_null_null")',
      'timestamp("TIMESTAMP_LTZ_6_null_null", "ltz", { precision: 6 })',
      'timestamp("TIMESTAMP_NTZ_9_null_null", "ntz")',
      'timestamp("TIMESTAMP_NTZ_null_null_null", "ntz")',
    ])
      expect(code).toContain(`${declaration},`);
  });
});
