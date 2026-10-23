import { geography, geometry, integer, snowflakeTable, vector } from 'snowtyped';

export const places = snowflakeTable('PLACES', {
  id: integer('ID').notNull(),
  location: geography('LOCATION').notNull(),
  shape: geometry('SHAPE', { srid: 4326 }),
  embedding: vector('EMBEDDING', 'float', 3),
});
// location reads and writes GeoJsonGeometry; embedding number[] | null
