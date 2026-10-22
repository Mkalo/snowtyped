import { describe, expect, it } from 'vitest';
import { identifier, type SqlInterpolation, sql } from '../../src/index.js';

describe('parameterized raw SQL', () => {
  it('binds scalars in order and never interpolates user data as SQL', () => {
    const attack = "'; DROP TABLE T; --";
    expect(sql`SELECT ${attack}, ${42}, ${true}, ${null}, ${9007199254740993n}`.compile()).toEqual({
      sql: 'SELECT ?, ?, ?, ?, ?',
      binds: [attack, 42, true, null, '9007199254740993'],
    });
  });

  it('composes nested fragments and ordered bind lists', () => {
    const filter = sql`ACTIVE = ${true}`;
    const list = sql.join([1, 2, 3]);
    expect(
      sql`SELECT * FROM ${sql.identifier('DB', 'Odd.Schema', 'Ta"ble')} WHERE ${filter} AND ID IN (${list})`.compile(),
    ).toEqual({
      sql: 'SELECT * FROM "DB"."Odd.Schema"."Ta""ble" WHERE ACTIVE = ? AND ID IN (?, ?, ?)',
      binds: [true, 1, 2, 3],
    });
  });

  it('accepts identifier nodes and a custom join separator', () => {
    expect(
      sql`${identifier('A')} WHERE ${sql.join([sql`X = ${1}`, sql`Y = ${2}`], sql` OR `)}`.compile(),
    ).toEqual({ sql: '"A" WHERE X = ? OR Y = ?', binds: [1, 2] });
    expect(sql.join([]).compile()).toEqual({ sql: '', binds: [] });
  });

  it('snapshots mutable dates and preserves immutable fragments', () => {
    const date = new Date('2026-01-01T00:00:00Z');
    const query = sql`SELECT ${date}`;
    date.setFullYear(2000);
    expect(query.compile().binds).toEqual(['2026-01-01T00:00:00.000Z']);
    expect(Object.isFrozen(query)).toBe(true);
    expect(Object.isFrozen(query.compile().binds)).toBe(true);
  });

  it('has explicit helpers for static SQL and JSON values', () => {
    expect(
      sql`SELECT ${sql.unsafe('CURRENT_DATE()')}, ${sql.json({ name: "O'Reilly" })}`.compile(),
    ).toEqual({ sql: 'SELECT CURRENT_DATE(), PARSE_JSON(?)', binds: ['{"name":"O\'Reilly"}'] });
    expect(() => sql.json(undefined)).toThrow('encoded as JSON');
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => sql.json(cyclic)).toThrow();
  });

  it.each([NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects lossy numbers: %s',
    (value) => {
      expect(() => sql`SELECT ${value}`).toThrow('SQL numbers');
    },
  );

  it('rejects non-tag calls, malformed templates, invalid identifiers, and unsupported values', () => {
    expect(() => sql('SELECT 1' as unknown as TemplateStringsArray)).toThrow('template tag');
    expect(() => sql(Object.assign([''], { raw: [''] }), 1)).toThrow('template structure');
    expect(() => sql.identifier('')).toThrow('Identifiers');
    for (const value of [undefined, {}, [], () => 1]) {
      expect(() => sql`SELECT ${value as unknown as SqlInterpolation}`).toThrow('Unsupported');
    }
    expect(() => sql`SELECT ${new Date('invalid')}`).toThrow();
  });
});
