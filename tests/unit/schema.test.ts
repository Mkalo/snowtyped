import { describe, expect, it } from 'vitest';
import { boolean, decimal, integer, snowflakeTable, text } from '../../src/index.js';
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
