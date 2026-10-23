import { describe, expect, it } from 'vitest';
import {
  compileAst,
  eq,
  identifier,
  insert,
  integer,
  mergeInto,
  select,
  snowflakeTable,
  text,
  timestamp,
  update,
  variant,
} from '../../src/index.js';

const events = snowflakeTable('EVENTS', {
  id: integer('ID').notNull().identity({ start: 10, increment: 5, order: true }),
  name: text('NAME').notNull(),
  status: text('STATUS').notNull().serverDefault("'new'"),
  created: timestamp('CREATED').serverDefault(),
  payload: variant('PAYLOAD'),
  doubled: integer('DOUBLED').virtual('ID * 2'),
});

describe('server-populated columns', () => {
  it('records default, identity, and virtual metadata through modifiers and binding', () => {
    expect(events.columns.id.serverValue).toEqual({
      kind: 'identity',
      start: 10,
      increment: 5,
      order: true,
    });
    expect(events.columns.id.required).toBe(true);
    expect(events.columns.status.serverValue).toEqual({ kind: 'default', expression: "'new'" });
    expect(events.columns.created.serverValue).toEqual({ kind: 'default' });
    expect(events.columns.doubled.serverValue).toEqual({ kind: 'virtual', expression: 'ID * 2' });
    expect(events.columns.name.serverValue).toBeNull();
    expect(events.columns.created.notNull().serverValue).toEqual({ kind: 'default' });
    expect(integer('ID').identity().serverValue).toEqual({ kind: 'identity' });
    expect(text('X').virtual().serverValue).toEqual({ kind: 'virtual' });
    const rebound = events.columns.name.serverDefault('UUID_STRING()').notNull();
    expect(rebound.serverValue).toEqual({ kind: 'default', expression: 'UUID_STRING()' });
    expect(rebound.expression).toEqual(events.columns.name.expression);
    expect(events.columns.name.identity().serverValue).toEqual({ kind: 'identity' });
    expect(events.columns.name.virtual('1').expression).toEqual(events.columns.name.expression);
    expect(() => text('X').serverDefault(' ')).toThrow('cannot be empty');
    expect(() => integer('X').identity({ increment: 0 })).toThrow('cannot be zero');
    expect(() => integer('X').identity({ start: 1.5 })).toThrow('safe integers');
    expect(integer('X').identity({ increment: -1 }).serverValue).toEqual({
      kind: 'identity',
      increment: -1,
    });
    const derived = select(events, { id: events.columns.id }).as('D');
    expect(derived.columns.id.serverValue).toBeNull();
    expect(() => derived.columns.id.serverDefault()).toThrow('base table columns');
  });

  it('omits unspecified columns so Snowflake applies defaults instead of NULL', () => {
    expect(insert(events, { name: 'a' }).compile()).toEqual({
      sql: 'INSERT INTO "EVENTS" ("NAME") SELECT ?',
      binds: ['a'],
    });
    expect(
      insert(events, { name: 'a', created: null, payload: undefined } as never).compile(),
    ).toEqual({
      sql: 'INSERT INTO "EVENTS" ("NAME", "CREATED") SELECT ?, ?',
      binds: ['a', null],
    });
    expect(insert(events, [{ id: 1n, name: 'a', status: 'x' }]).compile().sql).toBe(
      'INSERT INTO "EVENTS" ("ID", "NAME", "STATUS") SELECT ?, ?, ?',
    );
    expect(() => insert(events, { name: 'a', status: null } as never)).toThrow();
    expect(() => insert(events, { name: undefined } as never)).toThrow(
      'Missing required insert column: name',
    );
  });

  it('compiles mixed row shapes into one conditional insert using DEFAULT', () => {
    const query = insert(events, [
      { name: 'a', payload: { x: 1 } },
      { name: 'b', status: 'done' },
      { name: 'c', payload: null },
    ]);
    expect(query.ast).toMatchObject({
      columns: [identifier('NAME'), identifier('STATUS'), identifier('PAYLOAD')],
      rows: [
        [{ kind: 'parameter' }, { kind: 'default' }, { kind: 'function' }],
        [{ kind: 'parameter' }, { kind: 'parameter' }, { kind: 'default' }],
        [{ kind: 'parameter' }, { kind: 'default' }, { kind: 'function' }],
      ],
    });
    expect(query.compile()).toEqual({
      sql:
        'INSERT ALL WHEN "__sflib_shape" = 0 THEN INTO "EVENTS" ("NAME", "STATUS", "PAYLOAD") VALUES ("__sflib_0", DEFAULT, "__sflib_2")' +
        ' WHEN "__sflib_shape" = 1 THEN INTO "EVENTS" ("NAME", "STATUS", "PAYLOAD") VALUES ("__sflib_0", "__sflib_1", DEFAULT)' +
        ' SELECT 0 AS "__sflib_shape", ? AS "__sflib_0", NULL AS "__sflib_1", PARSE_JSON(?) AS "__sflib_2"' +
        ' UNION ALL SELECT 1 AS "__sflib_shape", ? AS "__sflib_0", ? AS "__sflib_1", NULL AS "__sflib_2"' +
        ' UNION ALL SELECT 0 AS "__sflib_shape", ? AS "__sflib_0", NULL AS "__sflib_1", PARSE_JSON(?) AS "__sflib_2"',
      binds: ['a', '{"x":1}', 'b', 'done', 'c', null],
    });
  });

  it('inserts rows made only of server-populated values', () => {
    const counters = snowflakeTable('COUNTERS', {
      label: text('LABEL').virtual('1'),
      id: integer('ID').identity(),
      at: timestamp('AT').serverDefault('CURRENT_TIMESTAMP()'),
    });
    expect(insert(counters, [{}, {}]).compile()).toEqual({
      sql: 'INSERT ALL WHEN "__sflib_shape" = 0 THEN INTO "COUNTERS" ("ID") VALUES (DEFAULT) SELECT 0 AS "__sflib_shape", NULL AS "__sflib_0" UNION ALL SELECT 0 AS "__sflib_shape", NULL AS "__sflib_0"',
      binds: [],
    });
    const computed = snowflakeTable('COMPUTED', { label: text('LABEL').virtual('1') });
    expect(() => insert(computed, {})).toThrow('writable column');
  });

  it('rejects writes to virtual columns in insert, update, and merge', () => {
    expect(() => insert(events, { name: 'a', doubled: 1n } as never)).toThrow(
      'Cannot write virtual column: doubled',
    );
    expect(() => update(events, { doubled: 1n } as never)).toThrow('virtual column');
    expect(update(events, { id: 1n, status: 'x' }).compile().sql).toBe(
      'UPDATE "EVENTS" SET "ID" = ?, "STATUS" = ?',
    );
    const staged = snowflakeTable('STAGED', { name: text('NAME').notNull() });
    const merge = mergeInto(events, staged, eq(events.columns.name, staged.columns.name));
    expect(merge.whenNotMatchedInsert({ name: staged.columns.name }).compile().sql).toContain(
      'WHEN NOT MATCHED THEN INSERT ("NAME") VALUES ("STAGED"."NAME")',
    );
    expect(() => merge.whenNotMatchedInsert({ name: 'a', doubled: 1n } as never)).toThrow(
      'virtual column',
    );
    expect(() => merge.whenNotMatchedInsert({ status: 'x' } as never)).toThrow(
      'Missing required insert column: name',
    );
    expect(() => merge.whenMatchedUpdate({ doubled: 1n } as never)).toThrow('virtual column');
  });

  it('compiles DEFAULT cells in low-level insert nodes', () => {
    expect(
      compileAst({
        kind: 'insert',
        table: identifier('T'),
        columns: [identifier('A')],
        rows: [[{ kind: 'default' }]],
      }).sql,
    ).toBe(
      'INSERT ALL WHEN "__sflib_shape" = 0 THEN INTO "T" ("A") VALUES (DEFAULT) SELECT 0 AS "__sflib_shape", NULL AS "__sflib_0"',
    );
  });
});
