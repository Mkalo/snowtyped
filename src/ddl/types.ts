import type { DataType } from '../schema.js';

export type PhysicalType =
  | { readonly kind: 'NUMBER'; readonly precision: number; readonly scale: number }
  | { readonly kind: 'VARCHAR' | 'BINARY'; readonly length?: number }
  | {
      readonly kind: 'TIME' | 'TIMESTAMP_NTZ' | 'TIMESTAMP_LTZ' | 'TIMESTAMP_TZ';
      readonly precision: number;
    }
  | { readonly kind: 'FLOAT' | 'BOOLEAN' | 'DATE' | 'VARIANT' | 'ARRAY' | 'OBJECT' };
/** A type the DDL module cannot model, such as GEOGRAPHY or VECTOR, kept by its metadata name. */
export interface UnmodeledType {
  readonly kind: 'OTHER';
  readonly name: string;
}
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
  return Object.freeze({ kind, precision: checked(precision, 0, 9, `${kind} precision`) });
}
const plain = (kind: 'FLOAT' | 'BOOLEAN' | 'DATE' | 'VARIANT' | 'ARRAY' | 'OBJECT') => () =>
  Object.freeze({ kind }) as PhysicalType;

/** Physical Snowflake column types. VARCHAR and BINARY without a length use the server default. */
export const sqlType = /* @__PURE__ */ Object.freeze({
  number(precision = 38, scale = 0): PhysicalType {
    checked(precision, 1, 38, 'NUMBER precision');
    return Object.freeze({
      kind: 'NUMBER',
      precision,
      scale: checked(scale, 0, Math.min(precision, 37), 'NUMBER scale'),
    });
  },
  varchar: (length?: number) => sized('VARCHAR', length, 134_217_728),
  binary: (length?: number) => sized('BINARY', length, 67_108_864),
  time: (precision = 9) => fractional('TIME', precision),
  timestamp: (mode: 'ntz' | 'ltz' | 'tz' = 'ntz', precision = 9) =>
    fractional(`TIMESTAMP_${mode.toUpperCase() as 'NTZ' | 'LTZ' | 'TZ'}`, precision),
  float: plain('FLOAT'),
  boolean: plain('BOOLEAN'),
  date: plain('DATE'),
  variant: plain('VARIANT'),
  array: plain('ARRAY'),
  object: plain('OBJECT'),
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
  binary: ['BINARY'],
};

/** The declared codec must be able to read and write the physical type. */
export function physicalType(dataType: DataType, type: PhysicalType | undefined): PhysicalType {
  if (!type) {
    if (dataType === 'decimal')
      throw new TypeError('decimal() columns need an explicit sqlType.number(precision, scale).');
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
  return type;
}

/** Lengths INFORMATION_SCHEMA reports for a VARCHAR declared without one. */
const defaultVarcharLengths = [16_777_216, 134_217_728];

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
    default:
      return true;
  }
}

/** Snowflake can widen VARCHAR and change NUMBER precision in place; other changes need a rebuild. */
export function alterableType(observed: ObservedType, desired: PhysicalType): boolean {
  if (observed.kind === 'VARCHAR' && desired.kind === 'VARCHAR')
    return (desired.length ?? 16_777_216) > (observed.length ?? Number.POSITIVE_INFINITY);
  return (
    observed.kind === 'NUMBER' && desired.kind === 'NUMBER' && observed.scale === desired.scale
  );
}
