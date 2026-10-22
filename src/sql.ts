import { type BindValue, type CompiledQuery, type IdentifierNode, identifier } from './ast.js';

export type SqlParameter = string | number | bigint | boolean | null | Date;
export type SqlInterpolation = SqlParameter | RawQuery | IdentifierNode;

/** T describes the entire raw result. It is a caller assertion, never runtime validation. */
export interface RawQuery<T = unknown> {
  readonly kind: 'raw';
  readonly strings: readonly string[];
  readonly values: readonly SqlInterpolation[];
  readonly resultType?: T;
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

export const sql = /* @__PURE__ */ Object.assign(tag, {
  identifier: (...parts: [string, ...string[]]): RawQuery =>
    fragment(['', ''], [identifier(...parts)]),
  /** Only for trusted static SQL. Never pass untrusted text here. */
  unsafe: (text: string): RawQuery => fragment([text], []),
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
  json(value: unknown): RawQuery {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new TypeError('Value cannot be encoded as JSON.');
    return fragment(['PARSE_JSON(', ')'], [encoded]);
  },
});
