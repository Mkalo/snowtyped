import { integer, snowflakeTable, text } from 'snowtyped';

export const customers = snowflakeTable(
  'CUSTOMERS',
  {
    id: integer('ID').notNull(),
    name: text('NAME').notNull(),
    email: text('EMAIL'),
  },
  { database: 'APP_DB', schema: 'PUBLIC' },
);
