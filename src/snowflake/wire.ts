import type { Column, RowStatement } from 'snowflake-sdk';

/** The SDK can represent SQL NULL as the literal 'NULL' for fetchAsString columns. */
export function normalizeWireRow(row: unknown, statement: RowStatement): unknown {
  const columns = statement.getColumns?.() ?? [];
  const normalize = (value: unknown, column?: Column) =>
    value === 'NULL' && column && !column.isString() && !column.isBinary() ? null : value;
  if (Array.isArray(row)) return row.map((value, index) => normalize(value, columns[index]));
  if (row !== null && typeof row === 'object') {
    return Object.fromEntries(
      Object.entries(row).map(([name, value]) => [
        name,
        normalize(
          value,
          columns.find((column) => column.getName() === name),
        ),
      ]),
    );
  }
  return row;
}
