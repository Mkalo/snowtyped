/** Syntax nodes are independent of driver and runtime-validation implementations. */
export interface IdentifierNode {
  readonly kind: 'identifier';
  readonly parts: readonly string[];
}
export type BindValue = string | number | boolean | null;
export type WireType =
  | 'integer'
  | 'decimal'
  | 'float'
  | 'date'
  | 'time'
  | 'timestamp_ntz'
  | 'timestamp_ltz'
  | 'timestamp_tz'
  | 'variant';
export interface SourceReference {
  readonly id: symbol;
  readonly name: string;
  readonly qualifier: IdentifierNode;
}
export interface ReferenceNode {
  readonly kind: 'reference';
  readonly source: SourceReference;
  readonly column: IdentifierNode;
}
export interface ParameterNode {
  readonly kind: 'parameter';
  readonly value: BindValue;
}
export interface BinaryNode {
  readonly kind: 'binary';
  readonly operator: '=' | '<>' | '>' | '>=' | '<' | '<=' | 'LIKE' | 'ILIKE';
  readonly left: ExpressionNode;
  readonly right: ExpressionNode;
}
export interface LogicalNode {
  readonly kind: 'logical';
  readonly operator: 'AND' | 'OR';
  readonly operands: readonly ExpressionNode[];
}
export interface UnaryNode {
  readonly kind: 'unary';
  readonly operator: 'NOT' | 'IS NULL' | 'IS NOT NULL';
  readonly operand: ExpressionNode;
}
export interface FunctionNode {
  readonly kind: 'function';
  readonly name: string;
  readonly args: readonly ExpressionNode[];
  readonly distinct?: boolean;
  /** Aggregate and window functions are the only valid operands of OVER. */
  readonly role?: 'aggregate' | 'window';
}
export interface InNode {
  readonly kind: 'in';
  readonly operand: ExpressionNode;
  readonly values: readonly ExpressionNode[];
  readonly negate: boolean;
}
export interface WindowNode {
  readonly kind: 'window';
  readonly value: FunctionNode;
  readonly partitionBy: readonly ExpressionNode[];
  readonly orderBy: readonly OrderNode[];
}
export interface JsonPathNode {
  readonly kind: 'json-path';
  readonly value: ExpressionNode;
  readonly path: readonly (string | number)[];
}
export interface CastNode {
  readonly kind: 'cast';
  readonly value: ExpressionNode;
  readonly target:
    | 'VARCHAR'
    | 'NUMBER(38,0)'
    | 'DOUBLE'
    | 'BOOLEAN'
    | 'DATE'
    | 'TIME'
    | 'TIMESTAMP_NTZ'
    | 'TIMESTAMP_LTZ'
    | 'TIMESTAMP_TZ';
}
export type ExpressionNode =
  | IdentifierNode
  | ReferenceNode
  | ParameterNode
  | BinaryNode
  | LogicalNode
  | UnaryNode
  | FunctionNode
  | InNode
  | WindowNode
  | JsonPathNode
  | CastNode;
export interface EqualityNode {
  readonly kind: 'equality';
  readonly column: IdentifierNode;
  readonly value: BindValue;
}
export interface OrderNode {
  readonly expression: ExpressionNode;
  readonly direction: 'ASC' | 'DESC';
  readonly nulls?: 'FIRST' | 'LAST';
}
export interface TemporalNode {
  readonly mode: 'AT' | 'BEFORE';
  readonly selector: 'TIMESTAMP' | 'OFFSET' | 'STATEMENT';
  readonly value: BindValue;
}
export interface TableNode {
  readonly kind: 'table';
  readonly name: IdentifierNode;
  readonly alias?: IdentifierNode;
  readonly temporal?: TemporalNode;
}
export interface DerivedNode {
  readonly kind: 'derived';
  readonly query: SelectNode;
  readonly alias: IdentifierNode;
}
export interface FlattenNode {
  readonly kind: 'flatten';
  readonly input: ExpressionNode;
  readonly alias: IdentifierNode;
  readonly path: string;
  readonly outer: boolean;
  readonly recursive: boolean;
  readonly mode: 'OBJECT' | 'ARRAY' | 'BOTH';
}
export interface CteNode {
  readonly kind: 'cte';
  readonly name: IdentifierNode;
  readonly query: SelectNode;
}
export type RelationNode = IdentifierNode | TableNode | DerivedNode | FlattenNode | CteNode;
export interface JoinNode {
  readonly kind: 'INNER' | 'LEFT' | 'RIGHT' | 'FULL' | 'CROSS' | 'ASOF' | 'LATERAL';
  readonly source: RelationNode;
  readonly on?: ExpressionNode;
  readonly match?: ExpressionNode;
}
export interface SelectNode {
  readonly kind: 'select';
  readonly from: RelationNode;
  readonly projections: readonly {
    readonly column: ExpressionNode;
    readonly alias: string;
    readonly wireType?: WireType;
  }[];
  readonly where?: ExpressionNode | EqualityNode;
  readonly joins?: readonly JoinNode[];
  readonly distinct?: boolean;
  readonly groupBy?: readonly ExpressionNode[];
  readonly having?: ExpressionNode;
  readonly qualify?: ExpressionNode;
  readonly orderBy?: readonly OrderNode[];
  readonly limit?: number;
  readonly offset?: number;
  readonly with?: readonly CteNode[];
}
export interface InsertNode {
  readonly kind: 'insert';
  readonly table: IdentifierNode;
  readonly columns: readonly IdentifierNode[];
  readonly rows: readonly (readonly ExpressionNode[])[];
}
export interface UpdateNode {
  readonly kind: 'update';
  readonly table: IdentifierNode;
  readonly assignments: readonly {
    readonly column: IdentifierNode;
    readonly value: ExpressionNode;
  }[];
  readonly where?: ExpressionNode;
}
export interface DeleteNode {
  readonly kind: 'delete';
  readonly table: IdentifierNode;
  readonly where?: ExpressionNode;
}
export interface MergeNode {
  readonly kind: 'merge';
  readonly target: TableNode;
  readonly source: RelationNode;
  readonly on: ExpressionNode;
  readonly matched?: readonly { readonly column: IdentifierNode; readonly value: ExpressionNode }[];
  readonly insert?: {
    readonly columns: readonly IdentifierNode[];
    readonly values: readonly ExpressionNode[];
  };
  readonly deleteMatched?: boolean;
}
export type StatementNode = SelectNode | InsertNode | UpdateNode | DeleteNode | MergeNode;
export interface CompiledQuery {
  readonly sql: string;
  readonly binds: readonly BindValue[];
}

export function identifier(...parts: [string, ...string[]]): IdentifierNode {
  if (
    parts.length === 0 ||
    parts.some((part) => !part || part.includes('\0') || [...part].length > 255)
  ) {
    throw new TypeError(
      'Identifiers need non-empty components of at most 255 characters without NUL.',
    );
  }
  return Object.freeze({ kind: 'identifier', parts: Object.freeze([...parts]) });
}
export function quoteIdentifier(node: IdentifierNode): string {
  return node.parts.map((part) => `"${part.replaceAll('"', '""')}"`).join('.');
}

/** A new context per statement prevents binds leaking across reusable queries. */
export function compileAst(statement: StatementNode): CompiledQuery {
  const binds: BindValue[] = [];
  function parameter(value: BindValue): string {
    binds.push(value);
    return '?';
  }
  function expression(node: ExpressionNode, qualify = false): string {
    switch (node.kind) {
      case 'identifier':
        return quoteIdentifier(node);
      case 'reference':
        return `${qualify ? `${quoteIdentifier(node.source.qualifier)}.` : ''}${quoteIdentifier(node.column)}`;
      case 'parameter':
        return parameter(node.value);
      case 'binary':
        return `(${expression(node.left, qualify)} ${node.operator} ${expression(node.right, qualify)})`;
      case 'logical':
        return `(${node.operands.map((item) => expression(item, qualify)).join(` ${node.operator} `)})`;
      case 'unary':
        return node.operator === 'NOT'
          ? `(NOT ${expression(node.operand, qualify)})`
          : `(${expression(node.operand, qualify)} ${node.operator})`;
      case 'function':
        return `${node.name}(${node.distinct ? 'DISTINCT ' : ''}${node.args.length ? node.args.map((arg) => expression(arg, qualify)).join(', ') : node.name === 'COUNT' ? '*' : ''})`;
      case 'in':
        return node.values.length === 0
          ? node.negate
            ? 'TRUE'
            : 'FALSE'
          : `(${expression(node.operand, qualify)} ${node.negate ? 'NOT IN' : 'IN'} (${node.values.map((value) => expression(value, qualify)).join(', ')}))`;
      case 'window':
        return `${expression(node.value, qualify)} OVER (${[
          node.partitionBy.length
            ? `PARTITION BY ${node.partitionBy.map((value) => expression(value, qualify)).join(', ')}`
            : '',
          node.orderBy.length
            ? `ORDER BY ${node.orderBy.map((value) => order(value, qualify)).join(', ')}`
            : '',
        ]
          .filter(Boolean)
          .join(' ')})`;
      case 'json-path':
        return node.path.reduce<string>(
          (value, part) => `GET(${value}, ${parameter(part)})`,
          expression(node.value, qualify),
        );
      case 'cast':
        return `CAST(${expression(node.value, qualify)} AS ${node.target})`;
      default:
        throw new TypeError('Unsupported expression AST node.');
    }
  }
  function order(node: OrderNode, qualify: boolean): string {
    return `${expression(node.expression, qualify)} ${node.direction}${node.nulls ? ` NULLS ${node.nulls}` : ''}`;
  }
  function source(node: RelationNode): string {
    switch (node.kind) {
      case 'identifier':
        return quoteIdentifier(node);
      case 'table':
        return `${quoteIdentifier(node.name)}${node.temporal ? ` ${node.temporal.mode} (${node.temporal.selector} => ${parameter(node.temporal.value)})` : ''}${node.alias ? ` AS ${quoteIdentifier(node.alias)}` : ''}`;
      case 'derived':
        return `(${selectStatement(node.query)}) AS ${quoteIdentifier(node.alias)}`;
      case 'cte':
        return quoteIdentifier(node.name);
      case 'flatten':
        return `FLATTEN(INPUT => ${expression(node.input, true)}, PATH => ${parameter(node.path)}, OUTER => ${node.outer ? 'TRUE' : 'FALSE'}, RECURSIVE => ${node.recursive ? 'TRUE' : 'FALSE'}, MODE => '${node.mode}') AS ${quoteIdentifier(node.alias)}`;
      default:
        throw new TypeError('Unsupported relation AST node.');
    }
  }
  function wire(value: string, type?: WireType): string {
    if (!type) return value;
    if (type === 'variant') return `TO_JSON(${value})`;
    const formats: Partial<Record<WireType, string>> = {
      date: 'YYYY-MM-DD',
      time: 'HH24:MI:SS.FF9',
      timestamp_ntz: 'YYYY-MM-DD HH24:MI:SS.FF9',
      timestamp_ltz: 'YYYY-MM-DD HH24:MI:SS.FF9 TZH:TZM',
      timestamp_tz: 'YYYY-MM-DD HH24:MI:SS.FF9 TZH:TZM',
    };
    const format = formats[type];
    return `TO_VARCHAR(${value}${format ? `, '${format}'` : ''})`;
  }
  function selectStatement(node: SelectNode, wireOutput = false): string {
    if (wireOutput && node.projections.some((item) => item.wireType)) {
      // Serialize only after relational operations, preserving native numeric/temporal sort,
      // DISTINCT, grouping, and the SQL types of nested CTEs and subqueries.
      const extras: { column: ExpressionNode; alias: string }[] = [];
      const used = new Set(node.projections.map((item) => item.alias));
      const ordering = (node.orderBy ?? []).map((item, index) => {
        const projected = node.projections.find(
          (projection) => JSON.stringify(projection.column) === JSON.stringify(item.expression),
        );
        if (node.distinct && !projected)
          throw new TypeError('DISTINCT ORDER BY expressions must be projected.');
        let name = projected?.alias;
        if (!name) {
          name = `__sflib_order_${index}`;
          while (used.has(name)) name += '_';
          used.add(name);
          extras.push({ column: item.expression, alias: name });
        }
        return `${quoteIdentifier(identifier('__sflib_result', name))} ${item.direction}${item.nulls ? ` NULLS ${item.nulls}` : ''}`;
      });
      const native = selectStatement(
        { ...node, projections: [...node.projections, ...extras] },
        false,
      );
      const projected = node.projections
        .map(
          (item) =>
            `${wire(quoteIdentifier(identifier('__sflib_result', item.alias)), item.wireType)} AS ${quoteIdentifier(identifier(item.alias))}`,
        )
        .join(', ');
      return `SELECT ${projected} FROM (${native}) AS "__sflib_result"${ordering.length ? ` ORDER BY ${ordering.join(', ')}` : ''}`;
    }
    const qualified =
      Boolean(node.joins?.length) || node.from.kind === 'derived' || node.from.kind === 'cte';
    let text = '';
    if (node.with?.length)
      text += `WITH ${node.with.map((cte) => `${quoteIdentifier(cte.name)} AS (${selectStatement(cte.query)})`).join(', ')} `;
    text += `SELECT ${node.distinct ? 'DISTINCT ' : ''}${node.projections.map(({ column, alias, wireType }) => `${wire(expression(column, qualified), wireOutput ? wireType : undefined)} AS ${quoteIdentifier(identifier(alias))}`).join(', ')} FROM ${source(node.from)}`;
    for (const join of node.joins ?? []) {
      text +=
        join.kind === 'LATERAL'
          ? `, LATERAL ${source(join.source)}`
          : ` ${join.kind} JOIN ${source(join.source)}`;
      if (join.match) text += ` MATCH_CONDITION ${expression(join.match, true)}`;
      if (join.on) text += ` ON ${expression(join.on, true)}`;
    }
    if (node.where)
      text += ` WHERE ${node.where.kind === 'equality' ? `${quoteIdentifier(node.where.column)} ${node.where.value === null ? 'IS NULL' : `= ${parameter(node.where.value)}`}` : expression(node.where, qualified)}`;
    if (node.groupBy?.length)
      text += ` GROUP BY ${node.groupBy.map((value) => expression(value, qualified)).join(', ')}`;
    if (node.having) text += ` HAVING ${expression(node.having, qualified)}`;
    if (node.qualify) text += ` QUALIFY ${expression(node.qualify, qualified)}`;
    if (node.orderBy?.length)
      text += ` ORDER BY ${node.orderBy.map((value) => order(value, qualified)).join(', ')}`;
    if (node.limit !== undefined) text += ` LIMIT ${node.limit}`;
    if (node.offset !== undefined) text += ` OFFSET ${node.offset}`;
    return text;
  }
  function assignments(
    values: readonly { readonly column: IdentifierNode; readonly value: ExpressionNode }[],
    qualified: boolean,
  ): string {
    return values
      .map(({ column, value }) => `${quoteIdentifier(column)} = ${expression(value, qualified)}`)
      .join(', ');
  }
  let sql: string;
  switch (statement.kind) {
    case 'select':
      sql = selectStatement(statement, true);
      break;
    case 'insert':
      sql = `INSERT INTO ${quoteIdentifier(statement.table)} (${statement.columns.map(quoteIdentifier).join(', ')}) ${statement.rows.map((row) => `SELECT ${row.map((value) => expression(value)).join(', ')}`).join(' UNION ALL ')}`;
      break;
    case 'update':
      sql = `UPDATE ${quoteIdentifier(statement.table)} SET ${assignments(statement.assignments, false)}${statement.where ? ` WHERE ${expression(statement.where)}` : ''}`;
      break;
    case 'delete':
      sql = `DELETE FROM ${quoteIdentifier(statement.table)}${statement.where ? ` WHERE ${expression(statement.where)}` : ''}`;
      break;
    case 'merge':
      sql = `MERGE INTO ${source(statement.target)} USING ${source(statement.source)} ON ${expression(statement.on, true)}`;
      if (statement.deleteMatched) sql += ' WHEN MATCHED THEN DELETE';
      if (statement.matched)
        sql += ` WHEN MATCHED THEN UPDATE SET ${assignments(statement.matched, true)}`;
      if (statement.insert)
        sql += ` WHEN NOT MATCHED THEN INSERT (${statement.insert.columns.map(quoteIdentifier).join(', ')}) VALUES (${statement.insert.values.map((value) => expression(value, true)).join(', ')})`;
      break;
    default:
      throw new TypeError('Unsupported statement AST node.');
  }
  return Object.freeze({ sql, binds: Object.freeze(binds) });
}
