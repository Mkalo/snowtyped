import type { Connection } from 'snowflake-sdk';
import { decimal, float, integer, snowflakeTable, text, timestamp, variant } from 'snowtyped';
import { createClient } from 'snowtyped/snowflake';

export { customers } from './schema.js';

declare const connection: Connection;
export const db = createClient(connection);

export const orders = snowflakeTable('ORDERS', {
  id: integer('ID').notNull(),
  customerId: integer('CUSTOMER_ID').notNull(),
  amount: decimal('AMOUNT').notNull(),
});
export const events = snowflakeTable('EVENTS', {
  id: integer('ID').notNull(),
  payload: variant('PAYLOAD'),
});
export const trades = snowflakeTable('TRADES', {
  id: integer('ID').notNull(),
  at: timestamp('AT').notNull(),
});
export const quotes = snowflakeTable('QUOTES', {
  at: timestamp('AT').notNull(),
  price: float('PRICE').notNull(),
});
export const target = snowflakeTable('CUSTOMERS', {
  id: integer('ID').notNull(),
  name: text('NAME').notNull(),
});
export const employees = snowflakeTable('EMPLOYEES', {
  id: integer('ID').notNull(),
  managerId: integer('MANAGER_ID'),
  name: text('NAME').notNull(),
});
export const staged = snowflakeTable('STAGED_CUSTOMERS', {
  id: integer('ID').notNull(),
  name: text('NAME').notNull(),
});
export const sales = snowflakeTable('SALES', {
  region: text('REGION'),
  quarter: text('QUARTER').notNull(),
  amount: decimal('AMOUNT'),
});
export const budgets = snowflakeTable('BUDGETS', {
  id: integer('ID').notNull(),
  jan: decimal('JAN').notNull(),
  feb: decimal('FEB'),
});
