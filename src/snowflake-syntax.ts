import { identifier } from './ast.js';
import type { AnyExpression } from './expressions.js';
import { bindTable, integer, snowflakeTable, text, variant } from './schema.js';

/** Options of {@link flatten}, matching the arguments of Snowflake's FLATTEN. */
export interface FlattenOptions {
  /** The path to the element to flatten within the input. Defaults to the input itself. */
  readonly path?: string;
  /** Also emits a row for inputs that are empty or cannot be expanded. */
  readonly outer?: boolean;
  /** Expands nested elements recursively. */
  readonly recursive?: boolean;
  /** Which kinds of values to flatten. Defaults to `'BOTH'`. */
  readonly mode?: 'OBJECT' | 'ARRAY' | 'BOTH';
}
/**
 * Creates a `LATERAL FLATTEN` table source over a VARIANT, ARRAY, or OBJECT value, with Snowflake's
 * fixed output columns: `seq`, `key`, `path`, `index`, `value`, and `this`.
 *
 * Join it with `.lateralJoin()`. The input can only reference sources that precede it in the query.
 *
 * @param input - The value to expand.
 * @param name - The source name of the output columns.
 * @example
 * ```ts
 * const items = flatten(events.columns.payload, 'ITEMS', { path: 'items' });
 * select(events)
 *   .lateralJoin(items)
 *   .select({ id: events.columns.id, item: items.columns.value });
 * ```
 */
export function flatten<const N extends string>(
  input: AnyExpression,
  name: N,
  options: FlattenOptions = {},
) {
  if (input.phase !== 'scalar') throw new TypeError('FLATTEN input must be a scalar expression.');
  const declaration = snowflakeTable(name, {
    seq: integer('SEQ').notNull(),
    key: text('KEY'),
    path: text('PATH').notNull(),
    index: integer('INDEX'),
    value: variant('VALUE'),
    this: variant('THIS'),
  });
  const source = Object.freeze({
    kind: 'flatten' as const,
    input: input.expression,
    alias: identifier(name),
    path: options.path ?? '',
    outer: options.outer ?? false,
    recursive: options.recursive ?? false,
    mode: options.mode ?? 'BOTH',
  });
  return bindTable(declaration.node, declaration.columns, source, name, input.refs);
}
