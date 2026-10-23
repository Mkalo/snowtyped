import { describe, expect, it } from 'vitest';
import {
  type AnyExpression,
  asc,
  count,
  date,
  decimal,
  desc,
  eq,
  type FramedWindowOptions,
  float,
  integer,
  lower,
  max,
  over,
  type RangeBoundary,
  rangeBetween,
  rowNumber,
  rowsBetween,
  select,
  snowflakeTable,
  sum,
  text,
  time,
  timestamp,
  type WindowFrame,
} from '../../src/index.js';

const t = snowflakeTable('T', {
  id: integer('ID').notNull(),
  name: text('NAME'),
  amount: decimal('AMOUNT'),
  ratio: float('RATIO'),
  day: date('DAY'),
  clock: time('CLOCK'),
  ntz: timestamp('NTZ'),
  ltz: timestamp('LTZ', 'ltz'),
  tz: timestamp('TZ', 'tz'),
});
const u = snowflakeTable('U', { id: integer('ID').notNull() });
const total = sum(t.columns.amount);
const byId = [asc(t.columns.id)] as const;
const unchecked = (options: object) => options as FramedWindowOptions;
const boundary = (value: unknown) => value as RangeBoundary as 'CURRENT ROW';

describe('explicit window frames', () => {
  it('compiles ROWS and RANGE frames after partitioning and ordering', () => {
    const running = over(total, {
      partitionBy: [t.columns.name],
      orderBy: byId,
      frame: rowsBetween('UNBOUNDED PRECEDING', 'CURRENT ROW'),
    });
    const query = select(t, {
      running,
      bounded: over(count(), {
        orderBy: byId,
        frame: rowsBetween({ preceding: 2 }, { following: 0 }),
      }),
      empty: over(max(t.columns.name), {
        orderBy: [desc(t.columns.id, 'LAST')],
        frame: rowsBetween({ following: 2 }, { following: 3 }),
      }),
      tail: over(total, {
        orderBy: byId,
        frame: rowsBetween('CURRENT ROW', 'UNBOUNDED FOLLOWING'),
      }),
      peers: over(total, {
        orderBy: [asc(t.columns.name), asc(t.columns.id)],
        frame: rangeBetween('UNBOUNDED PRECEDING', 'UNBOUNDED FOLLOWING'),
      }),
      nearby: over(total, {
        orderBy: [asc(t.columns.ratio)],
        frame: rangeBetween({ preceding: 0.5 }, { following: 1.5 }),
      }),
      week: over(total, {
        orderBy: [asc(t.columns.ntz)],
        frame: rangeBetween({ preceding: 7, unit: 'DAY' }, { preceding: 0, unit: 'DAY' }),
      }),
    });
    const sql = query.compile().sql;
    expect(sql).toContain(
      'SUM("AMOUNT") OVER (PARTITION BY "NAME" ORDER BY "ID" ASC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)',
    );
    expect(sql).toContain(
      'COUNT(*) OVER (ORDER BY "ID" ASC ROWS BETWEEN 2 PRECEDING AND 0 FOLLOWING)',
    );
    expect(sql).toContain(
      'MAX("NAME") OVER (ORDER BY "ID" DESC NULLS LAST ROWS BETWEEN 2 FOLLOWING AND 3 FOLLOWING)',
    );
    expect(sql).toContain('ROWS BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING');
    expect(sql).toContain(
      'ORDER BY "NAME" ASC, "ID" ASC RANGE BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING',
    );
    expect(sql).toContain('ORDER BY "RATIO" ASC RANGE BETWEEN 0.5 PRECEDING AND 1.5 FOLLOWING');
    expect(sql).toContain(
      `ORDER BY "NTZ" ASC RANGE BETWEEN INTERVAL '7 DAY' PRECEDING AND INTERVAL '0 DAY' PRECEDING`,
    );
    expect(query.compile().binds).toEqual([]);
    expect(select(t, { running }).qualify(eq(running, null)).compile().sql).toContain('QUALIFY');
    expect(rowsBetween({ preceding: 1 }, 'CURRENT ROW').ast).toEqual({
      units: 'ROWS',
      start: { bound: 'PRECEDING', offset: 1 },
      end: { bound: 'CURRENT ROW' },
    });
  });

  it('propagates references, phase, output schemas, and nullability', () => {
    const counted = over(count(t.columns.name), {
      partitionBy: [u.columns.id],
      orderBy: byId,
      frame: rowsBetween({ preceding: 2 }, { preceding: 1 }),
    });
    expect(counted.phase).toBe('window');
    expect(counted.refs.map((ref) => ref.name)).toEqual(['T', 'U']);
    expect(counted.nullRefs).toEqual([]);
    expect(counted.wireType).toBe('integer');
    expect(counted.readSchema.parse('0')).toBe(0n);
    expect(() => counted.readSchema.parse(null)).toThrow();
    const summed = over(total, {
      orderBy: byId,
      frame: rowsBetween({ preceding: 2 }, { preceding: 1 }),
    });
    expect(summed.readSchema.parse(null)).toBeNull();
    expect(summed.wireType).toBe('decimal');
    expect(() => select(t, { counted } as never)).toThrow('scope');
    expect(
      select(t).innerJoin(u, eq(t.columns.id, u.columns.id)).select({ counted }).compile().sql,
    ).toContain(
      'PARTITION BY "U"."ID" ORDER BY "T"."ID" ASC ROWS BETWEEN 2 PRECEDING AND 1 PRECEDING',
    );
  });

  it('accepts RANGE offsets only for one numeric, date, or timestamp ORDER BY', () => {
    const numeric = rangeBetween({ preceding: 1 }, 'CURRENT ROW');
    const interval = rangeBetween({ preceding: 1, unit: 'HOUR' }, 'CURRENT ROW');
    for (const column of [
      t.columns.id,
      t.columns.amount,
      t.columns.ratio,
      t.columns.day,
      total,
    ] as AnyExpression[])
      expect(over(total, { orderBy: [asc(column)], frame: numeric }).phase).toBe('window');
    for (const column of [t.columns.day, t.columns.ntz, t.columns.ltz, t.columns.tz])
      expect(over(total, { orderBy: [desc(column)], frame: interval }).phase).toBe('window');
    for (const column of [
      t.columns.name,
      t.columns.clock,
      t.columns.ntz,
      lower(t.columns.name),
    ] as AnyExpression[])
      expect(() => over(total, { orderBy: [asc(column)], frame: numeric })).toThrow(
        'Numeric RANGE offsets require one numeric or date ORDER BY expression.',
      );
    for (const column of [t.columns.id, t.columns.clock, t.columns.name] as AnyExpression[])
      expect(() => over(total, { orderBy: [asc(column)], frame: interval })).toThrow(
        'Interval RANGE offsets require one date or timestamp ORDER BY expression.',
      );
    expect(() =>
      over(total, unchecked({ orderBy: [asc(t.columns.id), asc(t.columns.day)], frame: numeric })),
    ).toThrow('one numeric or date ORDER BY');
    expect(
      over(total, {
        orderBy: [asc(t.columns.name), asc(t.columns.id)],
        frame: rangeBetween('CURRENT ROW', 'UNBOUNDED FOLLOWING'),
      }).phase,
    ).toBe('window');
    expect(
      over(total, {
        orderBy: [asc(t.columns.name), asc(t.columns.id)],
        frame: rowsBetween({ preceding: 1 }, { following: 1 }),
      }).phase,
    ).toBe('window');
  });

  it('rejects frames without ORDER BY or on functions that do not accept frames', () => {
    const frame = rowsBetween('UNBOUNDED PRECEDING', 'CURRENT ROW');
    expect(() => over(total, unchecked({ frame }))).toThrow('Window frames require ORDER BY.');
    expect(() => over(total, unchecked({ orderBy: [], frame }))).toThrow('require ORDER BY');
    expect(() => rowNumber(unchecked({ orderBy: byId, frame }))).toThrow(
      'Window frames require an aggregate function',
    );
    expect(() => over(t.columns.amount, { orderBy: byId, frame })).toThrow('aggregate function');
    expect(() => over(over(total), { orderBy: byId, frame })).toThrow('aggregate function');
  });

  it('rejects boundaries that are out of order or malformed', () => {
    const order = 'A window frame cannot start after it ends.';
    const cases: [RangeBoundary, RangeBoundary][] = [
      ['UNBOUNDED FOLLOWING', 'UNBOUNDED FOLLOWING'],
      ['UNBOUNDED PRECEDING', 'UNBOUNDED PRECEDING'],
      ['CURRENT ROW', { preceding: 1 }],
      [{ following: 1 }, 'CURRENT ROW'],
      [{ following: 1 }, { preceding: 1 }],
      [{ preceding: 1 }, { preceding: 2 }],
      [{ following: 2 }, { following: 1 }],
    ];
    for (const [start, end] of cases) {
      expect(() => rowsBetween(boundary(start), boundary(end))).toThrow(order);
      expect(() => rangeBetween(boundary(start), boundary(end))).toThrow(order);
    }
    expect(() =>
      rangeBetween({ preceding: 1, unit: 'DAY' }, { preceding: 2, unit: 'DAY' }),
    ).toThrow(order);
    expect(
      rangeBetween({ preceding: 1, unit: 'HOUR' }, { preceding: 2, unit: 'MINUTE' }).ast.end,
    ).toEqual({ bound: 'PRECEDING', offset: 2, unit: 'MINUTE' });
    expect(rowsBetween({ preceding: 1 }, { preceding: 1 }).ast.start.offset).toBe(1);
    expect(rowsBetween({ following: 1 }, { following: 1 }).ast.end.offset).toBe(1);
    expect(() => rangeBetween({ preceding: 2 }, { preceding: 1, unit: 'DAY' })).toThrow(
      'A RANGE frame cannot mix numeric and interval offsets.',
    );
    expect(() => rangeBetween({ preceding: 2, unit: 'DAY' }, { following: 1 })).toThrow('mix');
    expect(() => rowsBetween(boundary('PRECEDING'), 'CURRENT ROW')).toThrow(
      'Unsupported window frame boundary.',
    );
    expect(() => rowsBetween('CURRENT ROW', boundary('1 FOLLOWING'))).toThrow('Unsupported');
    for (const offset of [-1, 0.5, Infinity, NaN])
      expect(() => rowsBetween({ preceding: offset }, 'CURRENT ROW')).toThrow(
        'ROWS offsets must be nonnegative safe integers.',
      );
    for (const offset of [-0.5, Infinity, NaN])
      expect(() => rangeBetween({ following: 0 }, { following: offset })).toThrow(
        'RANGE offsets must be nonnegative finite numbers.',
      );
    expect(() => rowsBetween(boundary({ preceding: 1, unit: 'DAY' }), 'CURRENT ROW')).toThrow(
      'Interval offsets need a supported unit and a RANGE frame.',
    );
    expect(() =>
      rangeBetween(boundary({ preceding: 1, unit: 'FORTNIGHT' }), 'CURRENT ROW'),
    ).toThrow('supported unit');
    for (const offset of [-1, 1.5])
      expect(() => rangeBetween({ preceding: offset, unit: 'DAY' }, 'CURRENT ROW')).toThrow(
        'Interval offsets must be nonnegative safe integers.',
      );
  });

  it('keeps frames immutable and reusable', () => {
    const frame: WindowFrame = rowsBetween({ preceding: 1 }, 'CURRENT ROW');
    expect(Object.isFrozen(frame)).toBe(true);
    expect(Object.isFrozen(frame.ast)).toBe(true);
    expect(Object.isFrozen(frame.ast.start)).toBe(true);
    const window = over(total, { orderBy: byId, frame });
    expect(window.expression).toMatchObject({ kind: 'window', frame: frame.ast });
    expect(over(total, { orderBy: byId }).expression).not.toHaveProperty('frame');
  });
});
