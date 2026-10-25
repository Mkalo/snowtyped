import { type BindValue, type CompiledQuery, type IdentifierNode, identifier } from './ast.js';

/**
 * A value the `sql` tag binds as a parameter. `bigint` is bound as text and `Date` as an ISO
 * string.
 */
export type SqlParameter = string | number | bigint | boolean | null | Date;
/**
 * A value interpolated into the `sql` tag: a bound parameter, a nested fragment, or an identifier.
 */
export type SqlInterpolation = SqlParameter | RawQuery | IdentifierNode;

/**
 * A parameterized SQL fragment built by the {@link sql} tag.
 *
 * `T` describes the entire raw result. It is an assertion supplied by the caller, never validated
 * at runtime.
 */
export interface RawQuery<T = unknown> {
  /** Identifies a raw fragment. */
  readonly kind: 'raw';
  /** The template's literal text. */
  readonly strings: readonly string[];
  /** The interpolated values. */
  readonly values: readonly SqlInterpolation[];
  /** @internal */
  readonly resultType?: T;
  /** Compiles the fragment, with nested fragments inlined, to SQL text and bind values. */
  compile(): CompiledQuery;
}

export function isRawQuery(value: unknown): value is RawQuery {
  return typeof value === 'object' && value !== null && 'kind' in value && value.kind === 'raw';
}

function bind(value: SqlParameter): BindValue {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (
    typeof value === 'number' &&
    (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))
  ) {
    throw new TypeError(
      'SQL numbers must be finite and integers must be safe; use bigint or decimal text.',
    );
  }
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value))
    return value as BindValue;
  throw new TypeError(
    'Unsupported SQL interpolation. Use sql.identifier, sql.join, or sql.json explicitly.',
  );
}

function fragment<T>(strings: readonly string[], values: readonly SqlInterpolation[]): RawQuery<T> {
  if (strings.length !== values.length + 1) throw new TypeError('Invalid SQL template structure.');
  const segments = Object.freeze([...strings]);
  // Normalize scalar parameters now, so mutating a Date after construction cannot change a query.
  const parameters = Object.freeze(
    values.map((value) => {
      if (isRawQuery(value)) return value;
      if (
        typeof value === 'object' &&
        value !== null &&
        'kind' in value &&
        value.kind === 'identifier'
      ) {
        const parts = value.parts as [string, ...string[]];
        return identifier(...parts);
      }
      return bind(value as SqlParameter);
    }),
  );
  return Object.freeze({
    kind: 'raw',
    strings: segments,
    values: parameters,
    compile() {
      const binds: BindValue[] = [];
      let text = segments[0] as string;
      for (let index = 0; index < parameters.length; index++) {
        const value = parameters[index];
        if (isRawQuery(value)) {
          const nested = value.compile();
          text += nested.sql;
          binds.push(...nested.binds);
        } else if (typeof value === 'object' && value !== null) {
          text += value.parts.map((part) => `"${part.replaceAll('"', '""')}"`).join('.');
        } else {
          text += '?';
          binds.push(value as BindValue);
        }
        text += segments[index + 1];
      }
      return Object.freeze({ sql: text, binds: Object.freeze(binds) });
    },
  });
}

function tag<T = unknown>(
  strings: TemplateStringsArray,
  ...values: SqlInterpolation[]
): RawQuery<T> {
  if (!Array.isArray(strings) || !Object.hasOwn(strings, 'raw')) {
    throw new TypeError('Use sql as a template tag; use sql.unsafe for trusted SQL text.');
  }
  return fragment<T>(strings, values);
}

/**
 * Builds a parameterized SQL fragment from a template. Interpolated values become bind parameters,
 * never SQL text; nested fragments are inlined with their bindings in order. The optional type
 * argument asserts the entire result of running the fragment with `queryRaw`.
 *
 * Plain objects, arrays, `undefined`, non-finite numbers, and unsafe integers are rejected; use the
 * helpers, `bigint`, or decimal text instead.
 *
 * @throws `TypeError` when called as a function instead of a template tag, or for an unsupported
 * interpolation.
 * @example
 * ```ts
 * const minimum = 100n;
 * const byAmount = sql<Array<{ ID: string }>>`
 *   SELECT ID FROM ${sql.identifier('APP_DB', 'PUBLIC', 'ORDERS')} WHERE AMOUNT > ${minimum}
 * `;
 * const rows = await db.queryRaw(byAmount);
 * ```
 */
export const sql = /* @__PURE__ */ Object.assign(tag, {
  /** A quoted, optionally qualified identifier. */
  identifier: (...parts: [string, ...string[]]): RawQuery =>
    fragment(['', ''], [identifier(...parts)]),
  /** Inserts trusted SQL text verbatim. Never pass user input to it. */
  unsafe: (text: string): RawQuery => fragment([text], []),
  /**
   * Joins values with a separator fragment, `, ` by default.
   *
   * @example
   * ```ts
   * sql`SELECT * FROM ORDERS WHERE ID IN (${sql.join([1, 2, 3])})`;
   * ```
   */
  join(values: readonly SqlInterpolation[], separator: RawQuery = fragment([', '], [])): RawQuery {
    const parts: SqlInterpolation[] = [];
    values.forEach((value, index) => {
      if (index > 0) parts.push(separator);
      parts.push(value);
    });
    return fragment(
      Array.from({ length: parts.length + 1 }, () => ''),
      parts,
    );
  },
  /**
   * Binds a value as JSON text wrapped in `PARSE_JSON(...)`.
   *
   * @throws `TypeError` when the value cannot be encoded as JSON.
   */
  json(value: unknown): RawQuery {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new TypeError('Value cannot be encoded as JSON.');
    return fragment(['PARSE_JSON(', ')'], [encoded]);
  },
});
