// Checked by tsc, not executed.
import {
  deleteUsing,
  eq,
  insertFrom,
  integer,
  mergeInto,
  select,
  snowflakeTable,
  text,
  updateFrom,
} from '../../src/index.js';

const target = snowflakeTable('TARGET', { id: integer('ID').notNull(), label: text('LABEL') });
const source = snowflakeTable('SOURCE', {
  id: integer('ID').notNull(),
  label: text('LABEL'),
  name: text('NAME').notNull(),
});
const other = snowflakeTable('OTHER', { id: integer('ID') });

insertFrom(target, select(source, { id: source.columns.id, label: source.columns.name }));
insertFrom(target, select(source, { id: source.columns.id }));
// @ts-expect-error Required target columns must be selected.
insertFrom(target, select(source, { label: source.columns.label }));
// @ts-expect-error Selected names must be target columns.
insertFrom(target, select(source, { id: source.columns.id, name: source.columns.name }));
// @ts-expect-error Selected values must match the target column domain.
insertFrom(target, select(source, { id: source.columns.name }));
// @ts-expect-error Nullable source values cannot fill required target columns.
insertFrom(target, select(other, { id: other.columns.id }));
const outer = select(source)
  .rightJoin(other, eq(source.columns.id, other.columns.id))
  .select({ id: source.columns.id });
// @ts-expect-error Outer-joined sources become nullable.
insertFrom(target, outer);

updateFrom(target, source, { label: source.columns.label }).where(
  eq(target.columns.id, source.columns.id),
);
// @ts-expect-error Update values must come from the target or source scope.
updateFrom(target, source, { id: other.columns.id });
// @ts-expect-error Update values must match the target column domain.
updateFrom(target, source, { id: source.columns.name });
// @ts-expect-error Filters cannot reference tables outside the mutation scope.
deleteUsing(target, source).where(eq(other.columns.id, 1n));
deleteUsing(target, source).where(eq(target.columns.id, source.columns.id));

const merge = mergeInto(target, source, eq(target.columns.id, source.columns.id));
merge
  .whenMatchedUpdate({ label: source.columns.label }, eq(target.columns.label, 'old'))
  .whenMatchedDelete(eq(source.columns.name, 'gone'))
  .whenNotMatchedInsert({ id: source.columns.id }, eq(source.columns.name, 'new'));
// @ts-expect-error NOT MATCHED values cannot reference the target.
merge.whenNotMatchedInsert({ id: target.columns.id });
// @ts-expect-error NOT MATCHED conditions cannot reference the target.
merge.whenNotMatchedInsert({ id: 1n }, eq(target.columns.label, 'x'));
// @ts-expect-error MATCHED conditions cannot reference unrelated tables.
merge.whenMatchedDelete(eq(other.columns.id, 1n));
