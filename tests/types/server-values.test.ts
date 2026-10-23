// Checked by tsc, not executed.
import { expectTypeOf } from 'vitest';
import {
  eq,
  type InsertValues,
  insert,
  integer,
  mergeInto,
  select,
  snowflakeTable,
  text,
  timestamp,
  type UpdateValues,
  update,
} from '../../src/index.js';
import type { SnowflakeClient } from '../../src/snowflake/index.js';

const events = snowflakeTable('EVENTS', {
  id: integer('ID').notNull().identity(),
  name: text('NAME').notNull(),
  status: text('STATUS').notNull().serverDefault("'new'"),
  created: timestamp('CREATED').serverDefault(),
  doubled: integer('DOUBLED').virtual('ID * 2'),
});
type Columns = typeof events.columns;
expectTypeOf<InsertValues<Columns>>().toEqualTypeOf<
  { name: string } & { id?: bigint; status?: string; created?: string | null }
>();
expectTypeOf<keyof UpdateValues<Columns>>().toEqualTypeOf<'id' | 'name' | 'status' | 'created'>();
expectTypeOf(events.columns.status.serverValue).toEqualTypeOf<{
  readonly kind: 'default';
  readonly expression?: string;
}>();
expectTypeOf(events.columns.name.serverValue).toEqualTypeOf<null>();

declare const db: SnowflakeClient;
expectTypeOf(db.execute(select(events)))
  .resolves.toHaveProperty('rows')
  .toEqualTypeOf<
    readonly {
      readonly id: bigint;
      readonly name: string;
      readonly status: string;
      readonly created: string | null;
      readonly doubled: bigint | null;
    }[]
  >();
insert(events, { name: 'Ada' });
insert(events, [{ name: 'Ada' }, { name: 'Grace', status: 'done', id: 7n, created: null }]);
update(events, { status: 'done' });
const staged = snowflakeTable('STAGED', { name: text('NAME').notNull() });
mergeInto(events, staged, eq(events.columns.name, staged.columns.name)).whenNotMatchedInsert({
  name: staged.columns.name,
});
// @ts-expect-error Columns without a server value stay required.
insert(events, { status: 'done' });
// @ts-expect-error A NOT NULL column with a server default still rejects explicit NULL.
insert(events, { name: 'Ada', status: null });
// @ts-expect-error Virtual columns cannot be inserted.
insert(events, { name: 'Ada', doubled: 1n });
// @ts-expect-error Virtual columns cannot be updated.
update(events, { doubled: 1n });
mergeInto(events, staged, eq(events.columns.name, staged.columns.name))
  // @ts-expect-error Virtual columns cannot be inserted by MERGE.
  .whenNotMatchedInsert({ name: staged.columns.name, doubled: 1n });
