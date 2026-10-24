import type { Column, RowStatement } from 'snowflake-sdk';

interface NullSentinels {
  readonly byIndex: readonly boolean[];
  readonly byName: ReadonlyMap<string, boolean>;
}
const sentinels = new WeakMap<RowStatement, NullSentinels>();
const carriesSentinel = (column: Column) => !column.isString() && !column.isBinary();

/** Which columns can carry the SDK's 'NULL' sentinel, computed once per statement. */
function nullSentinels(statement: RowStatement): NullSentinels {
  const cached = sentinels.get(statement);
  if (cached) return cached;
  const columns = statement.getColumns?.() ?? [];
  const computed = {
    byIndex: columns.map(carriesSentinel),
    // Like the SDK's object rows, the last of several same-named columns wins.
    byName: new Map(columns.map((column) => [column.getName(), carriesSentinel(column)])),
  };
  sentinels.set(statement, computed);
  return computed;
}

/** The SDK can represent SQL NULL as the literal 'NULL' for fetchAsString columns. */
export function normalizeWireRow(row: unknown, statement: RowStatement): unknown {
  if (Array.isArray(row)) {
    const { byIndex } = nullSentinels(statement);
    return row.map((value, index) => (value === 'NULL' && byIndex[index] ? null : value));
  }
  if (row !== null && typeof row === 'object') {
    const { byName } = nullSentinels(statement);
    const copy: Record<string, unknown> = { ...row };
    for (const name of Object.keys(copy))
      if (copy[name] === 'NULL' && byName.get(name)) copy[name] = null;
    return copy;
  }
  return row;
}
