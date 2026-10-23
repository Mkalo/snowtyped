import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import {
  array,
  binary,
  boolean,
  decimal,
  eq,
  insert,
  integer,
  jsonPath,
  like,
  lt,
  mergeInto,
  object,
  select,
  snowflakeTable,
  text,
  time,
  timestamp,
  update,
  variant,
} from '../../src/index.js';
import { resultSchema } from '../../src/schema.js';

describe('declared schemas', () => {
  it('makes columns nullable by default and notNull immutable', () => {
    const optional = text('NAME');
    const required = optional.notNull();
    expect(optional.readSchema.parse(null)).toBeNull();
    expect(required.readSchema.parse('Ada')).toBe('Ada');
    expect(() => required.readSchema.parse(null)).toThrow();
    expect(required.notNull().readSchema.parse('Ada')).toBe('Ada');
    expect(Object.isFrozen(optional)).toBe(true);
  });

  it('decodes exact integers beyond JavaScript number precision', () => {
    const id = integer('ID').notNull();
    expect(id.readSchema.parse('9007199254740993')).toBe(9007199254740993n);
    expect(id.readSchema.parse('-99999999999999999999999999999999999999')).toBe(
      -99999999999999999999999999999999999999n,
    );
    expect(id.valueSchema.parse(42n)).toBe(42n);
    for (const input of ['1.2', '1e4', '', 42, null]) {
      expect(() => id.readSchema.parse(input)).toThrow();
    }
    expect(integer('ID').readSchema.parse(null)).toBeNull();
  });

  it('keeps fixed-point decimals exact', () => {
    const amount = decimal('AMOUNT').notNull();
    expect(amount.readSchema.parse('-12345678901234567890.123456789')).toBe(
      '-12345678901234567890.123456789',
    );
    expect(amount.valueSchema.parse('0')).toBe('0');
    for (const input of ['NaN', '1e5', 'Infinity', 1.2]) {
      expect(() => amount.readSchema.parse(input)).toThrow();
    }
  });

  it('validates booleans without truthy coercion', () => {
    const active = boolean('ACTIVE').notNull();
    expect(active.readSchema.parse(false)).toBe(false);
    expect(active.valueSchema.parse(true)).toBe(true);
    expect(() => active.readSchema.parse('false')).toThrow();
  });

  it('derives compiled Zod validation from the declared projection', () => {
    const schema = resultSchema({ id: integer('ID').notNull(), name: text('NAME') });
    expect(schema.parse({ id: '9007199254740993', name: null })).toEqual({
      id: 9007199254740993n,
      name: null,
    });
    expect(() => schema.parse({ id: 'abc', name: 'Ada' })).toThrow();
    expect(() => schema.parse({ id: '1', name: null, extra: true })).toThrow();
  });

  it.each([
    [{}, ['CUSTOMERS']],
    [{ schema: 'PUBLIC' }, ['PUBLIC', 'CUSTOMERS']],
    [{ database: 'DB', schema: 'PUBLIC' }, ['DB', 'PUBLIC', 'CUSTOMERS']],
  ] as const)('preserves qualified physical table names: %j', (options, parts) => {
    const table = snowflakeTable('CUSTOMERS', { id: integer('ID') }, options);
    expect(table.node.parts).toEqual(parts);
    expect(Object.isFrozen(table)).toBe(true);
    expect(Object.isFrozen(table.columns)).toBe(true);
  });

  it('rejects ambiguous qualification, empty tables, and duplicate physical columns', () => {
    expect(() => snowflakeTable('T', { id: integer('ID') }, { database: 'DB' })).toThrow(
      'requires a schema',
    );
    expect(() => snowflakeTable('T', {})).toThrow('at least one');
    expect(() => snowflakeTable('T', { one: text('X'), two: text('X') })).toThrow('Duplicate');
  });

  it('snapshots column declarations', () => {
    const columns = { id: integer('ID') };
    const table = snowflakeTable('T', columns);
    columns.id = integer('OTHER');
    expect(table.columns.id.node.parts).toEqual(['ID']);
  });
});

describe('declared column constraints', () => {
  it('bounds integer precision on writes and decoded results', () => {
    const small = integer('SMALL', { precision: 3 });
    expect(small.constraints).toEqual({ precision: 3, scale: 0 });
    expect(Object.isFrozen(small.constraints)).toBe(true);
    expect(integer('ID').constraints).toEqual({});
    for (const value of [999n, -999n, 0n, null])
      expect(() => small.encodeWrite(value)).not.toThrow();
    for (const value of [1000n, -1000n])
      expect(() => small.encodeWrite(value)).toThrow('NUMBER(3,0)');
    expect(small.readSchema.parse('-999')).toBe(-999n);
    expect(small.readSchema.parse(null)).toBeNull();
    expect(() => small.readSchema.parse('1000')).toThrow('NUMBER(3,0)');
    expect(() => small.notNull().readSchema.parse(null)).toThrow();
    expect(() => small.notNull().encodeWrite(1000n as bigint)).toThrow('NUMBER(3,0)');
  });

  it('bounds decimal digits without rejecting value-preserving zeros', () => {
    const amount = decimal('AMOUNT', { precision: 5, scale: 2 }).notNull();
    expect(amount.constraints).toEqual({ precision: 5, scale: 2 });
    for (const value of ['999.99', '-999.99', '0', '000123.4500', '1.50000', '0.01'])
      expect(amount.encodeWrite(value)).toEqual({ kind: 'parameter', value });
    for (const value of ['1000', '1.001', '-1000.00', '0.005'])
      expect(() => amount.encodeWrite(value)).toThrow('NUMBER(5,2)');
    for (const value of ['1e3', '+1.5', '.5', '1.', 'abc']) {
      expect(() => amount.encodeWrite(value)).toThrow(z.ZodError);
      expect(() => amount.readSchema.parse(value)).toThrow(z.ZodError);
    }
    expect(amount.readSchema.parse('999.99')).toBe('999.99');
    expect(() => amount.readSchema.parse('1000.00')).toThrow('NUMBER(5,2)');
    expect(decimal('A', { scale: 4 }).constraints).toEqual({ precision: 38, scale: 4 });
    expect(decimal('A', { precision: 4 }).constraints).toEqual({ precision: 4, scale: 0 });
    expect(() => decimal('A', { precision: 4 }).encodeWrite('1.5')).toThrow('NUMBER(4,0)');
    expect(decimal('A', { precision: 2, scale: 2 }).encodeWrite('-0.99')).toBeTruthy();
    expect(decimal('A').encodeWrite('123456789012345678901234567890123456789.5')).toBeTruthy();
  });

  it('counts VARCHAR length in code points and BINARY length in bytes', () => {
    const code = text('CODE', { length: 3 });
    expect(code.constraints).toEqual({ length: 3 });
    for (const value of ['abc', '😀😀😀', '', null])
      expect(() => code.encodeWrite(value)).not.toThrow();
    for (const value of ['abcd', '😀😀😀😀'])
      expect(() => code.encodeWrite(value)).toThrow('VARCHAR(3)');
    expect(() => code.readSchema.parse('abcd')).toThrow('VARCHAR(3)');
    const data = binary('DATA', { length: 2 });
    expect(data.constraints).toEqual({ length: 2 });
    expect(data.encodeWrite(new Uint8Array([1, 2]))).toMatchObject({ name: 'TO_BINARY' });
    expect(() => data.encodeWrite(new Uint8Array([1, 2, 3]))).toThrow('BINARY(2)');
    expect([...(data.readSchema.parse(Buffer.from([1])) as Uint8Array)]).toEqual([1]);
    expect(() => data.readSchema.parse(Buffer.from([1, 2, 3]))).toThrow('BINARY(2)');
  });

  it('bounds fractional seconds for TIME and timestamps', () => {
    const clock = time('CLOCK', { precision: 3 });
    expect(clock.constraints).toEqual({ precision: 3 });
    for (const value of ['12:34:56', '12:34:56.123', '12:34:56.123000000'])
      expect(() => clock.encodeWrite(value)).not.toThrow();
    expect(() => clock.encodeWrite('12:34:56.1234')).toThrow('TIME(3)');
    expect(() => clock.encodeWrite('12:34')).toThrow();
    expect(clock.readSchema.parse('12:34:56.123000000')).toBe('12:34:56.123000000');
    expect(() => clock.readSchema.parse('12:34:56.123400000')).toThrow('TIME(3)');
    const at = timestamp('AT', 'ltz', { precision: 0 });
    expect(at.constraints).toEqual({ precision: 0 });
    for (const value of [
      '2026-01-01 12:34:56',
      '2026-01-01T12:34:56.000Z',
      '2026-01-01 12:34:56.000000000 -08:00',
      '1700000000',
      '1700000000000',
      '1700000000000000',
      '1700000000000000000',
      '-1700000000123',
      '01.02.2026 12:34:56',
    ])
      expect(() => at.encodeWrite(value)).not.toThrow();
    for (const value of [
      '2026-01-01 12:34:56.7',
      '2026-01-01T12:34:56.5+02:00',
      '1700000000.5',
      '1700000000123',
      '1700000000123456',
      '1700000000123456789',
    ])
      expect(() => at.encodeWrite(value)).toThrow('TIMESTAMP_LTZ(0)');
    const millis = timestamp('AT', 'ntz', { precision: 3 });
    expect(() => millis.encodeWrite('1700000000123')).not.toThrow();
    expect(() => millis.encodeWrite('1700000000123000')).not.toThrow();
    expect(() => millis.encodeWrite('1700000000123400')).toThrow('TIMESTAMP_NTZ(3)');
    expect(() => at.readSchema.parse('2026-01-01 12:34:56.100000000 -08:00')).toThrow();
    expect(timestamp('AT').constraints).toEqual({});
    expect(
      timestamp('AT', 'tz', { precision: 9 }).encodeWrite('2026-01-01 01:02:03.123456789'),
    ).toBeTruthy();
  });

  it('rejects invalid constraint declarations', () => {
    for (const precision of [0, 39, 1.5, Number.NaN])
      expect(() => integer('ID', { precision })).toThrow(
        'Precision must be an integer from 1 to 38.',
      );
    expect(() => decimal('A', { precision: 39, scale: 2 })).toThrow('Precision');
    expect(() => decimal('A', { precision: 2, scale: 3 })).toThrow(
      'Scale must be an integer from 0 to 2.',
    );
    expect(() => decimal('A', { scale: 38 })).toThrow('Scale must be an integer from 0 to 37.');
    expect(() => decimal('A', { scale: -1 })).toThrow('Scale');
    expect(() => text('T', { length: 0 })).toThrow(
      'Length must be an integer from 1 to 134217728.',
    );
    expect(() => text('T', { length: 134217729 })).toThrow('Length');
    expect(() => binary('B', { length: 67108865 })).toThrow(
      'Length must be an integer from 1 to 67108864.',
    );
    expect(() => time('T', { precision: 10 })).toThrow('Fractional seconds precision');
    expect(() => timestamp('T', 'ntz', { precision: -1 })).toThrow('Fractional seconds precision');
  });

  it('validates writes in INSERT, UPDATE, and MERGE but not predicate literals', () => {
    const table = snowflakeTable('T', {
      id: integer('ID', { precision: 2 }).notNull(),
      code: text('CODE', { length: 2 }),
    });
    const staged = snowflakeTable('S', { id: integer('ID').notNull() });
    expect(insert(table, { id: 99n, code: 'ab' }).compile().binds).toEqual(['99', 'ab']);
    expect(() => insert(table, { id: 100n })).toThrow('NUMBER(2,0)');
    expect(() => insert(table, [{ id: 1n }, { id: 1n, code: 'abc' }])).toThrow('VARCHAR(2)');
    expect(() => update(table, { code: 'abc' })).toThrow('VARCHAR(2)');
    const merge = mergeInto(table, staged, eq(table.columns.id, staged.columns.id));
    expect(() => merge.whenMatchedUpdate({ code: 'abc' })).toThrow('VARCHAR(2)');
    expect(() => merge.whenNotMatchedInsert({ id: 100n })).toThrow('NUMBER(2,0)');
    expect(merge.whenNotMatchedInsert({ id: staged.columns.id }).compile().sql).toContain('INSERT');
    const query = select(table).where(like(table.columns.code, '%abc%'));
    expect(query.compile().binds).toEqual(['%abc%']);
    expect(select(table).where(lt(table.columns.id, 1000n)).compile().binds).toEqual(['1000']);
    expect(() => select(table).where(lt(table.columns.id, 'x' as unknown as bigint))).toThrow();
  });
});

describe('semi-structured ARRAY and OBJECT columns', () => {
  const table = snowflakeTable('DOCS', {
    id: integer('ID').notNull(),
    tags: array('TAGS', z.string()).notNull(),
    items: array('ITEMS'),
    meta: object('META', z.strictObject({ ok: z.boolean() })),
    extra: object('EXTRA'),
  });
  const { tags, items, meta, extra } = table.columns;

  it('decodes JSON wire values against the declared schema', () => {
    expect(tags.readSchema.parse('["a","b"]')).toEqual(['a', 'b']);
    expect(items.readSchema.parse('[1,null,{"a":[]}]')).toEqual([1, null, { a: [] }]);
    expect(items.readSchema.parse(null)).toBeNull();
    expect(meta.readSchema.parse('{"ok":true}')).toEqual({ ok: true });
    expect(extra.readSchema.parse('{"a":null}')).toEqual({ a: null });
    for (const input of ['[1]', '{}', null]) expect(() => tags.readSchema.parse(input)).toThrow();
    for (const input of ['{"ok":1}', '{"ok":true,"x":1}', '[]'])
      expect(() => meta.readSchema.parse(input)).toThrow();
    expect(() => extra.readSchema.parse('[]')).toThrow();
    expect([tags.dataType, meta.dataType, tags.wireType, meta.wireType]).toEqual([
      'array',
      'object',
      'variant',
      'variant',
    ]);
  });

  it('rejects JSON numbers that would lose precision instead of rounding them', () => {
    expect(
      items.readSchema.parse(
        '[1.50,-0,0.1,1e2,-2.5E-3,9007199254740991,0.0,1e21,1E+21,4.940656458412465e-324,9.999999999999969e-311,3.000000000000000e-01,9.007199254740992e+15,0.1000000000000000055511151231257827]',
      ),
    ).toEqual([
      1.5, -0, 0.1, 100, -0.0025, 9007199254740991, 0, 1e21, 1e21, 5e-324, 1e-310, 0.3,
      9007199254740992, 0.1,
    ]);
    for (const input of [
      '[12345678901234567890]',
      '[0.1234567890123456789]',
      '[9007199254740993]',
      '[1e400]',
      '[1e-400]',
      '[1.0000000000000001]',
      '[1.797693134862316e+308]',
      `[0.${'1'.repeat(120)}]`,
      '{"n":{"deep":[9007199254740993]}}',
    ]) {
      const result = variant('V').readSchema.safeParse(input);
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.message).toContain('does not fit a JavaScript number');
    }
    expect(extra.readSchema.safeParse('{"n":9007199254740993}').success).toBe(false);
    expect(
      jsonPath(table.columns.meta, 'ok').readSchema.safeParse('9007199254740993').success,
    ).toBe(false);
    expect(variant('V').readSchema.safeParse('{').error?.issues[0]?.code).toBe('custom');
    expect(
      items.readSchema.parse('[1,undefined,"undefined",{"a":[undefined]},"\\"undefined\\\\"]'),
    ).toEqual([1, null, 'undefined', { a: [null] }, '"undefined\\']);
  });

  it('casts JSON writes, including NULL, to the column type', () => {
    expect(tags.encode(['a'])).toEqual({
      kind: 'cast',
      value: {
        kind: 'function',
        name: 'PARSE_JSON',
        args: [{ kind: 'parameter', value: '["a"]' }],
      },
      target: 'ARRAY',
    });
    expect(meta.encode(null)).toEqual({
      kind: 'cast',
      value: { kind: 'function', name: 'PARSE_JSON', args: [{ kind: 'parameter', value: null }] },
      target: 'OBJECT',
    });
    const rows = insert(table, [
      { id: 1n, tags: [], items: null, meta: null },
      { id: 2n, tags: ['x'], items: [1, 'two'], meta: { ok: false }, extra: { k: [1] } },
    ]).compile();
    expect(rows.sql).toBe(
      'INSERT INTO "DOCS" ("ID", "TAGS", "ITEMS", "META", "EXTRA") ' +
        'SELECT ?, CAST(PARSE_JSON(?) AS ARRAY), CAST(PARSE_JSON(?) AS ARRAY), CAST(PARSE_JSON(?) AS OBJECT), CAST(PARSE_JSON(?) AS OBJECT) ' +
        'UNION ALL SELECT ?, CAST(PARSE_JSON(?) AS ARRAY), CAST(PARSE_JSON(?) AS ARRAY), CAST(PARSE_JSON(?) AS OBJECT), CAST(PARSE_JSON(?) AS OBJECT)',
    );
    expect(rows.binds).toEqual([
      '1',
      '[]',
      null,
      null,
      null,
      '2',
      '["x"]',
      '[1,"two"]',
      '{"ok":false}',
      '{"k":[1]}',
    ]);
    expect(
      select(table)
        .where(eq(meta, { ok: true }))
        .compile(),
    ).toMatchObject({
      sql: expect.stringContaining('("META" = CAST(PARSE_JSON(?) AS OBJECT))'),
      binds: ['{"ok":true}'],
    });
    expect(select(table).compile().sql).toContain('TO_JSON("__sflib_result"."tags") AS "tags"');
  });

  it('validates writes against the declared schema', () => {
    expect(() => insert(table, { id: 1n, tags: [1] as unknown as string[] })).toThrow();
    expect(() => insert(table, { id: 1n, tags: null as unknown as string[] })).toThrow();
    expect(() => update(table, { meta: { ok: true, x: 1 } as { ok: boolean } })).toThrow();
    expect(() => update(table, { items: [1n] })).toThrow('serialize');
    expect(update(table, { extra: { a: 1 } }).compile().binds).toEqual(['{"a":1}']);
  });
});
