import { integer, snowflakeTable, structured, structuredType as t } from 'snowtyped';

export const customers = snowflakeTable('CUSTOMERS', {
  id: integer('ID').notNull(),
  scores: structured('SCORES', t.array(t.integer().notNull())).notNull(),
  address: structured('ADDRESS', t.object({ city: t.text(), zip: t.integer({ precision: 5 }) })),
  prices: structured(
    'PRICES',
    t.map(t.text({ length: 3 }), t.decimal({ precision: 10, scale: 2 })),
  ),
});
// scores reads and writes bigint[]; address { city: string | null; zip: bigint | null } | null;
// prices Map<string, string | null> | null
