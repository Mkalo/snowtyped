import { db } from './fixtures.js';
// ---cut---

import { insert, integer, snowflakeTable, text, timestamp } from 'snowtyped';

const tickets = snowflakeTable('TICKETS', {
  id: integer('ID').notNull().identity({ start: 1, increment: 1 }),
  title: text('TITLE').notNull(),
  status: text('STATUS').notNull().serverDefault("'open'"),
  createdAt: timestamp('CREATED_AT', 'ltz').notNull().serverDefault(),
  slug: text('SLUG').virtual('LOWER("TITLE")'),
});

await db.execute(insert(tickets, [{ title: 'Login fails' }, { title: 'Typo', status: 'closed' }]));
