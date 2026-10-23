import {
  binary,
  boolean,
  date,
  decimal,
  float,
  type InferSelection,
  integer,
  snowflakeTable,
  text,
  time,
  timestamp,
  variant,
} from 'snowtyped';
import { expectTypeOf } from 'vitest';

// ---cut---

const samples = snowflakeTable('SAMPLES', {
  name: text('NAME').notNull(),
  id: integer('ID').notNull(),
  balance: decimal('BALANCE').notNull(),
  ratio: float('RATIO').notNull(),
  active: boolean('ACTIVE').notNull(),
  day: date('DAY').notNull(),
  clock: time('CLOCK').notNull(),
  at: timestamp('AT', 'tz').notNull(),
  data: binary('DATA').notNull(),
  payload: variant('PAYLOAD'),
});

expectTypeOf<InferSelection<typeof samples.columns>>().toEqualTypeOf<{
  readonly name: string;
  readonly id: bigint;
  readonly balance: string;
  readonly ratio: number;
  readonly active: boolean;
  readonly day: string;
  readonly clock: string;
  readonly at: string;
  readonly data: Uint8Array;
  readonly payload: unknown;
}>();
