import * as z from 'zod';

export type GeoPosition =
  | [number, number]
  | [number, number, number]
  | [number, number, number, number];
export type GeoJsonGeometry =
  | { type: 'Point'; coordinates: GeoPosition }
  | { type: 'MultiPoint'; coordinates: GeoPosition[] }
  | { type: 'LineString'; coordinates: GeoPosition[] }
  | { type: 'MultiLineString'; coordinates: GeoPosition[][] }
  | { type: 'Polygon'; coordinates: GeoPosition[][] }
  | { type: 'MultiPolygon'; coordinates: GeoPosition[][][] }
  | { type: 'GeometryCollection'; geometries: GeoJsonGeometry[] };

/** GeoJSON geometries with at most `dimensions` coordinates per position; extra members are rejected. */
export function geoJson(dimensions: 3 | 4): z.ZodType<GeoJsonGeometry, GeoJsonGeometry> {
  const n = z.number();
  const positions = [z.tuple([n, n]), z.tuple([n, n, n]), z.tuple([n, n, n, n])] as const;
  const position = z.union(positions.slice(0, dimensions - 1)) as z.ZodType<
    GeoPosition,
    GeoPosition
  >;
  const shape = <const T extends string, V>(type: T, coordinates: z.ZodType<V, V>) =>
    z.strictObject({ type: z.literal(type), coordinates });
  const geometry: z.ZodType<GeoJsonGeometry, GeoJsonGeometry> = z.discriminatedUnion('type', [
    shape('Point', position),
    shape('MultiPoint', z.array(position)),
    shape('LineString', z.array(position)),
    shape('MultiLineString', z.array(z.array(position))),
    shape('Polygon', z.array(z.array(position))),
    shape('MultiPolygon', z.array(z.array(z.array(position)))),
    z.strictObject({
      type: z.literal('GeometryCollection'),
      geometries: z.lazy(() => z.array(geometry)),
    }),
  ]);
  return geometry;
}

const kinds = [
  'Point',
  'LineString',
  'Polygon',
  'MultiPoint',
  'MultiLineString',
  'MultiPolygon',
  'GeometryCollection',
] as const;

/** Decodes Snowflake's EWKB output (ISO type codes, optional SRID flag) into GeoJSON. */
export function decodeEwkb(bytes: Uint8Array): { srid: number; geometry: GeoJsonGeometry } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  let little = true;
  const uint = () => {
    const value = view.getUint32(offset, little);
    offset += 4;
    return value;
  };
  const repeat = <T>(read: () => T) => Array.from({ length: uint() }, read);
  function geometry(): { srid: number; geometry: GeoJsonGeometry } {
    const order = view.getUint8(offset++);
    if (order > 1) throw new TypeError('Invalid WKB byte order.');
    little = order === 1;
    const code = uint();
    const srid = code & 0x20000000 ? uint() : 0;
    const base = code & 0x0fffffff;
    const variant = Math.floor(base / 1000);
    const kind = kinds[(base % 1000) - 1];
    if (code & 0xc0000000 || variant > 1 || !kind)
      throw new TypeError(`Unsupported WKB geometry type ${code}.`);
    const size = variant ? 3 : 2;
    const point = () =>
      Array.from({ length: size }, () => {
        const value = view.getFloat64(offset, little);
        offset += 8;
        return value;
      }) as GeoPosition;
    const ring = () => repeat(point);
    const member = () => geometry().geometry as { coordinates?: unknown };
    let value: unknown;
    if (kind === 'Point') value = { type: kind, coordinates: point() };
    else if (kind === 'LineString') value = { type: kind, coordinates: ring() };
    else if (kind === 'Polygon') value = { type: kind, coordinates: repeat(ring) };
    else if (kind === 'GeometryCollection')
      value = { type: kind, geometries: repeat(() => geometry().geometry) };
    else value = { type: kind, coordinates: repeat(() => member().coordinates) };
    return { srid, geometry: value as GeoJsonGeometry };
  }
  const result = geometry();
  if (offset !== bytes.byteLength) throw new TypeError('Trailing bytes after WKB geometry.');
  return result;
}
