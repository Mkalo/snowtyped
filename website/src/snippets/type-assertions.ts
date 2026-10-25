import { type InferRow, select } from 'snowtyped';
import { expectTypeOf } from 'vitest';
import { customers } from './schema.js';

const query = select(customers, { id: customers.columns.id, email: customers.columns.email });

expectTypeOf<InferRow<typeof query>>().toEqualTypeOf<{
  readonly id: bigint;
  readonly email: string | null;
}>();
