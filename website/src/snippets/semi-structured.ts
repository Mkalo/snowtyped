import { array, integer, object, snowflakeTable } from 'snowtyped';
import * as z from 'zod';

export const documents = snowflakeTable('DOCUMENTS', {
  id: integer('ID').notNull(),
  tags: array('TAGS', z.string()).notNull(),
  meta: object('META', z.object({ ok: z.boolean() })),
  extra: object('EXTRA'),
});
// tags reads and writes string[]; meta { ok: boolean } | null; extra Record<string, unknown> | null
