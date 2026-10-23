import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import {
  eq,
  insert,
  integer,
  mergeInto,
  select,
  snowflakeTable,
  structured,
  structuredType as t,
  update,
} from '../../src/index.js';

describe('structured ARRAY, OBJECT, and MAP columns', () => {
  const table = snowflakeTable('S', {
    id: integer('ID').notNull(),
    scores: structured('SCORES', t.array(t.integer())).notNull(),
    address: structured(
      'ADDRESS',
      t.object({
        city: t.text(),
        'Zip "Code"': t.integer({ precision: 5 }),
        ok: t.boolean().notNull(),
      }),
    ),
    prices: structured(
      'PRICES',
      t.map(t.text({ length: 3 }), t.decimal({ precision: 10, scale: 2 })),
    ),
    tags: structured('TAGS', t.map(t.integer(), t.array(t.text().notNull()))),
  });
  const { scores, address, prices, tags } = table.columns;

  it('compiles exact SQL types and reads through a VARIANT cast', () => {
    expect(select(table).compile().sql).toContain(
      'TO_JSON(CAST("__sflib_result"."scores" AS VARIANT)) AS "scores"',
    );
    expect([scores.dataType, scores.wireType]).toEqual(['structured', 'structured']);
    expect(address.encode(null)).toEqual({
      kind: 'cast',
      value: { kind: 'function', name: 'PARSE_JSON', args: [{ kind: 'parameter', value: null }] },
      target: 'OBJECT("city" VARCHAR, "Zip ""Code""" NUMBER(5,0), "ok" BOOLEAN)',
    });
    expect(prices.encode(null)).toMatchObject({ target: 'MAP(VARCHAR(3), NUMBER(10,2))' });
    expect(tags.encode(null)).toMatchObject({ target: 'MAP(NUMBER(38,0), ARRAY(VARCHAR))' });
    expect(scores.encode([])).toMatchObject({ target: 'ARRAY(NUMBER(38,0))' });
    expect(t.decimal().sql).toBe('NUMBER(38,0)');
  });

  it('decodes exact numbers, SQL NULL elements, and declared field names', () => {
    expect(scores.readSchema.parse('[1,undefined,-99999999999999999999]')).toEqual([
      1n,
      null,
      -99999999999999999999n,
    ]);
    expect(
      address.readSchema.parse('{"Zip \\"Code\\"":null,"city":"undefined","ok":true}'),
    ).toEqual({ city: 'undefined', 'Zip "Code"': null, ok: true });
    expect(address.readSchema.parse(null)).toBeNull();
    expect(prices.readSchema.parse('{"abc":12345678.91,"b":null,"c":1.5,"d":-0.1,"e":7}')).toEqual(
      new Map([
        ['abc', '12345678.91'],
        ['b', null],
        ['c', '1.50'],
        ['d', '-0.10'],
        ['e', '7.00'],
      ]),
    );
    expect(tags.readSchema.parse('{"-2":["x"],"99999999999999999999":[]}')).toEqual(
      new Map([
        [-2n, ['x']],
        [99999999999999999999n, []],
      ]),
    );
    for (const input of [null, '[1.5]', '["1"]', '{}', '[true]', 'not json'])
      expect(() => scores.readSchema.parse(input)).toThrow(z.ZodError);
    for (const input of [
      '{"city":"X","ok":true}',
      '{"city":"X","Zip \\"Code\\"":1,"ok":null}',
      '{"city":"X","Zip \\"Code\\"":123456,"ok":true}',
      '{"city":1,"Zip \\"Code\\"":1,"ok":true}',
      '{"city":"X","Zip \\"Code\\"":1,"ok":true,"extra":1}',
    ])
      expect(() => address.readSchema.parse(input)).toThrow(z.ZodError);
    for (const input of ['{"abcd":1}', '{"a":1.234}', '{"a":"1"}'])
      expect(() => prices.readSchema.parse(input)).toThrow(z.ZodError);
    for (const input of ['{"x":[]}', '{"1":[undefined]}', '{"1.5":[]}'])
      expect(() => tags.readSchema.parse(input)).toThrow(z.ZodError);
  });

  it('writes exact JSON casts, including typed NULL, and validates values', () => {
    const rows = insert(table, [
      {
        id: 1n,
        scores: [99999999999999999999n, null],
        address: { city: 'X', 'Zip "Code"': 1234n, ok: false },
        prices: new Map([['a', '-007.50']]),
        tags: new Map([[3n, ['x', 'y']]]),
      },
      { id: 2n, scores: [] },
    ]).compile();
    const casts =
      'CAST(PARSE_JSON(?) AS ARRAY(NUMBER(38,0))) AS "__sflib_1", CAST(PARSE_JSON(?) AS OBJECT("city" VARCHAR, "Zip ""Code""" NUMBER(5,0), "ok" BOOLEAN)) AS "__sflib_2", CAST(PARSE_JSON(?) AS MAP(VARCHAR(3), NUMBER(10,2))) AS "__sflib_3", CAST(PARSE_JSON(?) AS MAP(NUMBER(38,0), ARRAY(VARCHAR))) AS "__sflib_4"';
    expect(rows.sql).toContain('VALUES ("__sflib_0", "__sflib_1", DEFAULT, DEFAULT, DEFAULT)');
    expect(rows.sql).toContain(
      `SELECT 0 AS "__sflib_shape", ? AS "__sflib_0", ${casts} UNION ALL SELECT 1 AS "__sflib_shape", ? AS "__sflib_0", ${casts}`,
    );
    expect(rows.binds).toEqual([
      '1',
      '[99999999999999999999,null]',
      '{"city":"X","Zip \\"Code\\"":1234,"ok":false}',
      '{"a":-7.50}',
      '{"3":["x","y"]}',
      '2',
      '[]',
      null,
      null,
      null,
    ]);
    expect(
      select(table)
        .where(eq(address, { city: null, 'Zip "Code"': null, ok: true }))
        .compile().binds,
    ).toEqual(['{"city":null,"Zip \\"Code\\"":null,"ok":true}']);
    expect(update(table, { prices: new Map() }).compile().binds).toEqual(['{}']);
    const staged = snowflakeTable('STAGED', { id: integer('ID').notNull() });
    expect(
      mergeInto(table, staged, eq(table.columns.id, staged.columns.id))
        .whenNotMatchedInsert({ id: staged.columns.id, scores: [1n] })
        .compile().binds,
    ).toEqual(['[1]']);
    for (const values of [
      { scores: [1.5 as unknown as bigint] },
      { scores: ['1' as unknown as bigint] },
      { address: { city: 'X', ok: true } as never },
      { address: { city: 'X', 'Zip "Code"': 100000n, ok: true } },
      { address: { city: 'X', 'Zip "Code"': null, ok: null as unknown as boolean } },
      { address: { city: 'X', 'Zip "Code"': null, ok: true, extra: 1 } as never },
      { prices: new Map([['abcd', '1']]) },
      { prices: new Map([['a', '1.234']]) },
      { prices: { a: '1' } as never },
      { tags: new Map([[1n, [null as unknown as string]]]) },
    ])
      expect(() => update(table, values)).toThrow(z.ZodError);
  });

  it('round-trips nested descriptors through JSON', () => {
    const nested = t.array(t.object({ flags: t.map(t.text(), t.boolean()), n: t.decimal() }));
    expect(nested.sql).toBe('ARRAY(OBJECT("flags" MAP(VARCHAR, BOOLEAN), "n" NUMBER(38,0)))');
    const value = [{ flags: new Map([['on', true]]), n: '0' }, null];
    const json = nested.toJson(value);
    expect(json).toBe('[{"flags":{"on":true},"n":0},null]');
    const column = structured('N', nested).notNull();
    expect(column.readSchema.parse(json)).toEqual(value);
    expect(t.object({}).sql).toBe('OBJECT()');
    expect(() => t.map(t.decimal({ precision: 10, scale: 2 }), t.text())).toThrow(
      'MAP keys must be VARCHAR or NUMBER with scale 0.',
    );
    expect(t.map(t.decimal({ precision: 10 }), t.text()).sql).toBe('MAP(NUMBER(10,0), VARCHAR)');
    expect(t.integer().notNull().notNull().required).toBe(true);
  });
});
