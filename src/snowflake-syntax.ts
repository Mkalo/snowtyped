import { identifier } from './ast.js';
import type { AnyExpression } from './expressions.js';
import { bindTable, integer, snowflakeTable, text, variant } from './schema.js';

export interface FlattenOptions {
  readonly path?: string;
  readonly outer?: boolean;
  readonly recursive?: boolean;
  readonly mode?: 'OBJECT' | 'ARRAY' | 'BOTH';
}
/** A correlated table source with Snowflake's fixed FLATTEN output columns. */
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
