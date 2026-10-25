import { customers, orders } from './fixtures.js';
// ---cut---

import { eq, type InferInsert, type InferRow, type InferUpdate, select } from 'snowtyped';

const recentOrders = select(customers)
  .leftJoin(orders, eq(customers.columns.id, orders.columns.customerId))
  .select({ name: customers.columns.name, amount: orders.columns.amount });

type OrderRow = InferRow<typeof recentOrders>;
// { readonly name: string; readonly amount: string | null }
type Customer = InferRow<typeof customers>;
// { readonly id: bigint; readonly name: string; readonly email: string | null }
type NewCustomer = InferInsert<typeof customers>;
// { id: bigint; name: string; email?: string | null }
type CustomerPatch = InferUpdate<typeof customers>;
// { id?: bigint; name?: string; email?: string | null }
