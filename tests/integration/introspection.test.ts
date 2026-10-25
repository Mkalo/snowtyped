import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  generateSchema,
  insert,
  introspect,
  type Snowtyped,
  select,
  snowflakeTable,
  sql,
  text,
} from '../../src/index.js';
import { createFixture, integrationConfig, tableIdentifier } from '../support/snowflake.js';

const SOURCE = resolve('src/index.ts');

function typecheck(file: string): string[] {
  const program = ts.createProgram([file], {
    strict: true,
    noEmit: true,
    noUnusedLocals: true,
    exactOptionalPropertyTypes: true,
    allowImportingTsExtensions: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    types: ['node'],
    typeRoots: [resolve('node_modules/@types')],
  });
  return ts
    .getPreEmitDiagnostics(program)
    .map((item) => ts.flattenDiagnosticMessageText(item.messageText, '\n'));
}

describe('introspection and generated declarations against Snowflake', () => {
  const fixture = createFixture(integrationConfig());
  const db = fixture.client;
  const database = fixture.table.node.parts[0] as string;
  const namespace = { database, schema: fixture.schemaName };
  const supported = snowflakeTable('ALL_TYPES', { id: text('ID') }, namespace);
  const mixed = snowflakeTable('Mixed table', { id: text('id') }, namespace);
  const geo = snowflakeTable('GEO', { id: text('ID') }, namespace);
  let tables: readonly Snowtyped.IntrospectedTable[] = [];
  let directory = '';

  beforeAll(async () => {
    await fixture.seed();
    await db.queryRaw(sql`CREATE TABLE ${tableIdentifier(supported)} (
      ID NUMBER(38,0) NOT NULL, SMALL INT, AMOUNT NUMBER(12,3) NOT NULL, PRICE DECIMAL(10,2),
      RATIO FLOAT, WIDE DOUBLE, NARROW REAL, NAME VARCHAR NOT NULL, CODE VARCHAR(10), FLAG_CHAR CHAR(2),
      NOTES STRING, BODY TEXT, ACTIVE BOOLEAN, DAY DATE, CLOCK TIME, NTZ TIMESTAMP_NTZ,
      LTZ TIMESTAMP_LTZ, TZ TIMESTAMP_TZ, DOC VARIANT, LIST ARRAY, MAP OBJECT, BYTES BINARY)`);
    await db.queryRaw(
      sql`CREATE TABLE ${tableIdentifier(mixed)} (${sql.identifier('id')} NUMBER(38,0) NOT NULL, ${sql.identifier('Display "Name"')} VARCHAR)`,
    );
    await db.queryRaw(sql`CREATE TABLE ${tableIdentifier(geo)} (ID NUMBER(38,0), PLACE GEOGRAPHY)`);
    tables = await introspect(db, namespace);
    directory = await mkdtemp(join(tmpdir(), 'snowtyped-generated-'));
  });
  afterAll(async () => {
    try {
      if (directory) await rm(directory, { recursive: true, force: true });
    } finally {
      await fixture.cleanup();
    }
  });

  it('reads every visible table in ordinal order with types, precision, and nullability', () => {
    expect(tables.map((table) => table.name)).toEqual([
      'ALL_TYPES',
      'CUSTOMERS',
      'GEO',
      'Mixed table',
    ]);
    expect(tables.every((table) => table.database === database)).toBe(true);
    expect(tables.every((table) => table.schema === fixture.schemaName)).toBe(true);
    const columns = tables.find((table) => table.name === 'ALL_TYPES')?.columns ?? [];
    expect(columns.map((column) => [column.name, column.dataType, column.nullable])).toEqual([
      ['ID', 'NUMBER', false],
      ['SMALL', 'NUMBER', true],
      ['AMOUNT', 'NUMBER', false],
      ['PRICE', 'NUMBER', true],
      ['RATIO', 'FLOAT', true],
      ['WIDE', 'FLOAT', true],
      ['NARROW', 'FLOAT', true],
      ['NAME', 'TEXT', false],
      ['CODE', 'TEXT', true],
      ['FLAG_CHAR', 'TEXT', true],
      ['NOTES', 'TEXT', true],
      ['BODY', 'TEXT', true],
      ['ACTIVE', 'BOOLEAN', true],
      ['DAY', 'DATE', true],
      ['CLOCK', 'TIME', true],
      ['NTZ', 'TIMESTAMP_NTZ', true],
      ['LTZ', 'TIMESTAMP_LTZ', true],
      ['TZ', 'TIMESTAMP_TZ', true],
      ['DOC', 'VARIANT', true],
      ['LIST', 'ARRAY', true],
      ['MAP', 'OBJECT', true],
      ['BYTES', 'BINARY', true],
    ]);
    expect(columns.find((column) => column.name === 'AMOUNT')).toMatchObject({
      precision: 12,
      scale: 3,
    });
    expect(columns.find((column) => column.name === 'SMALL')).toMatchObject({
      precision: 38,
      scale: 0,
    });
    expect(columns.find((column) => column.name === 'NAME')).toMatchObject({
      precision: null,
      scale: null,
    });
  });

  it('includes the schema when introspecting the whole database', async () => {
    const all = await introspect(db, { database });
    expect(
      all.filter((table) => table.schema === fixture.schemaName).map((table) => table.name),
    ).toEqual(tables.map((table) => table.name));
  });

  it('generates declarations that compile with the expected inferred types', async () => {
    const code = generateSchema(tables);
    const file = join(directory, 'checked.ts');
    await writeFile(
      file,
      `${code.replace("from 'snowtyped'", `from ${JSON.stringify(SOURCE)}`)}
import type { GeoJsonGeometry, InferSelection } from ${JSON.stringify(SOURCE)};
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;
type Row = InferSelection<typeof table0.columns>;
type Geo = InferSelection<typeof table2.columns>;
type Mixed = InferSelection<typeof table3.columns>;
export type Checks = [
  Expect<Equal<Row['ID'], bigint>>,
  Expect<Equal<Row['SMALL'], bigint | null>>,
  Expect<Equal<Row['AMOUNT'], string>>,
  Expect<Equal<Row['WIDE'], number | null>>,
  Expect<Equal<Row['NAME'], string>>,
  Expect<Equal<Row['ACTIVE'], boolean | null>>,
  Expect<Equal<Row['TZ'], string | null>>,
  Expect<Equal<Row['LIST'], unknown[] | null>>,
  Expect<Equal<Row['MAP'], Record<string, unknown> | null>>,
  Expect<Equal<Row['DOC'], unknown>>,
  Expect<Equal<Row['BYTES'], Uint8Array | null>>,
  Expect<Equal<Geo['PLACE'], GeoJsonGeometry | null>>,
  Expect<Equal<Mixed['id'], bigint>>,
  Expect<Equal<Mixed['Display "Name"'], string | null>>,
];
`,
    );
    expect(typecheck(file)).toEqual([]);
  }, 60_000);

  it('queries and writes the live schema through the generated declarations', async () => {
    const code = generateSchema(tables);
    const file = join(directory, 'runtime.ts');
    await writeFile(file, code.replace("from 'snowtyped'", `from ${JSON.stringify(SOURCE)}`));
    const generated = (await import(file)) as Record<string, Snowtyped.Table>;
    const [allTypes, customers, geoTable, mixedTable] = [
      'table0',
      'table1',
      'table2',
      'table3',
    ].map((key) => generated[key] as Snowtyped.Table);
    const row = {
      ID: 1n,
      SMALL: -5n,
      AMOUNT: '123456789.125',
      PRICE: '0.10',
      RATIO: 0.5,
      WIDE: -1.25,
      NARROW: 2,
      NAME: 'generated',
      CODE: 'c',
      FLAG_CHAR: 'ab',
      NOTES: 'notes',
      BODY: 'body',
      ACTIVE: false,
      DAY: '2026-10-23',
      CLOCK: '01:02:03.000000004',
      NTZ: '2026-10-23 01:02:03.000000004',
      LTZ: '2026-10-23 01:02:03.000000004 +00:00',
      TZ: '2026-10-23 01:02:03.000000004 -03:00',
      DOC: { any: ['json'] },
      LIST: [1, 'two'],
      MAP: { key: 'value' },
      BYTES: new Uint8Array([1, 2, 3]),
    };
    await db.execute(insert(allTypes as Snowtyped.Table, row as never));
    const [read] = (await db.execute(select(allTypes as Snowtyped.Table))).rows as Record<
      string,
      unknown
    >[];
    expect(read).toMatchObject({
      ...row,
      LTZ: expect.stringMatching(/^2026-10-2\d \d{2}:02:03\.000000004 /),
      BYTES: expect.any(Uint8Array),
    });
    expect([...((read?.BYTES as Uint8Array | undefined) ?? [])]).toEqual([1, 2, 3]);
    expect((await db.execute(select(customers as Snowtyped.Table))).rows).toHaveLength(3);
    await db.execute(
      insert(mixedTable as Snowtyped.Table, { id: 7n, 'Display "Name"': 'quoted' } as never),
    );
    expect((await db.execute(select(mixedTable as Snowtyped.Table))).rows).toEqual([
      { id: 7n, 'Display "Name"': 'quoted' },
    ]);
    const place = { type: 'Point', coordinates: [-122.35, 37.55] };
    await db.execute(insert(geoTable as Snowtyped.Table, { ID: 1n, PLACE: place } as never));
    expect((await db.execute(select(geoTable as Snowtyped.Table))).rows).toEqual([
      { ID: 1n, PLACE: place },
    ]);
  });
});
