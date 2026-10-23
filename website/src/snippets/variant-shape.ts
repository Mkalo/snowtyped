import { integer, snowflakeTable, variant } from 'snowtyped';
import * as z from 'zod';

export const events = snowflakeTable('EVENTS', {
  id: integer('ID').notNull(),
  payload: variant('PAYLOAD', z.object({ items: z.array(z.number()) })),
});
// events.columns.payload reads and writes { items: number[] } | null
