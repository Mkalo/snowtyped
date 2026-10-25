import type { ColumnConstraints, DataType } from '../schema.js';

/** A physical Snowflake column type, built with {@link sqlType}. */
export type PhysicalType =
  | {
      readonly kind: 'NUMBER';
      readonly precision: number;
      readonly scale: number;
    }
  | { readonly kind: 'VARCHAR' | 'BINARY'; readonly length?: number }
  | {
      readonly kind: 'TIME' | 'TIMESTAMP_NTZ' | 'TIMESTAMP_LTZ' | 'TIMESTAMP_TZ';
      readonly precision: number;
    }
  | {
      readonly kind: 'VECTOR';
      readonly element: 'INT' | 'FLOAT';
      readonly dimension: number;
    }
  | { readonly kind: 'STRUCTURED'; readonly sql: string }
  | { readonly kind: PlainKind };
type PlainKind =
  | 'FLOAT'
  | 'BOOLEAN'
  | 'DATE'
  | 'VARIANT'
  | 'ARRAY'
  | 'OBJECT'
  | 'GEOGRAPHY'
  | 'GEOMETRY';
/** A type read from Snowflake that `snowtyped/ddl` does not model, kept by its metadata name. */
export interface UnmodeledType {
  /** Identifies an unmodeled type. */
  readonly kind: 'OTHER';
  /** The type's name as Snowflake reports it. */
  readonly name: string;
}
/** A column type as read from Snowflake. */
export type ObservedType = PhysicalType | UnmodeledType;

function checked(value: number, min: number, max: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new RangeError(`${label} must be an integer from ${min} to ${max}.`);
  return value;
}
function sized(kind: 'VARCHAR' | 'BINARY', length: number | undefined, max: number): PhysicalType {
  return Object.freeze(
    length === undefined ? { kind } : { kind, length: checked(length, 1, max, `${kind} length`) },
  );
}
function fractional(
  kind: 'TIME' | 'TIMESTAMP_NTZ' | 'TIMESTAMP_LTZ' | 'TIMESTAMP_TZ',
  precision: number,
): PhysicalType {
  return Object.freeze({
    kind,
    precision: checked(precision, 0, 9, `${kind} precision`),
  });
}
const plain = (kind: PlainKind) => () => Object.freeze({ kind }) as PhysicalType;

/**
 * Builders for physical Snowflake column types, used by {@link defineTable} overrides and
 * `alterTable`. VARCHAR and BINARY without a length use the server default.
 *
 * @throws `RangeError` when a precision, scale, length, or dimension is out of range.
 * @example
 * ```ts
 * defineTable(customers, { types: { name: sqlType.varchar(200) } });
 * ```
 */
export const sqlType = /* @__PURE__ */ Object.freeze({
  /** `NUMBER(precision, scale)`, by default `NUMBER(38, 0)`. */
  number(precision = 38, scale = 0): PhysicalType {
    checked(precision, 1, 38, 'NUMBER precision');
    return Object.freeze({
      kind: 'NUMBER',
      precision,
      scale: checked(scale, 0, Math.min(precision, 37), 'NUMBER scale'),
    });
  },
  /** `VARCHAR`, or `VARCHAR(length)`. */
  varchar: (length?: number) => sized('VARCHAR', length, 134_217_728),
  /** `BINARY`, or `BINARY(length)` in bytes. */
  binary: (length?: number) => sized('BINARY', length, 67_108_864),
  /** `TIME(precision)`, by default `TIME(9)`. */
  time: (precision = 9) => fractional('TIME', precision),
  /**
   * `TIMESTAMP_NTZ`, `TIMESTAMP_LTZ`, or `TIMESTAMP_TZ` with a fractional seconds precision, by
   * default 9.
   */
  timestamp: (mode: 'ntz' | 'ltz' | 'tz' = 'ntz', precision = 9) =>
    fractional(`TIMESTAMP_${mode.toUpperCase() as 'NTZ' | 'LTZ' | 'TZ'}`, precision),
  /** `FLOAT`. */
  float: plain('FLOAT'),
  /** `BOOLEAN`. */
  boolean: plain('BOOLEAN'),
  /** `DATE`. */
  date: plain('DATE'),
  /** `VARIANT`. */
  variant: plain('VARIANT'),
  /** A semi-structured `ARRAY`. */
  array: plain('ARRAY'),
  /** A semi-structured `OBJECT`. */
  object: plain('OBJECT'),
  /** `GEOGRAPHY`. */
  geography: plain('GEOGRAPHY'),
  /** `GEOMETRY`. */
  geometry: plain('GEOMETRY'),
  /** `VECTOR(INT | FLOAT, dimension)`, with a dimension from 1 to 4096. */
  vector(element: 'int' | 'float', dimension: number): PhysicalType {
    if (element !== 'int' && element !== 'float')
      throw new RangeError("VECTOR elements must be 'int' or 'float'.");
    return Object.freeze({
      kind: 'VECTOR',
      element: element === 'int' ? 'INT' : 'FLOAT',
      dimension: checked(dimension, 1, 4096, 'VECTOR dimension'),
    });
  },
});

export function renderType(type: PhysicalType): string {
  switch (type.kind) {
    case 'NUMBER':
      return `NUMBER(${type.precision}, ${type.scale})`;
    case 'VARCHAR':
    case 'BINARY':
      return type.length === undefined ? type.kind : `${type.kind}(${type.length})`;
    case 'TIME':
    case 'TIMESTAMP_NTZ':
    case 'TIMESTAMP_LTZ':
    case 'TIMESTAMP_TZ':
      return `${type.kind}(${type.precision})`;
    case 'VECTOR':
      return `VECTOR(${type.element}, ${type.dimension})`;
    case 'STRUCTURED':
      return type.sql;
    default:
      return type.kind;
  }
}

const compatible: Record<DataType, readonly PhysicalType['kind'][]> = {
  text: ['VARCHAR'],
  integer: ['NUMBER'],
  decimal: ['NUMBER'],
  boolean: ['BOOLEAN'],
  float: ['FLOAT'],
  date: ['DATE'],
  time: ['TIME'],
  timestamp_ntz: ['TIMESTAMP_NTZ'],
  timestamp_ltz: ['TIMESTAMP_LTZ'],
  timestamp_tz: ['TIMESTAMP_TZ'],
  variant: ['VARIANT', 'ARRAY', 'OBJECT'],
  array: ['ARRAY'],
  object: ['OBJECT'],
  binary: ['BINARY'],
  geography: ['GEOGRAPHY'],
  geometry: ['GEOMETRY'],
  vector: ['VECTOR'],
  structured: ['STRUCTURED'],
};

/** The type a column's declared size constraints imply. GEOMETRY SRIDs are checked per value. */
function declaredType(
  dataType: DataType,
  constraints: ColumnConstraints,
): PhysicalType | undefined {
  const { length, precision, scale, dimension, element, structure } = constraints;
  switch (dataType) {
    case 'text':
      return length === undefined ? undefined : sqlType.varchar(length);
    case 'binary':
      return length === undefined ? undefined : sqlType.binary(length);
    case 'integer':
    case 'decimal':
      return precision === undefined ? undefined : sqlType.number(precision, scale ?? 0);
    case 'time':
      return precision === undefined ? undefined : sqlType.time(precision);
    case 'timestamp_ntz':
    case 'timestamp_ltz':
    case 'timestamp_tz':
      return precision === undefined
        ? undefined
        : sqlType.timestamp(dataType.slice(10) as 'ntz' | 'ltz' | 'tz', precision);
    case 'vector':
      return sqlType.vector(element as 'int' | 'float', dimension as number);
    case 'structured':
      if (structure === undefined)
        throw new TypeError('structured() columns need their structured type.');
      return Object.freeze({ kind: 'STRUCTURED', sql: structure });
    default:
      return undefined;
  }
}

/** The declared codec must be able to read and write the physical type. */
export function physicalType(
  dataType: DataType,
  constraints: ColumnConstraints,
  type: PhysicalType | undefined,
): PhysicalType {
  const declared = declaredType(dataType, constraints);
  if (!type) {
    if (declared) return declared;
    if (dataType === 'decimal')
      throw new TypeError(
        'decimal() columns need a declared precision or an explicit sqlType.number(precision, scale).',
      );
    const defaults: Partial<Record<DataType, PhysicalType>> = {
      text: sqlType.varchar(),
      integer: sqlType.number(),
      time: sqlType.time(),
      timestamp_ntz: sqlType.timestamp('ntz'),
      timestamp_ltz: sqlType.timestamp('ltz'),
      timestamp_tz: sqlType.timestamp('tz'),
      binary: sqlType.binary(),
    };
    return defaults[dataType] ?? Object.freeze({ kind: compatible[dataType][0] } as PhysicalType);
  }
  if (
    !compatible[dataType].includes(type.kind) ||
    (dataType === 'integer' && type.kind === 'NUMBER' && type.scale !== 0)
  )
    throw new TypeError(`A ${dataType} column cannot be stored as ${renderType(type)}.`);
  if (declared && renderType(declared) !== renderType(type))
    throw new TypeError(
      `${renderType(type)} conflicts with the column's declared ${renderType(declared)}.`,
    );
  return type;
}

/** Lengths INFORMATION_SCHEMA reports for a VARCHAR declared without one. */
export const defaultVarcharLengths = [16_777_216, 134_217_728];

const canonical = (structure: string) =>
  structure.replace(/VARCHAR\((?:16777216|134217728)\)/g, 'VARCHAR');

export function sameType(desired: PhysicalType, observed: ObservedType): boolean {
  if (observed.kind !== desired.kind) return false;
  switch (desired.kind) {
    case 'NUMBER':
      return (
        observed.kind === 'NUMBER' &&
        desired.precision === observed.precision &&
        desired.scale === observed.scale
      );
    case 'VARCHAR': {
      const length = (observed as { length?: number }).length;
      return desired.length === undefined
        ? length === undefined || defaultVarcharLengths.includes(length)
        : desired.length === length;
    }
    case 'BINARY': {
      // INFORMATION_SCHEMA does not report BINARY lengths, so an unknown length is not a difference.
      const length = (observed as { length?: number }).length;
      return desired.length === undefined || length === undefined || desired.length === length;
    }
    case 'TIME':
    case 'TIMESTAMP_NTZ':
    case 'TIMESTAMP_LTZ':
    case 'TIMESTAMP_TZ':
      return desired.precision === (observed as { precision: number }).precision;
    case 'VECTOR':
      return renderType(desired) === renderType(observed as PhysicalType);
    case 'STRUCTURED':
      return canonical(desired.sql) === canonical((observed as { sql: string }).sql);
    default:
      return true;
  }
}

/**
 * Snowflake can widen VARCHAR and change NUMBER precision in place; other changes need a rebuild.
 */
export function alterableType(observed: ObservedType, desired: PhysicalType): boolean {
  if (observed.kind === 'VARCHAR' && desired.kind === 'VARCHAR')
    return (desired.length ?? 16_777_216) > (observed.length ?? Number.POSITIVE_INFINITY);
  return (
    observed.kind === 'NUMBER' && desired.kind === 'NUMBER' && observed.scale === desired.scale
  );
}
