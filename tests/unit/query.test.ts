import { describe, expect, it } from 'vitest';
import { boolean, eq, identifier, integer, select, snowflakeTable, text } from '../../src/index.js';

const customers = snowflakeTable('CUSTOMERS', {
  id: integer('ID').notNull(),
  name: text('NAME').notNull(),
  email: text('EMAIL'),
  active: boolean('ACTIVE').notNull(),
});

describe('owned AST and compiler', () => {
  it('compiles projections and aliases deterministically', () => {
    const query = select(customers, {
      customerId: customers.columns.id,
      name: customers.columns.name,
    });
    expect(query.compile()).toEqual({
      sql: 'SELECT TO_VARCHAR("__sflib_result"."customerId") AS "customerId", "__sflib_result"."name" AS "name" FROM (SELECT "ID" AS "customerId", "NAME" AS "name" FROM "CUSTOMERS") AS "__sflib_result"',
      binds: [],
    });
    expect(query.ast.kind).toBe('select');
    expect(Object.isFrozen(query.ast.projections[0])).toBe(true);
  });

  it('keeps injected text in bindings', () => {
    const attack = "Ada'; DROP TABLE CUSTOMERS; --";
    const query = select(customers, { name: customers.columns.name }).where(
      eq(customers.columns.name, attack),
    );
    expect(query.compile()).toEqual({
      sql: 'SELECT "NAME" AS "name" FROM "CUSTOMERS" WHERE ("NAME" = ?)',
      binds: [attack],
    });
  });

  it('encodes integer bindings without losing precision and preserves boolean bindings', () => {
    const base = select(customers, { id: customers.columns.id });
    expect(base.where(eq(customers.columns.id, 9007199254740993n)).compile().binds).toEqual([
      '9007199254740993',
    ]);
    expect(base.where(eq(customers.columns.active, false)).compile().binds).toEqual([false]);
    expect(base.compile().binds).toEqual([]);
  });

  it('uses IS NULL rather than equality against a bound null', () => {
    expect(
      select(customers, { email: customers.columns.email })
        .where(eq(customers.columns.email, null))
        .compile(),
    ).toEqual({
      sql: 'SELECT "EMAIL" AS "email" FROM "CUSTOMERS" WHERE ("EMAIL" IS NULL)',
      binds: [],
    });
  });

  it('quotes names component by component and escapes embedded quotes', () => {
    const table = snowflakeTable(
      'odd.table"',
      { id: integer('odd"id') },
      {
        database: 'My.DB',
        schema: 'MiXeD',
      },
    );
    expect(select(table, { 'the"id': table.columns.id }).compile().sql).toBe(
      'SELECT TO_VARCHAR("__sflib_result"."the""id") AS "the""id" FROM (SELECT "odd""id" AS "the""id" FROM "My.DB"."MiXeD"."odd.table""") AS "__sflib_result"',
    );
  });

  it('rejects unknown table scope and empty projections', () => {
    const other = snowflakeTable('OTHER', { id: integer('ID') });
    // @ts-expect-error Exercise the runtime boundary for a statically invalid scope.
    expect(() => select(customers, { id: other.columns.id })).toThrow('does not belong');
    expect(() =>
      // @ts-expect-error Exercise the runtime boundary for a statically invalid scope.
      select(customers, { id: customers.columns.id }).where(eq(other.columns.id, 1n)),
    ).toThrow('does not belong');
    expect(() => select(customers, {})).toThrow('at least one');
    expect(() => select(customers, { '': customers.columns.id })).toThrow('Identifiers');
  });

  it('checks parameter domains at runtime as well as compile time', () => {
    expect(() => eq(customers.columns.id, '123' as unknown as bigint)).toThrow();
    const query = select(customers, { id: customers.columns.id });
    // @ts-expect-error Plain objects are not predicates.
    expect(() => query.where({ column: customers.columns.id, value: '123' })).toThrow();
  });

  it('snapshots selections and does not mutate reusable queries', () => {
    const projection = { value: customers.columns.name };
    const original = select(customers, projection);
    projection.value = customers.columns.email.notNull();
    const changed = original.where(eq(customers.columns.name, 'Ada'));
    expect(original.compile().sql).not.toContain('WHERE');
    expect(original.selection.value).toBe(customers.columns.name);
    expect(changed.compile().sql).toContain('WHERE');
    expect(Object.isFrozen(changed.compile().binds)).toBe(true);
  });

  it.each(['', 'x\0y', 'a'.repeat(256)])('rejects invalid identifier component %j', (name) => {
    expect(() => identifier(name)).toThrow(TypeError);
  });

  it('handles unicode identifier length and rejects a missing component at runtime', () => {
    expect(identifier('雪'.repeat(255)).parts[0]).toHaveLength(255);
    expect(identifier('😀'.repeat(255)).parts[0]).toHaveLength(510);
    expect(() => identifier(...([] as unknown as [string]))).toThrow(TypeError);
  });
});
