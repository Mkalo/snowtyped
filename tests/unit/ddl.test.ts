import { describe, expect, it, vi } from 'vitest';
import {
  alterTable,
  compileDdl,
  createSchema,
  createTable,
  type DdlNode,
  defineSchema,
  defineTable,
  diffSchema,
  dropSchema,
  dropTable,
  inspectSchema,
  type ObservedSchema,
  type ObservedTable,
  setSchemaComment,
  sqlType,
} from '../../src/ddl/index.js';
import { alterableType, physicalType, renderType, sameType } from '../../src/ddl/types.js';
import {
  alias,
  array,
  binary,
  boolean,
  date,
  decimal,
  flatten,
  float,
  geography,
  geometry,
  identifier,
  integer,
  object,
  type RawQuery,
  snowflakeTable,
  text,
  time,
  timestamp,
  timeTravel,
  variant,
  vector,
} from '../../src/index.js';
import type { SnowflakeClient } from '../../src/snowflake/index.js';

const target = { database: 'DB', schema: 'APP' };
const sqlOf = (statement: { compile(): { sql: string } }) => statement.compile().sql;

describe('physical types', () => {
  it('validates ranges and renders Snowflake type names', () => {
    expect(
      [
        sqlType.number(),
        sqlType.number(10, 2),
        sqlType.varchar(),
        sqlType.varchar(20),
        sqlType.binary(),
        sqlType.binary(8),
        sqlType.time(),
        sqlType.timestamp(),
        sqlType.timestamp('ltz', 3),
        sqlType.timestamp('tz', 0),
        sqlType.float(),
        sqlType.boolean(),
        sqlType.date(),
        sqlType.variant(),
        sqlType.array(),
        sqlType.object(),
        sqlType.geography(),
        sqlType.geometry(),
        sqlType.vector('int', 3),
        sqlType.vector('float', 4096),
      ].map(renderType),
    ).toEqual([
      'NUMBER(38, 0)',
      'NUMBER(10, 2)',
      'VARCHAR',
      'VARCHAR(20)',
      'BINARY',
      'BINARY(8)',
      'TIME(9)',
      'TIMESTAMP_NTZ(9)',
      'TIMESTAMP_LTZ(3)',
      'TIMESTAMP_TZ(0)',
      'FLOAT',
      'BOOLEAN',
      'DATE',
      'VARIANT',
      'ARRAY',
      'OBJECT',
      'GEOGRAPHY',
      'GEOMETRY',
      'VECTOR(INT, 3)',
      'VECTOR(FLOAT, 4096)',
    ]);
    expect(Object.isFrozen(sqlType.number())).toBe(true);
    expect(() => sqlType.vector('int', 0)).toThrow('VECTOR dimension');
    expect(() => sqlType.vector('int', 4097)).toThrow('VECTOR dimension');
    expect(() => sqlType.vector('double' as never, 3)).toThrow("'int' or 'float'");
    expect(() => sqlType.number(0)).toThrow('NUMBER precision');
    expect(() => sqlType.number(39)).toThrow('NUMBER precision');
    expect(() => sqlType.number(10, 11)).toThrow('NUMBER scale');
    expect(() => sqlType.number(38, 38)).toThrow('NUMBER scale');
    expect(() => sqlType.number(1.5)).toThrow(RangeError);
    expect(() => sqlType.varchar(0)).toThrow('VARCHAR length');
    expect(() => sqlType.varchar(134_217_729)).toThrow('VARCHAR length');
    expect(() => sqlType.binary(67_108_865)).toThrow('BINARY length');
    expect(() => sqlType.time(10)).toThrow('TIME precision');
    expect(() => sqlType.timestamp('ntz', -1)).toThrow('TIMESTAMP_NTZ precision');
  });

  it('maps declared codecs to compatible physical types', () => {
    expect(physicalType('text', {}, undefined)).toEqual(sqlType.varchar());
    expect(physicalType('integer', {}, undefined)).toEqual(sqlType.number());
    expect(physicalType('float', {}, undefined)).toEqual(sqlType.float());
    expect(physicalType('boolean', {}, undefined)).toEqual(sqlType.boolean());
    expect(physicalType('date', {}, undefined)).toEqual(sqlType.date());
    expect(physicalType('time', {}, undefined)).toEqual(sqlType.time());
    expect(physicalType('timestamp_ntz', {}, undefined)).toEqual(sqlType.timestamp('ntz'));
    expect(physicalType('timestamp_ltz', {}, undefined)).toEqual(sqlType.timestamp('ltz'));
    expect(physicalType('timestamp_tz', {}, undefined)).toEqual(sqlType.timestamp('tz'));
    expect(physicalType('variant', {}, undefined)).toEqual(sqlType.variant());
    expect(physicalType('binary', {}, undefined)).toEqual(sqlType.binary());
    expect(() => physicalType('decimal', {}, undefined)).toThrow('explicit sqlType.number');
    expect(physicalType('decimal', {}, sqlType.number(10, 2))).toEqual(sqlType.number(10, 2));
    expect(physicalType('variant', {}, sqlType.object())).toEqual(sqlType.object());
    expect(() => physicalType('integer', {}, sqlType.number(10, 2))).toThrow(
      'A integer column cannot be stored as NUMBER(10, 2).',
    );
    expect(() => physicalType('text', {}, sqlType.number())).toThrow('cannot be stored');
    expect(physicalType('array', {}, undefined)).toEqual(sqlType.array());
    expect(physicalType('object', {}, undefined)).toEqual(sqlType.object());
    expect(physicalType('geography', {}, undefined)).toEqual(sqlType.geography());
    expect(physicalType('geometry', { srid: 4326 }, undefined)).toEqual(sqlType.geometry());
    expect(() => physicalType('array', {}, sqlType.variant())).toThrow('cannot be stored');
  });

  it('derives physical types from declared column constraints', () => {
    const derived = (column: { dataType: never; constraints: never }) =>
      renderType(physicalType(column.dataType, column.constraints, undefined));
    expect(
      [
        text('A', { length: 20 }),
        binary('A', { length: 8 }),
        integer('A', { precision: 9 }),
        decimal('A', { precision: 12, scale: 4 }),
        decimal('A', { scale: 2 }),
        time('A', { precision: 3 }),
        timestamp('A', 'ntz', { precision: 0 }),
        timestamp('A', 'ltz', { precision: 6 }),
        timestamp('A', 'tz', { precision: 3 }),
        vector('A', 'int', 3),
        vector('A', 'float', 256),
        geometry('A', { srid: 4326 }),
      ].map((column) => derived(column as never)),
    ).toEqual([
      'VARCHAR(20)',
      'BINARY(8)',
      'NUMBER(9, 0)',
      'NUMBER(12, 4)',
      'NUMBER(38, 2)',
      'TIME(3)',
      'TIMESTAMP_NTZ(0)',
      'TIMESTAMP_LTZ(6)',
      'TIMESTAMP_TZ(3)',
      'VECTOR(INT, 3)',
      'VECTOR(FLOAT, 256)',
      'GEOMETRY',
    ]);
    expect(physicalType('text', { length: 20 }, sqlType.varchar(20))).toEqual(sqlType.varchar(20));
    expect(physicalType('integer', { precision: 5 }, undefined)).toEqual(sqlType.number(5, 0));
    expect(() => physicalType('text', { length: 20 }, sqlType.varchar(30))).toThrow(
      "VARCHAR(30) conflicts with the column's declared VARCHAR(20).",
    );
    expect(() =>
      physicalType('decimal', { precision: 12, scale: 4 }, sqlType.number(12, 2)),
    ).toThrow('conflicts');
    expect(() =>
      physicalType('vector', { element: 'int', dimension: 3 }, sqlType.vector('float', 3)),
    ).toThrow('VECTOR(FLOAT, 3) conflicts');
  });

  it('compares desired and observed types without inventing unreported metadata', () => {
    expect(sameType(sqlType.number(10, 2), sqlType.number(10, 2))).toBe(true);
    expect(sameType(sqlType.number(10, 2), sqlType.number(12, 2))).toBe(false);
    expect(sameType(sqlType.number(10, 2), sqlType.number(10, 3))).toBe(false);
    expect(sameType(sqlType.number(), sqlType.float())).toBe(false);
    expect(sameType(sqlType.number(), { kind: 'OTHER', name: 'NUMBER' })).toBe(false);
    expect(sameType(sqlType.varchar(), sqlType.varchar(16_777_216))).toBe(true);
    expect(sameType(sqlType.varchar(), sqlType.varchar(134_217_728))).toBe(true);
    expect(sameType(sqlType.varchar(), sqlType.varchar())).toBe(true);
    expect(sameType(sqlType.varchar(), sqlType.varchar(10))).toBe(false);
    expect(sameType(sqlType.varchar(10), sqlType.varchar(10))).toBe(true);
    expect(sameType(sqlType.varchar(10), sqlType.varchar())).toBe(false);
    expect(sameType(sqlType.binary(), sqlType.binary(4))).toBe(true);
    expect(sameType(sqlType.binary(4), sqlType.binary())).toBe(true);
    expect(sameType(sqlType.binary(4), sqlType.binary(4))).toBe(true);
    expect(sameType(sqlType.binary(4), sqlType.binary(5))).toBe(false);
    expect(sameType(sqlType.time(3), sqlType.time(3))).toBe(true);
    expect(sameType(sqlType.timestamp('ntz', 3), sqlType.timestamp('ntz', 9))).toBe(false);
    expect(sameType(sqlType.timestamp('ltz'), sqlType.timestamp('ltz'))).toBe(true);
    expect(sameType(sqlType.timestamp('tz'), sqlType.timestamp('tz'))).toBe(true);
    expect(sameType(sqlType.variant(), sqlType.variant())).toBe(true);
    expect(sameType(sqlType.geography(), sqlType.geography())).toBe(true);
    expect(sameType(sqlType.vector('int', 3), sqlType.vector('int', 3))).toBe(true);
    expect(sameType(sqlType.vector('int', 3), sqlType.vector('float', 3))).toBe(false);
    expect(sameType(sqlType.vector('int', 3), sqlType.vector('int', 4))).toBe(false);
    expect(alterableType(sqlType.vector('int', 3), sqlType.vector('int', 4))).toBe(false);
    expect(alterableType(sqlType.varchar(10), sqlType.varchar(20))).toBe(true);
    expect(alterableType(sqlType.varchar(10), sqlType.varchar())).toBe(true);
    expect(alterableType(sqlType.varchar(20), sqlType.varchar(10))).toBe(false);
    expect(alterableType(sqlType.varchar(), sqlType.varchar(10))).toBe(false);
    expect(alterableType(sqlType.number(10, 2), sqlType.number(8, 2))).toBe(true);
    expect(alterableType(sqlType.number(10, 2), sqlType.number(10, 3))).toBe(false);
    expect(alterableType(sqlType.float(), sqlType.number())).toBe(false);
    expect(alterableType(sqlType.number(), sqlType.varchar())).toBe(false);
  });
});

describe('DDL statements', () => {
  const customers = snowflakeTable(
    'CUSTOMERS',
    { id: integer('ID').notNull(), name: text('NAME') },
    { database: 'DB', schema: 'APP' },
  );

  it('compiles schema and table statements with quoted names and escaped literals', () => {
    const schema = identifier('My DB', 'S"1');
    expect(sqlOf(createSchema(schema))).toBe('CREATE SCHEMA "My DB"."S""1"');
    expect(sqlOf(createSchema(schema, { ifNotExists: true, comment: "it's \\ ok" }))).toBe(
      `CREATE SCHEMA IF NOT EXISTS "My DB"."S""1" COMMENT = 'it''s \\\\ ok'`,
    );
    expect(sqlOf(dropSchema(schema))).toBe('DROP SCHEMA "My DB"."S""1" RESTRICT');
    expect(sqlOf(dropSchema(schema, { ifExists: true, cascade: true }))).toBe(
      'DROP SCHEMA IF EXISTS "My DB"."S""1" CASCADE',
    );
    expect(sqlOf(setSchemaComment(schema, 'x'))).toBe(
      `ALTER SCHEMA "My DB"."S""1" SET COMMENT = 'x'`,
    );
    expect(sqlOf(setSchemaComment(schema, null))).toBe('ALTER SCHEMA "My DB"."S""1" UNSET COMMENT');

    const definition = defineTable(customers, {
      comment: 'People',
      comments: { name: 'Shown' },
    });
    expect(sqlOf(createTable(definition))).toBe(
      `CREATE TABLE "DB"."APP"."CUSTOMERS" ("ID" NUMBER(38, 0) NOT NULL, "NAME" VARCHAR COMMENT 'Shown') COMMENT = 'People'`,
    );
    expect(sqlOf(createTable(defineTable(customers), { ifNotExists: true }))).toBe(
      'CREATE TABLE IF NOT EXISTS "DB"."APP"."CUSTOMERS" ("ID" NUMBER(38, 0) NOT NULL, "NAME" VARCHAR)',
    );
    const replace = createTable(
      defineTable(customers, { comment: null, comments: { name: null } }),
      {
        orReplace: true,
      },
    );
    expect(sqlOf(replace)).toBe(
      'CREATE OR REPLACE TABLE "DB"."APP"."CUSTOMERS" ("ID" NUMBER(38, 0) NOT NULL, "NAME" VARCHAR)',
    );
    expect(replace.destructive).toBe(true);
    expect(createTable(definition).destructive).toBe(false);
    expect(() => createTable(definition, { ifNotExists: true, orReplace: true })).toThrow(
      'OR REPLACE',
    );
    expect(sqlOf(dropTable(customers))).toBe('DROP TABLE "DB"."APP"."CUSTOMERS"');
    expect(sqlOf(dropTable(identifier('T'), { ifExists: true }))).toBe('DROP TABLE IF EXISTS "T"');
    expect(dropTable(customers).destructive).toBe(true);
    expect(dropSchema(schema).destructive).toBe(true);
    expect(createTable(definition).compile().binds).toEqual([]);
    expect(Object.isFrozen(createTable(definition).node)).toBe(true);
  });

  it('compiles ALTER TABLE actions', () => {
    const alter = alterTable(customers);
    expect(
      [
        alter.renameTo('CLIENTS'),
        alter.setComment('c'),
        alter.setComment(null),
        alter.addColumn('AGE', sqlType.number(3, 0)),
        alter.addColumn('CODE', sqlType.varchar(4), {
          notNull: true,
          comment: 'k',
        }),
        alter.dropColumn('NAME'),
        alter.renameColumn('NAME', 'FULL_NAME'),
        alter.setColumnType('NAME', sqlType.varchar(50)),
        alter.setNotNull('NAME'),
        alter.dropNotNull('NAME'),
        alter.setColumnComment('NAME', 'n'),
        alter.setColumnComment('NAME', null),
      ].map(sqlOf),
    ).toEqual([
      'ALTER TABLE "DB"."APP"."CUSTOMERS" RENAME TO "DB"."APP"."CLIENTS"',
      `ALTER TABLE "DB"."APP"."CUSTOMERS" SET COMMENT = 'c'`,
      'ALTER TABLE "DB"."APP"."CUSTOMERS" UNSET COMMENT',
      'ALTER TABLE "DB"."APP"."CUSTOMERS" ADD COLUMN "AGE" NUMBER(3, 0)',
      `ALTER TABLE "DB"."APP"."CUSTOMERS" ADD COLUMN "CODE" VARCHAR(4) NOT NULL COMMENT 'k'`,
      'ALTER TABLE "DB"."APP"."CUSTOMERS" DROP COLUMN "NAME"',
      'ALTER TABLE "DB"."APP"."CUSTOMERS" RENAME COLUMN "NAME" TO "FULL_NAME"',
      'ALTER TABLE "DB"."APP"."CUSTOMERS" ALTER COLUMN "NAME" SET DATA TYPE VARCHAR(50)',
      'ALTER TABLE "DB"."APP"."CUSTOMERS" ALTER COLUMN "NAME" SET NOT NULL',
      'ALTER TABLE "DB"."APP"."CUSTOMERS" ALTER COLUMN "NAME" DROP NOT NULL',
      `ALTER TABLE "DB"."APP"."CUSTOMERS" ALTER COLUMN "NAME" COMMENT 'n'`,
      'ALTER TABLE "DB"."APP"."CUSTOMERS" ALTER COLUMN "NAME" UNSET COMMENT',
    ]);
    expect(sqlOf(alterTable(identifier('T')).renameTo('U'))).toBe('ALTER TABLE "T" RENAME TO "U"');
    expect(alter.dropColumn('NAME').destructive).toBe(true);
    expect(alter.renameColumn('NAME', 'X').destructive).toBe(false);
    expect(() => alter.addColumn('', sqlType.varchar())).toThrow(TypeError);
    expect(() =>
      compileDdl({
        kind: 'unknown',
        name: identifier('T'),
      } as unknown as DdlNode),
    ).toThrow('Unsupported DDL AST node.');
  });
});

describe('desired schema definitions', () => {
  it('derives physical columns from declarations and validates options', () => {
    const table = snowflakeTable('T', {
      id: integer('ID').notNull(),
      amount: decimal('AMOUNT'),
      payload: variant('PAYLOAD'),
    });
    const definition = defineTable(table, {
      types: { amount: sqlType.number(12, 4), payload: sqlType.array() },
      comments: { id: 'key', amount: null },
    });
    expect(definition).toEqual({
      kind: 'table-definition',
      name: identifier('T'),
      columns: [
        {
          key: 'id',
          name: 'ID',
          type: sqlType.number(),
          notNull: true,
          comment: 'key',
        },
        {
          key: 'amount',
          name: 'AMOUNT',
          type: sqlType.number(12, 4),
          notNull: false,
          comment: null,
        },
        {
          key: 'payload',
          name: 'PAYLOAD',
          type: sqlType.array(),
          notNull: false,
        },
      ],
    });
    expect(() => defineTable(table)).toThrow('decimal()');
    expect(() =>
      defineTable(table, {
        types: {
          amount: sqlType.number(1, 0),
          missing: sqlType.date(),
        } as never,
      }),
    ).toThrow('Unknown column key in types: missing.');
    expect(() =>
      defineTable(table, {
        types: { amount: sqlType.number(1, 0) },
        comments: { nope: 'x' } as never,
      }),
    ).toThrow('Unknown column key in comments: nope.');
    expect(() => defineTable(alias(table, 'a') as never)).toThrow('base snowflakeTable()');
    expect(() => defineTable(timeTravel(table, { offset: -1 }) as never)).toThrow(
      'base snowflakeTable()',
    );
    const events = snowflakeTable('E', { payload: variant('PAYLOAD') });
    expect(() => defineTable(flatten(events.columns.payload, 'f') as never)).toThrow(
      'base snowflakeTable()',
    );
  });

  it('places tables in the target schema and rejects foreign or duplicate tables', () => {
    const plain = snowflakeTable('A', { id: integer('ID') });
    const inSchema = snowflakeTable('B', { id: integer('ID') }, { schema: 'APP' });
    const qualified = snowflakeTable('C', { id: integer('ID') }, target);
    const schema = defineSchema({ ...target, comment: 'app' }, [
      plain,
      defineTable(inSchema),
      qualified,
    ]);
    expect(schema.name).toEqual(identifier('DB', 'APP'));
    expect(schema.comment).toBe('app');
    expect(schema.tables.map((table) => table.name.parts)).toEqual([
      ['DB', 'APP', 'A'],
      ['DB', 'APP', 'B'],
      ['DB', 'APP', 'C'],
    ]);
    expect(defineSchema(target, [plain])).not.toHaveProperty('comment');
    expect(() =>
      defineSchema(target, [snowflakeTable('D', { id: integer('ID') }, { schema: 'OTHER' })]),
    ).toThrow('Table D is declared outside DB.APP.');
    expect(() =>
      defineSchema(target, [
        snowflakeTable('D', { id: integer('ID') }, { database: 'X', schema: 'APP' }),
      ]),
    ).toThrow('outside');
    expect(() =>
      defineSchema(target, [plain, snowflakeTable('A', { x: text('X') }, target)]),
    ).toThrow('Duplicate table names');
  });
});

const column = (
  name: string,
  type: ObservedTable['columns'][number]['type'],
  notNull = false,
  comment: string | null = null,
) => ({
  name,
  type,
  notNull,
  comment,
  serverValue: null,
});
function observed(tables: ObservedTable[], extra: Partial<ObservedSchema> = {}): ObservedSchema {
  return { ...target, exists: true, comment: null, tables, ...extra };
}

describe('schema diffs', () => {
  const users = snowflakeTable(
    'USERS',
    {
      id: integer('ID').notNull(),
      name: text('NAME').notNull(),
      email: text('EMAIL'),
      score: decimal('SCORE'),
      note: text('NOTE'),
      tag: text('TAG'),
    },
    target,
  );
  const definition = defineTable(users, {
    types: {
      name: sqlType.varchar(100),
      score: sqlType.number(10, 2),
      tag: sqlType.varchar(5),
    },
    comments: { email: 'mail', note: null },
    comment: 'users',
  });

  it('creates a missing schema and its tables', () => {
    const diff = diffSchema(
      defineSchema({ ...target, comment: 'app' }, [definition]),
      observed([], { exists: false }),
    );
    expect(diff.changes.map((change) => sqlOf(change.statement))).toEqual([
      `CREATE SCHEMA "DB"."APP" COMMENT = 'app'`,
      `CREATE TABLE "DB"."APP"."USERS" ("ID" NUMBER(38, 0) NOT NULL, "NAME" VARCHAR(100) NOT NULL, "EMAIL" VARCHAR COMMENT 'mail', "SCORE" NUMBER(10, 2), "NOTE" VARCHAR, "TAG" VARCHAR(5)) COMMENT = 'users'`,
    ]);
    expect(
      diffSchema(defineSchema(target, [definition]), observed([], { exists: false })).changes[0]
        ?.description,
    ).toBe('Create schema APP');
    expect(() =>
      diffSchema(defineSchema(target, []), {
        ...observed([]),
        schema: 'OTHER',
      }),
    ).toThrow('not the desired schema');
    expect(() =>
      diffSchema(defineSchema(target, []), {
        ...observed([]),
        database: 'OTHER',
      }),
    ).toThrow('not the desired schema');
  });

  it('alters columns and comments in declaration order, then drops extras by name', () => {
    const current = observed(
      [
        {
          name: 'USERS',
          comment: 'old',
          columns: [
            column('ID', sqlType.number(), true),
            column('NAME', sqlType.varchar(50), false),
            column('EMAIL', sqlType.varchar(16_777_216), true, null),
            column('SCORE', sqlType.number(10, 4)),
            column('NOTE', { kind: 'OTHER', name: 'GEOGRAPHY' }, false, 'remove me'),
            column('TAG', sqlType.varchar(5), false, 'kept'),
            column('LEGACY', sqlType.boolean()),
          ],
        },
        {
          name: 'ZED',
          comment: null,
          columns: [column('ID', sqlType.number())],
        },
        {
          name: 'IGNORED',
          comment: null,
          columns: [column('ID', sqlType.number())],
        },
        {
          name: 'ALPHA',
          comment: null,
          columns: [column('ID', sqlType.number())],
        },
      ],
      { comment: 'schema' },
    );
    const diff = diffSchema(defineSchema({ ...target, comment: null }, [definition]), current, {
      ignoreTables: ['IGNORED'],
    });
    expect(
      diff.changes.map((change) => [
        change.description,
        sqlOf(change.statement),
        change.destructive,
      ]),
    ).toEqual([
      ['Set comment on schema APP', 'ALTER SCHEMA "DB"."APP" UNSET COMMENT', false],
      [
        'Change USERS.NAME from VARCHAR(50) to VARCHAR(100)',
        'ALTER TABLE "DB"."APP"."USERS" ALTER COLUMN "NAME" SET DATA TYPE VARCHAR(100)',
        false,
      ],
      [
        'Set NOT NULL on USERS.NAME',
        'ALTER TABLE "DB"."APP"."USERS" ALTER COLUMN "NAME" SET NOT NULL',
        false,
      ],
      [
        'Drop NOT NULL on USERS.EMAIL',
        'ALTER TABLE "DB"."APP"."USERS" ALTER COLUMN "EMAIL" DROP NOT NULL',
        false,
      ],
      [
        'Set comment on USERS.EMAIL',
        `ALTER TABLE "DB"."APP"."USERS" ALTER COLUMN "EMAIL" COMMENT 'mail'`,
        false,
      ],
      [
        'Set comment on USERS.NOTE',
        'ALTER TABLE "DB"."APP"."USERS" ALTER COLUMN "NOTE" UNSET COMMENT',
        false,
      ],
      ['Drop column USERS.LEGACY', 'ALTER TABLE "DB"."APP"."USERS" DROP COLUMN "LEGACY"', true],
      ['Set comment on table USERS', `ALTER TABLE "DB"."APP"."USERS" SET COMMENT = 'users'`, false],
      ['Drop table ALPHA', 'DROP TABLE "DB"."APP"."ALPHA"', true],
      ['Drop table ZED', 'DROP TABLE "DB"."APP"."ZED"', true],
    ]);
    expect(diff.unsupported).toEqual([
      {
        table: 'USERS',
        column: 'SCORE',
        reason: 'Cannot change NUMBER(10, 4) to NUMBER(10, 2) in place.',
      },
      {
        table: 'USERS',
        column: 'NOTE',
        reason: 'Cannot change GEOGRAPHY to VARCHAR in place.',
      },
    ]);
  });

  it('reports a NOT NULL column missing from an existing table as unsupported', () => {
    const plain = defineTable(users, {
      types: { score: sqlType.number(10, 2) },
    });
    const current = observed([
      {
        name: 'USERS',
        comment: null,
        columns: [
          column('ID', sqlType.number(), true),
          column('EMAIL', sqlType.varchar()),
          column('SCORE', sqlType.number(10, 2)),
          column('NOTE', sqlType.varchar()),
          column('TAG', sqlType.varchar()),
        ],
      },
    ]);
    expect(diffSchema(defineSchema(target, [plain]), current)).toEqual({
      changes: [],
      unsupported: [
        {
          table: 'USERS',
          column: 'NAME',
          reason: 'Adding a NOT NULL column to an existing table needs a default or backfill.',
        },
      ],
    });
  });

  it('adds missing columns and leaves matching or unmanaged state alone', () => {
    const plain = defineTable(users, {
      types: { score: sqlType.number(10, 2) },
    });
    const current = observed(
      [
        {
          name: 'USERS',
          comment: 'anything',
          columns: [
            column('ID', sqlType.number(), true, 'unmanaged'),
            column('NAME', sqlType.varchar(134_217_728), true),
            column('EMAIL', sqlType.varchar()),
            column('SCORE', sqlType.number(10, 2)),
          ],
        },
      ],
      { comment: 'kept' },
    );
    const diff = diffSchema(defineSchema(target, [plain]), current);
    expect(diff.changes.map((change) => sqlOf(change.statement))).toEqual([
      'ALTER TABLE "DB"."APP"."USERS" ADD COLUMN "NOTE" VARCHAR',
      'ALTER TABLE "DB"."APP"."USERS" ADD COLUMN "TAG" VARCHAR',
    ]);
    const commented = defineTable(users, {
      types: { score: sqlType.number(10, 2) },
      comments: { note: 'n', tag: null },
    });
    expect(
      diffSchema(defineSchema({ ...target, comment: 'kept' }, [commented]), current).changes.map(
        (change) => sqlOf(change.statement),
      ),
    ).toEqual([
      `ALTER TABLE "DB"."APP"."USERS" ADD COLUMN "NOTE" VARCHAR COMMENT 'n'`,
      'ALTER TABLE "DB"."APP"."USERS" ADD COLUMN "TAG" VARCHAR',
    ]);
    expect(
      diffSchema(defineSchema({ ...target, comment: 'new' }, []), observed([])).changes[0]
        ?.description,
    ).toBe('Set comment on schema APP');
  });
});

describe('schema inspection', () => {
  const row = (name: string, type: string, values: Record<string, string | null> = {}) => ({
    TABLE_NAME: 'T',
    COLUMN_NAME: name,
    DATA_TYPE: type,
    IS_NULLABLE: 'YES',
    CHARACTER_MAXIMUM_LENGTH: null,
    NUMERIC_PRECISION: null,
    NUMERIC_SCALE: null,
    DATETIME_PRECISION: null,
    COLUMN_DEFAULT: null,
    IS_IDENTITY: 'NO',
    COMMENT: null,
    DATA_TYPE_ALIAS: null,
    IDENTITY_START: null,
    IDENTITY_INCREMENT: null,
    IDENTITY_ORDERED: null,
    KIND: 'COLUMN',
    EXPRESSION: null,
    ...values,
  });

  it('reads base tables with bound filters and maps metadata types', async () => {
    const results = [
      [{ COMMENT: 'schema' }],
      [
        { TABLE_NAME: 'T', COMMENT: 'table' },
        { TABLE_NAME: 'EMPTY', COMMENT: null },
      ],
      [
        row('N', 'NUMBER', {
          NUMERIC_PRECISION: '10',
          NUMERIC_SCALE: '2',
          IS_NULLABLE: 'NO',
        }),
        row('N0', 'NUMBER'),
        row('S', 'TEXT', { CHARACTER_MAXIMUM_LENGTH: '20', COMMENT: 'c' }),
        row('S0', 'TEXT'),
        row('TM', 'TIME', { DATETIME_PRECISION: '3' }),
        row('NTZ', 'TIMESTAMP_NTZ'),
        row('LTZ', 'TIMESTAMP_LTZ', { DATETIME_PRECISION: '6' }),
        row('TZ', 'TIMESTAMP_TZ', { DATETIME_PRECISION: '0' }),
        row('B', 'BINARY'),
        row('F', 'FLOAT'),
        row('BO', 'BOOLEAN'),
        row('D', 'DATE'),
        row('V', 'VARIANT'),
        row('A', 'ARRAY'),
        row('O', 'OBJECT'),
        row('G', 'GEOGRAPHY', { COLUMN_DEFAULT: "'x'" }),
        row('GM', 'GEOMETRY'),
        row('VE', 'VECTOR', { DATA_TYPE_ALIAS: 'VECTOR(INT, 3)' }),
        row('VF', 'VECTOR', { DATA_TYPE_ALIAS: 'VECTOR(FLOAT, 256)' }),
        row('VX', 'VECTOR'),
        row('SA', 'ARRAY', { DATA_TYPE_ALIAS: 'ARRAY(NUMBER(38, 0))' }),
        row('PA', 'ARRAY', { DATA_TYPE_ALIAS: 'ARRAY' }),
        row('DF', 'DECFLOAT', { DATA_TYPE_ALIAS: 'DECFLOAT' }),
        row('UK', 'UNKNOWN'),
        row('ID', 'NUMBER', {
          IS_IDENTITY: 'YES',
          IDENTITY_START: '5',
          IDENTITY_INCREMENT: '-2',
          IDENTITY_ORDERED: 'NO',
        }),
        row('ID0', 'NUMBER', { IS_IDENTITY: 'YES' }),
        row('VC', 'NUMBER', { KIND: 'VIRTUAL_COLUMN', EXPRESSION: 'N * 2' }),
        row('VC0', 'NUMBER', { KIND: 'VIRTUAL_COLUMN' }),
        { ...row('X', 'NUMBER'), TABLE_NAME: 'VIEW_ONLY' },
      ],
    ];
    const queryRaw = vi.fn(async (_query: RawQuery) => results.shift());
    const schema = await inspectSchema({ queryRaw } as unknown as SnowflakeClient, {
      database: 'Odd"DB',
      schema: "S'; --",
    });
    expect(queryRaw.mock.calls.map(([query]) => query.compile().binds)).toEqual([
      ["S'; --"],
      ["S'; --"],
      ["S'; --"],
    ]);
    expect(queryRaw.mock.calls[2]?.[0].compile().sql).toContain(
      '"Odd""DB"."INFORMATION_SCHEMA"."COLUMNS"',
    );
    expect(schema).toMatchObject({
      database: 'Odd"DB',
      exists: true,
      comment: 'schema',
    });
    expect(schema.tables.map((table) => [table.name, table.comment, table.columns.length])).toEqual(
      [
        ['T', 'table', 28],
        ['EMPTY', null, 0],
      ],
    );
    expect(schema.tables[0]?.columns.map((entry) => entry.type)).toEqual([
      sqlType.number(10, 2),
      sqlType.number(),
      sqlType.varchar(20),
      sqlType.varchar(),
      sqlType.time(3),
      sqlType.timestamp('ntz'),
      sqlType.timestamp('ltz', 6),
      sqlType.timestamp('tz', 0),
      sqlType.binary(),
      sqlType.float(),
      sqlType.boolean(),
      sqlType.date(),
      sqlType.variant(),
      sqlType.array(),
      sqlType.object(),
      sqlType.geography(),
      sqlType.geometry(),
      sqlType.vector('int', 3),
      sqlType.vector('float', 256),
      { kind: 'OTHER', name: 'VECTOR' },
      { kind: 'OTHER', name: 'ARRAY(NUMBER(38, 0))' },
      sqlType.array(),
      { kind: 'OTHER', name: 'DECFLOAT' },
      { kind: 'OTHER', name: 'UNKNOWN' },
      sqlType.number(),
      sqlType.number(),
      sqlType.number(),
      sqlType.number(),
    ]);
    expect(schema.tables[0]?.columns[0]).toMatchObject({
      notNull: true,
      comment: null,
    });
    expect(schema.tables[0]?.columns[2]).toMatchObject({
      notNull: false,
      comment: 'c',
    });
    expect(schema.tables[0]?.columns.map((entry) => entry.serverValue)).toEqual([
      ...Array(15).fill(null),
      { kind: 'default', expression: "'x'" },
      ...Array(8).fill(null),
      { kind: 'identity', start: 5, increment: -2, order: false },
      { kind: 'identity' },
      { kind: 'virtual', expression: 'N * 2' },
      { kind: 'virtual' },
    ]);
    expect(Object.isFrozen(schema.tables[0]?.columns[15]?.serverValue)).toBe(true);
    expect(queryRaw.mock.calls[2]?.[0].compile().sql).toContain(
      'IDENTITY_ORDERED, KIND, EXPRESSION',
    );
  });

  it('reports a missing schema and rejects malformed metadata', async () => {
    const empty = { queryRaw: async () => [] } as unknown as SnowflakeClient;
    expect(await inspectSchema(empty, target)).toEqual({
      ...target,
      exists: false,
      comment: null,
      tables: [],
    });
    const results: unknown[] = [[], [], [row('N', 'NUMBER', { NUMERIC_PRECISION: '1.5' })]];
    const malformed = {
      queryRaw: async () => results.shift(),
    } as unknown as SnowflakeClient;
    await expect(inspectSchema(malformed, target)).rejects.toThrow();
  });
});

describe('server values', () => {
  const events = snowflakeTable(
    'EVENTS',
    {
      id: integer('ID').notNull().identity({ start: 5, increment: 2, order: true }),
      seq: integer('SEQ').identity(),
      kind: text('KIND', { length: 10 }).notNull().serverDefault("'click'"),
      at: timestamp('AT').serverDefault('CURRENT_TIMESTAMP()'),
      label: text('LABEL').virtual('UPPER("KIND")'),
      note: text('NOTE'),
    },
    target,
  );
  const definition = defineTable(events);
  const table = (columns: ObservedTable['columns']) =>
    observed([{ name: 'EVENTS', comment: null, columns }]);
  const unsupportedOf = (current: ObservedSchema, entry = definition) =>
    diffSchema(defineSchema(target, [entry]), current).unsupported.map(
      (change) => `${change.column}: ${change.reason}`,
    );
  const sqlChanges = (current: ObservedSchema, entry = definition) =>
    diffSchema(defineSchema(target, [entry]), current).changes.map((change) =>
      sqlOf(change.statement),
    );

  it('renders DEFAULT, AUTOINCREMENT, and AS clauses', () => {
    expect(definition.columns.map((entry) => entry.serverValue)).toEqual([
      { kind: 'identity', start: 5, increment: 2, order: true },
      { kind: 'identity' },
      { kind: 'default', expression: "'click'" },
      { kind: 'default', expression: 'CURRENT_TIMESTAMP()' },
      { kind: 'virtual', expression: 'UPPER("KIND")' },
      undefined,
    ]);
    expect(sqlOf(createTable(definition))).toBe(
      `CREATE TABLE "DB"."APP"."EVENTS" ("ID" NUMBER(38, 0) AUTOINCREMENT START 5 INCREMENT 2 ORDER NOT NULL, "SEQ" NUMBER(38, 0) AUTOINCREMENT, "KIND" VARCHAR(10) DEFAULT 'click' NOT NULL, "AT" TIMESTAMP_NTZ(9) DEFAULT CURRENT_TIMESTAMP(), "LABEL" VARCHAR AS (UPPER("KIND")), "NOTE" VARCHAR)`,
    );
    const alter = alterTable(events);
    expect(
      [
        alter.addColumn('N', sqlType.float(), { serverValue: { kind: 'identity', increment: -1 } }),
        alter.addColumn('M', sqlType.number(), {
          serverValue: { kind: 'identity', start: 3, order: false },
        }),
        alter.addColumn('C', sqlType.varchar(), {
          notNull: true,
          comment: 'c',
          serverValue: { kind: 'default', expression: "'x'" },
        }),
        alter.dropDefault('KIND'),
      ].map(sqlOf),
    ).toEqual([
      'ALTER TABLE "DB"."APP"."EVENTS" ADD COLUMN "N" FLOAT AUTOINCREMENT START 1 INCREMENT -1',
      'ALTER TABLE "DB"."APP"."EVENTS" ADD COLUMN "M" NUMBER(38, 0) AUTOINCREMENT START 3 INCREMENT 1 NOORDER',
      `ALTER TABLE "DB"."APP"."EVENTS" ADD COLUMN "C" VARCHAR DEFAULT 'x' NOT NULL COMMENT 'c'`,
      'ALTER TABLE "DB"."APP"."EVENTS" ALTER COLUMN "KIND" DROP DEFAULT',
    ]);
    expect(alter.dropDefault('KIND').destructive).toBe(false);
  });

  it('rejects server values Snowflake DDL cannot express', () => {
    expect(() => defineTable(snowflakeTable('T', { a: text('A').serverDefault() }))).toThrow(
      'Column A needs a serverDefault expression for DDL.',
    );
    expect(() => defineTable(snowflakeTable('T', { a: text('A').virtual() }))).toThrow(
      'Column A needs a virtual expression for DDL.',
    );
    expect(() => defineTable(snowflakeTable('T', { a: text('A').identity() }))).toThrow(
      'Identity column A cannot be stored as VARCHAR.',
    );
    expect(() => defineTable(snowflakeTable('T', { a: text('A').notNull().virtual('1') }))).toThrow(
      'Virtual column A cannot be NOT NULL.',
    );
    expect(() =>
      alterTable(identifier('T')).addColumn('A', sqlType.date(), {
        serverValue: { kind: 'identity' },
      }),
    ).toThrow('Identity column A cannot be stored as DATE.');
  });

  it('adds constant-default and virtual columns, and reports other additions as unsupported', () => {
    const current = table([column('NOTE', sqlType.varchar())]);
    expect(sqlChanges(current)).toEqual([
      `ALTER TABLE "DB"."APP"."EVENTS" ADD COLUMN "KIND" VARCHAR(10) DEFAULT 'click' NOT NULL`,
      'ALTER TABLE "DB"."APP"."EVENTS" ADD COLUMN "LABEL" VARCHAR AS (UPPER("KIND"))',
    ]);
    expect(unsupportedOf(current)).toEqual([
      'ID: Adding an identity column to an existing table needs a rebuild.',
      'SEQ: Adding an identity column to an existing table needs a rebuild.',
      'AT: Snowflake only accepts constant defaults when adding a column.',
    ]);
    const constants = ['0', '-1.5e3', '+2', "'it''s'", 'TRUE', 'false', 'NULL', " 'x' "];
    for (const expression of constants) {
      const entry = defineTable(
        snowflakeTable('EVENTS', { c: text('C').serverDefault(expression) }, target),
      );
      expect(sqlChanges(table([]), entry)).toHaveLength(1);
    }
    for (const expression of ['1 + 1', "'a' || 'b'", 'CURRENT_DATE()', "'unterminated"]) {
      const entry = defineTable(
        snowflakeTable('EVENTS', { c: text('C').serverDefault(expression) }, target),
      );
      expect(unsupportedOf(table([]), entry)).toEqual([
        'C: Snowflake only accepts constant defaults when adding a column.',
      ]);
    }
  });

  it('compares server value kinds and declared identity options, not expression text', () => {
    const matching = table([
      {
        ...column('ID', sqlType.number(), true),
        serverValue: { kind: 'identity', start: 5, increment: 2, order: true },
      },
      {
        ...column('SEQ', sqlType.number()),
        serverValue: { kind: 'identity', start: 9, increment: 3, order: false },
      },
      {
        ...column('KIND', sqlType.varchar(10), true),
        serverValue: { kind: 'default', expression: "'click'" },
      },
      {
        ...column('AT', sqlType.timestamp()),
        serverValue: { kind: 'default', expression: 'CURRENT_TIMESTAMP()' },
      },
      {
        ...column('LABEL', sqlType.varchar(16_777_216)),
        serverValue: { kind: 'virtual', expression: 'UPPER(KIND)' },
      },
      {
        ...column('NOTE', sqlType.varchar()),
        serverValue: { kind: 'default', expression: "'unmanaged'" },
      },
    ]);
    expect(diffSchema(defineSchema(target, [definition]), matching)).toEqual({
      changes: [],
      unsupported: [],
    });
    const drifted = table([
      {
        ...column('ID', sqlType.number(), true),
        serverValue: { kind: 'identity', start: 1, increment: 1, order: false },
      },
      column('SEQ', sqlType.number()),
      {
        ...column('KIND', sqlType.varchar(10), true),
        serverValue: { kind: 'virtual', expression: "'click'" },
      },
      column('AT', sqlType.timestamp()),
      {
        ...column('LABEL', sqlType.varchar()),
        serverValue: { kind: 'default', expression: "'x'" },
      },
      column('NOTE', sqlType.varchar()),
    ]);
    expect(unsupportedOf(drifted)).toEqual([
      'ID: Cannot change the AUTOINCREMENT start, increment, order in place.',
      'SEQ: Cannot change no server value to AUTOINCREMENT in place.',
      'KIND: Cannot change a virtual expression to a DEFAULT in place.',
      'AT: Cannot change no server value to a DEFAULT in place.',
      'LABEL: Cannot change a DEFAULT to a virtual expression in place.',
    ]);
  });
});

describe('DDL declarations keep column codecs usable', () => {
  it('accepts every scalar codec', () => {
    const table = snowflakeTable('ALL', {
      a: text('A'),
      b: integer('B'),
      c: decimal('C'),
      d: boolean('D'),
      e: float('E'),
      f: date('F'),
      g: time('G'),
      h: timestamp('H', 'tz'),
      i: variant('I'),
      j: binary('J'),
      k: array('K'),
      l: object('L'),
      m: geography('M'),
      n: geometry('N', { srid: 4326 }),
      o: vector('O', 'float', 8),
    });
    expect(
      createTable(defineTable(table, { types: { c: sqlType.number(5, 1) } })).compile().sql,
    ).toBe(
      'CREATE TABLE "ALL" ("A" VARCHAR, "B" NUMBER(38, 0), "C" NUMBER(5, 1), "D" BOOLEAN, "E" FLOAT, "F" DATE, "G" TIME(9), "H" TIMESTAMP_TZ(9), "I" VARIANT, "J" BINARY, "K" ARRAY, "L" OBJECT, "M" GEOGRAPHY, "N" GEOMETRY, "O" VECTOR(FLOAT, 8))',
    );
  });
});
