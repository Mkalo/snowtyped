import { binary, decimal, integer, snowflakeTable, text, time, timestamp } from 'snowtyped';

export const accounts = snowflakeTable('ACCOUNTS', {
  qty: integer('QTY', { precision: 9 }).notNull(),
  balance: decimal('BALANCE', { precision: 12, scale: 2 }).notNull(),
  code: text('CODE', { length: 3 }).notNull(),
  hash: binary('HASH', { length: 32 }),
  clock: time('CLOCK', { precision: 3 }),
  at: timestamp('AT', 'ltz', { precision: 6 }),
});
