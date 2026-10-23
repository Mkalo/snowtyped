import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import {
  eq,
  type GeoJsonGeometry,
  geography,
  geometry,
  insert,
  integer,
  select,
  snowflakeTable,
  update,
  vector,
} from '../../src/index.js';
import { decodeEwkb } from '../../src/spatial.js';

const hex = (value: string) => Buffer.from(value, 'hex');
const point: GeoJsonGeometry = { type: 'Point', coordinates: [1, 2] };

describe('EWKB decoding', () => {
  it('decodes every geometry kind with exact coordinates and SRID', () => {
    expect(decodeEwkb(hex('010100002000000000343333333333D33F000000000000F03F'))).toEqual({
      srid: 0,
      geometry: { type: 'Point', coordinates: [0.30000000000000004, 1] },
    });
    expect(decodeEwkb(hex('0101000020E6100000000000000000F03F0000000000000040'))).toEqual({
      srid: 4326,
      geometry: point,
    });
    expect(decodeEwkb(hex('0101000000000000000000F03F0000000000000040'))).toEqual({
      srid: 0,
      geometry: point,
    });
    expect(decodeEwkb(hex('00000000013FF00000000000004000000000000000')).geometry).toEqual(point);
    expect(
      decodeEwkb(hex('01E903002000000000000000000000F03F00000000000000400000000000000840')),
    ).toEqual({ srid: 0, geometry: { type: 'Point', coordinates: [1, 2, 3] } });
    const ring = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 0],
    ];
    const ringHex =
      '0400000000000000000000000000000000000000000000000000F03F0000000000000000000000000000F03F000000000000F03F00000000000000000000000000000000';
    expect(decodeEwkb(hex(`0103000020E610000001000000${ringHex}`)).geometry).toEqual({
      type: 'Polygon',
      coordinates: [ring],
    });
    expect(decodeEwkb(hex(`01060000200000000001000000010300000001000000${ringHex}`))).toEqual({
      srid: 0,
      geometry: { type: 'MultiPolygon', coordinates: [[ring]] },
    });
    expect(
      decodeEwkb(
        hex(
          '0104000020E6100000020000000101000000000000000000F03F0000000000000040010100000000000000000008400000000000001040',
        ),
      ).geometry,
    ).toEqual({
      type: 'MultiPoint',
      coordinates: [
        [1, 2],
        [3, 4],
      ],
    });
    expect(
      decodeEwkb(
        hex(
          '0105000020000000000200000001020000000200000000000000000000000000000000000000000000000000F03F00000000000000000102000000020000000000000000000040000000000000004000000000000008400000000000000840',
        ),
      ).geometry,
    ).toEqual({
      type: 'MultiLineString',
      coordinates: [
        [
          [0, 0],
          [1, 0],
        ],
        [
          [2, 2],
          [3, 3],
        ],
      ],
    });
    expect(
      decodeEwkb(
        hex(
          '0107000020110F0000020000000101000000000000000000F03F0000000000000040010200000002000000000000000000F03F000000000000004000000000000008400000000000001040',
        ),
      ),
    ).toEqual({
      srid: 3857,
      geometry: {
        type: 'GeometryCollection',
        geometries: [
          point,
          {
            type: 'LineString',
            coordinates: [
              [1, 2],
              [3, 4],
            ],
          },
        ],
      },
    });
    expect(
      decodeEwkb(
        hex('01EF030020000000000100000001E9030000000000000000F03F00000000000000400000000000000840'),
      ).geometry,
    ).toEqual({
      type: 'GeometryCollection',
      geometries: [{ type: 'Point', coordinates: [1, 2, 3] }],
    });
  });

  it('rejects malformed and unsupported WKB', () => {
    for (const [input, message] of [
      ['02', 'Invalid WKB byte order.'],
      ['0101000040', 'Unsupported WKB geometry type'],
      ['01D1070000', 'Unsupported WKB geometry type'],
      ['01B90B0000', 'Unsupported WKB geometry type'],
      ['0108000000', 'Unsupported WKB geometry type'],
      ['0100000000', 'Unsupported WKB geometry type'],
      ['0101000000000000000000F03F000000000000004000', 'Trailing bytes after WKB geometry.'],
      ['0101000000000000000000F03F', 'Offset is outside the bounds of the DataView'],
    ] as const)
      expect(() => decodeEwkb(hex(input))).toThrow(message);
  });
});

describe('GEOGRAPHY and GEOMETRY columns', () => {
  const places = snowflakeTable('PLACES', {
    id: integer('ID').notNull(),
    location: geography('LOCATION').notNull(),
    area: geography('AREA'),
    shape: geometry('SHAPE', { srid: 4326 }),
    plain: geometry('PLAIN'),
  });
  const { location, area, shape, plain } = places.columns;

  it('decodes GeoJSON for GEOGRAPHY and EWKB for GEOMETRY', () => {
    expect(location.readSchema.parse('{"coordinates":[1,2],"type":"Point"}')).toEqual(point);
    expect(location.readSchema.parse('{"coordinates":[1,2,3,4],"type":"Point"}')).toEqual({
      type: 'Point',
      coordinates: [1, 2, 3, 4],
    });
    expect(area.readSchema.parse(null)).toBeNull();
    for (const input of [
      null,
      '{"type":"Point","coordinates":[1]}',
      '{"type":"Point","coordinates":[1,2],"bbox":[1,2,1,2]}',
      '{"type":"Feature","geometry":{"type":"Point","coordinates":[1,2]},"properties":{}}',
      '{"type":"GeometryCollection","geometries":[{"type":"Point"}]}',
    ])
      expect(() => location.readSchema.parse(input)).toThrow();
    expect(
      shape.readSchema.parse(hex('0101000020E6100000000000000000F03F0000000000000040')),
    ).toEqual(point);
    expect(plain.readSchema.parse(hex('0101000000000000000000F03F0000000000000040'))).toEqual(
      point,
    );
    expect(shape.readSchema.parse(null)).toBeNull();
    expect(() => shape.readSchema.parse(hex('0101000000000000000000F03F0000000000000040'))).toThrow(
      'Value does not fit GEOMETRY with SRID 4326.',
    );
    expect(() => plain.readSchema.parse(hex('02'))).toThrow('Invalid WKB byte order.');
    expect(() => plain.readSchema.parse(hex('0101000000000000000000F87F0000000000000040'))).toThrow(
      z.ZodError,
    );
    expect(shape.constraints).toEqual({ srid: 4326 });
    expect(plain.constraints).toEqual({ srid: 0 });
    expect(location.constraints).toEqual({});
    expect([location.wireType, shape.wireType, location.dataType, shape.dataType]).toEqual([
      'geography',
      'geometry',
      'geography',
      'geometry',
    ]);
  });

  it('writes GeoJSON through typed constructors, including NULL', () => {
    const rows = insert(places, [
      { id: 1n, location: point, shape: point },
      {
        id: 2n,
        location: { type: 'Point', coordinates: [1, 2, 3] },
        area: {
          type: 'GeometryCollection',
          geometries: [
            {
              type: 'LineString',
              coordinates: [
                [0, 0],
                [1, 1],
              ],
            },
          ],
        },
        plain: { type: 'MultiPoint', coordinates: [] },
      },
    ]).compile();
    expect(rows.sql).toBe(
      'INSERT INTO "PLACES" ("ID", "LOCATION", "AREA", "SHAPE", "PLAIN") ' +
        'SELECT ?, TO_GEOGRAPHY(?), TO_GEOGRAPHY(?), TO_GEOMETRY(?, ?), TO_GEOMETRY(?, ?) ' +
        'UNION ALL SELECT ?, TO_GEOGRAPHY(?), TO_GEOGRAPHY(?), TO_GEOMETRY(?, ?), TO_GEOMETRY(?, ?)',
    );
    expect(rows.binds).toEqual([
      '1',
      '{"type":"Point","coordinates":[1,2]}',
      null,
      '{"type":"Point","coordinates":[1,2]}',
      4326,
      null,
      0,
      '2',
      '{"type":"Point","coordinates":[1,2,3]}',
      '{"type":"GeometryCollection","geometries":[{"type":"LineString","coordinates":[[0,0],[1,1]]}]}',
      null,
      4326,
      '{"type":"MultiPoint","coordinates":[]}',
      0,
    ]);
    expect(update(places, { area: null }).compile().sql).toContain('TO_GEOGRAPHY(?)');
    expect(select(places).compile().sql).toContain(
      'TO_JSON(ST_ASGEOJSON("__sflib_result"."location")) AS "location", ' +
        'TO_JSON(ST_ASGEOJSON("__sflib_result"."area")) AS "area", ' +
        'ST_ASEWKB("__sflib_result"."shape") AS "shape"',
    );
    expect(() =>
      insert(places, { id: 1n, location: { type: 'Point', coordinates: [1] } as never }),
    ).toThrow();
    expect(() =>
      insert(places, {
        id: 1n,
        location: point,
        plain: { type: 'Point', coordinates: [1, 2, 3, 4] },
      }),
    ).toThrow();
    expect(() =>
      insert(places, { id: 1n, location: { ...point, bbox: [1, 2, 1, 2] } as never }),
    ).toThrow();
    expect(() =>
      insert(places, { id: 1n, location: { type: 'Point', coordinates: [Number.NaN, 1] } }),
    ).toThrow();
  });

  it('validates declared SRIDs', () => {
    for (const srid of [-1, 1.5, 2147483648])
      expect(() => geometry('G', { srid })).toThrow(
        'SRID must be an integer from 0 to 2147483647.',
      );
    expect(geometry('G', { srid: 2147483647 }).notNull().constraints).toEqual({ srid: 2147483647 });
  });
});

describe('VECTOR columns', () => {
  const embeddings = snowflakeTable('EMBEDDINGS', {
    id: integer('ID').notNull(),
    values: vector('VALS', 'float', 3).notNull(),
    counts: vector('COUNTS', 'int', 2),
  });
  const { values, counts } = embeddings.columns;

  it('decodes JSON arrays as FLOAT32 or INT32 elements of the declared dimension', () => {
    expect(values.readSchema.parse('[1.100000023841858e+00,2.000000000000000e+00,3]')).toEqual([
      Math.fround(1.1),
      2,
      3,
    ]);
    expect(counts.readSchema.parse('[2147483647,-2147483648]')).toEqual([2147483647, -2147483648]);
    expect(values.readSchema.parse('[-6.727404335356611e-17,1,2]')).toEqual([
      Math.fround(-6.727404335356611e-17),
      1,
      2,
    ]);
    expect(counts.readSchema.parse(null)).toBeNull();
    for (const input of ['[1,2]', '[1,2,3,4]', null, '{"a":1}'])
      expect(() => values.readSchema.parse(input)).toThrow();
    expect(() => counts.readSchema.parse('[1.5,2]')).toThrow();
    expect(() => values.readSchema.parse('[1,2]')).toThrow('Value does not fit VECTOR(FLOAT, 3).');
    expect(values.constraints).toEqual({ dimension: 3 });
    expect([values.dataType, values.wireType]).toEqual(['vector', 'variant']);
  });

  it('casts JSON writes to the exact VECTOR type and validates elements', () => {
    const rows = insert(embeddings, [
      { id: 1n, values: [0.1, 2, 3] },
      { id: 2n, values: [1, 2, 3], counts: [1, -2] },
    ]).compile();
    expect(rows.sql).toBe(
      'INSERT INTO "EMBEDDINGS" ("ID", "VALS", "COUNTS") ' +
        'SELECT ?, CAST(PARSE_JSON(?) AS VECTOR(FLOAT, 3)), CAST(PARSE_JSON(?) AS VECTOR(INT, 2)) ' +
        'UNION ALL SELECT ?, CAST(PARSE_JSON(?) AS VECTOR(FLOAT, 3)), CAST(PARSE_JSON(?) AS VECTOR(INT, 2))',
    );
    expect(rows.binds).toEqual(['1', '[0.1,2,3]', null, '2', '[1,2,3]', '[1,-2]']);
    expect(
      select(embeddings)
        .where(eq(values, [1, 2, 3]))
        .compile(),
    ).toMatchObject({
      sql: expect.stringContaining('("VALS" = CAST(PARSE_JSON(?) AS VECTOR(FLOAT, 3)))'),
      binds: ['[1,2,3]'],
    });
    for (const row of [
      { id: 1n, values: [1, 2] },
      { id: 1n, values: [1, 2, 3], counts: [1, 2, 3] },
    ])
      expect(() => insert(embeddings, row)).toThrow('does not fit VECTOR');
    for (const row of [
      { id: 1n, values: [3.5e38, 0, 0] },
      { id: 1n, values: [Number.POSITIVE_INFINITY, 0, 0] },
      { id: 1n, values: [1, 2, 3], counts: [1.5, 2] },
      { id: 1n, values: [1, 2, 3], counts: [2147483648, 0] },
    ])
      expect(() => insert(embeddings, row)).toThrow(z.ZodError);
    expect(() => insert(embeddings, { id: 1n, values: [3.4e38, -3.4e38, 1e-50] })).not.toThrow();
  });

  it('rejects invalid declarations', () => {
    for (const dimension of [0, 4097, 1.5])
      expect(() => vector('V', 'float', dimension)).toThrow(
        'Dimension must be an integer from 1 to 4096.',
      );
    expect(() => vector('V', 'double' as 'float', 2)).toThrow(
      "VECTOR elements must be 'int' or 'float'.",
    );
    expect(vector('V', 'int', 4096).constraints).toEqual({ dimension: 4096 });
  });
});
